/* eslint-disable max-lines */
import { env } from "cloudflare:workers";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { projects } from "@/db/schema";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import * as targetOps from "./rankTrackingTargetsService";
import { AppError } from "@/server/lib/errors";
import type {
  RankTrackingConfig,
  RankCheckTriggerResult,
} from "@/types/schemas/rank-tracking";
import {
  beginRankCheckRun,
  reconcileActiveRankCheckRun,
} from "./rankCheckRunGuards";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_KEYWORD_IDS,
} from "./scheduledRankChecks";
import {
  computeNextCheckAt,
  devicesCount,
  isScheduledRankTrackingInterval,
  MAX_KEYWORDS_PER_CONFIG,
  MAX_CONFIGS_PER_PROJECT,
  resolveEligibleNextCheckAt,
  type MissingRankingBucket,
  type MissingRankingsBreakdown,
} from "@/shared/rank-tracking";
import {
  getMissingRankingsSummary,
  resolveMissingRankingKeywordIds,
} from "./missingRankings";
import { refreshKeywordMetrics } from "./keywordMetrics";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatRankTrackingCost } from "./rankTrackingCost";
import { formatRankTrackingRun } from "./rankTrackingRun";

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

async function createConfig(input: {
  projectId: string;
  projectMarket: { locationCode: number; languageCode: string };
  domain: string;
  locationCode?: number;
  languageCode?: string;
  locationName?: string;
  devices?: RankTrackingConfig["devices"];
  serpDepth: number;
  scheduleInterval?: RankTrackingConfig["scheduleInterval"];
}) {
  const normalizedDomain = normalizeDomain(input.domain);

  const { locationCode, languageCode } = resolveMarket(
    input,
    input.projectMarket,
  );
  const scheduleInterval = input.scheduleInterval ?? "weekly";
  const nextCheckAt = isScheduledRankTrackingInterval(scheduleInterval)
    ? computeNextCheckAt(scheduleInterval)
    : null;

  const locationName = input.locationName ?? null;
  const existing =
    await RankTrackingRepository.getConfigByProjectDomainLocation(
      input.projectId,
      normalizedDomain,
      locationCode,
      locationName,
    );
  // The (project, domain, location) row still exists when a domain is
  // archived — archiving only flips isActive to false. So re-adding an
  // archived domain reactivates that row (keeping its keyword/ranking
  // history) with the freshly chosen settings, rather than colliding with
  // the unique index. An already-active row is a genuine duplicate.
  if (existing?.isActive) {
    throw new AppError(
      "VALIDATION_ERROR",
      locationName
        ? "This domain + city combination is already being tracked"
        : "This domain + country combination is already being tracked",
    );
  }

  // Enforced for reactivations too, not just new rows — otherwise archiving
  // and re-adding domains would push a project past the active-config cap.
  const allConfigs = await RankTrackingRepository.getConfigsForProject(
    input.projectId,
  );
  if (allConfigs.length >= MAX_CONFIGS_PER_PROJECT) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Maximum ${MAX_CONFIGS_PER_PROJECT} tracked domains per project`,
    );
  }

  if (existing) {
    await RankTrackingRepository.updateConfig(existing.id, input.projectId, {
      isActive: true,
      languageCode,
      devices: input.devices ?? "both",
      serpDepth: input.serpDepth,
      scheduleInterval,
      nextCheckAt,
      // Drop any stale skip reason from before it was archived so the
      // re-added domain doesn't surface an outdated warning.
      lastSkipReason: null,
    });

    return { configId: existing.id };
  }

  const configId = crypto.randomUUID();

  await RankTrackingRepository.createConfig({
    id: configId,
    projectId: input.projectId,
    domain: normalizedDomain,
    locationCode,
    languageCode,
    locationName,
    devices: input.devices ?? "both",
    serpDepth: input.serpDepth,
    scheduleInterval,
    nextCheckAt,
  });

  return { configId };
}

async function updateConfig(
  configId: string,
  projectId: string,
  input: {
    domain?: string;
    locationCode?: number;
    languageCode?: string;
    locationName?: string | null;
    devices?: RankTrackingConfig["devices"];
    serpDepth?: number;
    scheduleInterval?: RankTrackingConfig["scheduleInterval"];
    isActive?: boolean;
  },
) {
  const updates: typeof input & { nextCheckAt?: string | null } = {};

  if (input.domain !== undefined)
    updates.domain = normalizeDomain(input.domain);
  if (input.locationCode !== undefined)
    updates.locationCode = input.locationCode;
  if (input.languageCode !== undefined)
    updates.languageCode = input.languageCode;
  if (input.locationName !== undefined)
    updates.locationName = input.locationName;
  if (input.devices !== undefined) updates.devices = input.devices;
  if (input.serpDepth !== undefined) updates.serpDepth = input.serpDepth;
  if (input.isActive !== undefined) updates.isActive = input.isActive;

  if (input.scheduleInterval !== undefined) {
    updates.scheduleInterval = input.scheduleInterval;
    if (input.scheduleInterval === "manual") {
      updates.nextCheckAt = null;
    } else {
      updates.nextCheckAt = computeNextCheckAt(input.scheduleInterval);
    }
  }

  await RankTrackingRepository.updateConfig(configId, projectId, updates);
}

// ---------------------------------------------------------------------------
// Keywords
// ---------------------------------------------------------------------------

async function addKeywords(
  configId: string,
  projectId: string,
  keywords: string[],
) {
  await getValidatedConfig(configId, projectId);

  // Filter out keywords that already exist for this config.
  // We must do this before inserting because onConflictDoNothing silently
  // skips duplicates but we pre-generate UUIDs — returning those phantom IDs
  // would cause the auto-check workflow to find no keywords and fail.
  const existing = await RankTrackingRepository.getKeywordsForConfig(configId);

  if (existing.length >= MAX_KEYWORDS_PER_CONFIG) {
    throw new AppError(
      "INTERNAL_ERROR",
      `Maximum ${MAX_KEYWORDS_PER_CONFIG} keywords per domain. Currently tracking ${existing.length}.`,
    );
  }

  const existingKeywords = new Set(existing.map((kw) => kw.keyword));
  const available = MAX_KEYWORDS_PER_CONFIG - existing.length;

  const seen = new Set<string>();
  const rows: Array<{ id: string; configId: string; keyword: string }> = [];
  for (const raw of keywords) {
    if (rows.length >= available) break;
    const normalized = raw.trim().toLowerCase();
    if (
      normalized &&
      !seen.has(normalized) &&
      !existingKeywords.has(normalized)
    ) {
      seen.add(normalized);
      rows.push({ id: crypto.randomUUID(), configId, keyword: normalized });
    }
  }

  if (rows.length > 0) {
    await RankTrackingRepository.addKeywordsToConfig(rows);
  }

  return { added: rows.length, addedIds: rows.map((r) => r.id) };
}

async function removeKeywords(
  configId: string,
  projectId: string,
  keywordIds: string[],
) {
  await getValidatedConfig(configId, projectId);
  await RankTrackingRepository.removeKeywordsFromConfig(keywordIds, configId);
}

// ---------------------------------------------------------------------------
// Trigger a manual check
// ---------------------------------------------------------------------------

async function validateSelectedKeywordIds(
  configId: string,
  keywordIds: string[] | undefined,
): Promise<string[] | null> {
  if (!keywordIds || keywordIds.length === 0) return null;

  const configKeywords =
    await RankTrackingRepository.getKeywordsForConfig(configId);
  const configKeywordIds = new Set(configKeywords.map((kw) => kw.id));

  const seen = new Set<string>();
  const validated: string[] = [];
  for (const id of keywordIds) {
    if (seen.has(id) || !configKeywordIds.has(id)) continue;
    seen.add(id);
    validated.push(id);
  }

  if (validated.length === 0) {
    throw new AppError(
      "VALIDATION_ERROR",
      "None of the selected keywords are tracked on this domain",
    );
  }

  return validated;
}

async function triggerCheck(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: MissingRankingBucket[];
  operationId?: string;
  readOnlySync?: boolean;
}): Promise<RankCheckTriggerResult> {
  const config = await getValidatedConfig(input.configId, input.projectId);

  if (input.readOnlySync) {
    if (
      config.id !== APPROVED_PILOT_CONFIG_ID ||
      input.projectId !== APPROVED_PILOT_PROJECT_ID
    ) {
      throw new AppError(
        "FORBIDDEN",
        `Only approved pilot configuration ${APPROVED_PILOT_CONFIG_ID} is authorized for read-only sync`,
      );
    }
  }

  const keywords = await RankTrackingRepository.getKeywordsForConfig(config.id);
  if (keywords.length === 0) {
    throw new AppError(
      "INTERNAL_ERROR",
      "No keywords to track. Add keywords to this domain first.",
    );
  }

  const requestedKeywordIds = await validateSelectedKeywordIds(
    config.id,
    input.keywordIds,
  );

  // "Check missing rankings" mode: eligibility is resolved here — once at
  // trigger time for the run's keyword scope, and again inside the workflow
  // prepare step (fresh state at execution time, so a keyword that recovered
  // between trigger and execution is not billed). Explicit selection
  // intersects the eligible set. Zero eligible keywords returns BEFORE any
  // run is created — no empty provider-execution run ever exists.
  let effectiveKeywordIds = requestedKeywordIds ?? undefined;
  let missingBreakdown: MissingRankingsBreakdown | null = null;
  let candidatesCount = keywords.length;
  let missingEligibleBeforeFilter = 0;

  if (input.missingRankings) {
    const resolution = await resolveMissingRankingKeywordIds({
      configId: config.id,
      devices: config.devices,
      keywordIds: requestedKeywordIds ?? undefined,
      missingRankingStates: input.missingRankingStates,
    });
    missingBreakdown = resolution.breakdown;
    candidatesCount = resolution.candidatesCount;
    missingEligibleBeforeFilter = resolution.totalMissingCount;

    if (resolution.eligibleIds.length === 0) {
      return {
        ok: false,
        reason: "no_missing_rankings",
        blockingRunId: null,
        operationId: input.operationId,
        eligibleCount: 0,
        candidatesCount,
        missingEligibleBeforeFilter,
        selectedStates: input.missingRankingStates,
        breakdown: resolution.breakdown,
      };
    }
    effectiveKeywordIds = resolution.eligibleIds;
  }

  if (input.readOnlySync) {
    effectiveKeywordIds = [...APPROVED_PILOT_KEYWORD_IDS];
  }

  const runResult = await beginRankCheckRun({
    workflow: env.RANK_CHECK_WORKFLOW,
    config,
    projectId: input.projectId,
    billingCustomer: {
      userId: input.billingCustomer.userId,
      userEmail: input.billingCustomer.userEmail,
      organizationId: input.billingCustomer.organizationId,
      projectId: input.billingCustomer.projectId,
    },
    keywordsTotal: effectiveKeywordIds
      ? effectiveKeywordIds.length
      : keywords.length,
    keywordIds: effectiveKeywordIds,
    // Always record manual/API invocations as "manual" even when readOnlySync=true,
    // so manual read-only imports never advance or block scheduled weekly cadence.
    trigger: "manual",
    workflowStartErrorMessage: "Failed to start rank check workflow",
    missingRankings: input.missingRankings ?? false,
    missingRankingStates: input.missingRankingStates,
    readOnlySync: input.readOnlySync ?? false,
  });

  if (runResult.ok) {
    const totalTracked = keywords.length;
    const validatedCount = effectiveKeywordIds
      ? effectiveKeywordIds.length
      : totalTracked;
    return {
      ...runResult,
      operationId: input.operationId,
      scope: effectiveKeywordIds ? "selected" : "all",
      selectedCount: input.keywordIds?.length ?? totalTracked,
      validatedCount,
      validatedKeywordIds: effectiveKeywordIds,
      unselectedCount: totalTracked - validatedCount,
      candidatesCount,
      missingEligibleBeforeFilter,
      selectedStates: input.missingRankingStates,
      ...(missingBreakdown ? { breakdown: missingBreakdown } : {}),
    };
  }

  return {
    ...runResult,
    operationId: input.operationId,
  };
}

async function triggerReadOnlySync(input: {
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  keywordIds?: string[];
}): Promise<RankCheckTriggerResult> {
  const config = await getValidatedConfig(input.configId, input.projectId);

  if (
    config.id !== APPROVED_PILOT_CONFIG_ID ||
    input.projectId !== APPROVED_PILOT_PROJECT_ID
  ) {
    throw new AppError(
      "FORBIDDEN",
      `Only approved pilot configuration ${APPROVED_PILOT_CONFIG_ID} is authorized for read-only sync`,
    );
  }

  const requestedKeywordIds = await validateSelectedKeywordIds(
    config.id,
    input.keywordIds ?? [...APPROVED_PILOT_KEYWORD_IDS],
  );
  const effectiveKeywordIds = requestedKeywordIds ?? [
    ...APPROVED_PILOT_KEYWORD_IDS,
  ];

  return beginRankCheckRun({
    workflow: env.RANK_CHECK_WORKFLOW,
    config,
    projectId: input.projectId,
    billingCustomer: input.billingCustomer,
    keywordsTotal: effectiveKeywordIds.length,
    keywordIds: effectiveKeywordIds,
    // Manual HTTP trigger (`POST /api/rank-tracking/read-only-sync`): keep cadence
    // separate from cron-initiated `scheduled` runs while preserving readOnlySync=true.
    trigger: "manual",
    workflowStartErrorMessage: "Failed to start read-only sync workflow",
    readOnlySync: true,
  });
}

async function getLatestRun(configId: string, projectId: string) {
  await getValidatedConfig(configId, projectId);
  const run = await RankTrackingRepository.getLatestRunForConfig(configId);
  if (!run) return null;
  const providerCalls = await RankTrackingRepository.getProviderCallsForRun(
    run.id,
  );

  // If the DB says the run is still active, check the workflow instance.
  // We only report staleness here — the next call to beginRankCheckRun will
  // mark a stale blocker as failed before retrying its insert. Mutating from
  // this read path caused a race where the original workflow kept running
  // while a replacement was started.
  const reconciliation = await reconcileActiveRankCheckRun(run);
  if (reconciliation) {
    return formatRankTrackingRun(run, providerCalls, {
      maybeStale: true,
      staleReason: reconciliation.errorMessage,
    });
  }

  return formatRankTrackingRun(run, providerCalls);
}

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

export type RankTrackingEstimateCostResult = {
  provider: "seranking" | "dataforseo";
  pricingModel: "subscription_quota" | "per_serp_usd";
  costUsd: number | null;
  costCredits: number | null;
  keywordCount: number;
  targetCount: number;
  totalChecks: number;
  devicesCount: number;
  method: "queued" | "live";
};

async function estimateCost(
  configId: string,
  projectId: string,
  organizationId?: string,
  keywordIds?: string[],
): Promise<RankTrackingEstimateCostResult> {
  const config = await getValidatedConfig(configId, projectId);
  const allKeywords =
    await RankTrackingRepository.getKeywordsForConfig(configId);
  const scopedKeywords =
    keywordIds && keywordIds.length > 0
      ? allKeywords.filter((k) => keywordIds.includes(k.id))
      : allKeywords;
  const keywordCount = scopedKeywords.length;

  let effectiveOrgId = organizationId;
  if (!effectiveOrgId) {
    const proj = await db
      .select({ organizationId: projects.organizationId })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    effectiveOrgId = proj[0]?.organizationId;
  }

  const seConfig = await resolveEffectiveSeRankingConfig({
    organizationId: effectiveOrgId ?? undefined,
    projectId,
  });
  let isSeRanking = Boolean(seConfig.enabled);

  if (!isSeRanking) {
    const binding =
      await SeRankingBindingRepository.getProjectBindingByLocalProject(
        projectId,
      );
    if (binding && binding.status !== "failed" && binding.remoteSiteId) {
      isSeRanking = true;
    }
  }

  const targets = await RankTrackingTargetRepository.getTargetsForConfig(
    configId,
    true,
  );
  const targetCount =
    targets.length > 0 ? targets.length : devicesCount(config.devices);

  let totalChecks = 0;
  if (targets.length > 0) {
    const ktAssignments =
      await RankTrackingTargetRepository.getKeywordTargetsForTargets(
        targets.map((t) => t.id),
        false,
      );
    const kwAssignmentMap = new Map<string, Map<string, boolean>>();
    for (const row of ktAssignments) {
      let perTarget = kwAssignmentMap.get(row.trackingKeywordId);
      if (!perTarget) {
        perTarget = new Map<string, boolean>();
        kwAssignmentMap.set(row.trackingKeywordId, perTarget);
      }
      perTarget.set(row.trackingTargetId, row.enabled);
    }

    for (const kw of scopedKeywords) {
      const explicitTargets = kwAssignmentMap.get(kw.id);
      for (const target of targets) {
        if (
          explicitTargets &&
          explicitTargets.size > 0 &&
          explicitTargets.get(target.id) !== true
        ) {
          continue;
        }
        totalChecks++;
      }
    }
  } else {
    totalChecks = keywordCount * devicesCount(config.devices);
  }

  if (isSeRanking) {
    return {
      provider: "seranking" as const,
      pricingModel: "subscription_quota" as const,
      costUsd: null,
      costCredits: null,
      keywordCount,
      targetCount,
      totalChecks,
      devicesCount: devicesCount(config.devices),
      method: "queued" as const,
    };
  }

  const baseCost = formatRankTrackingCost(config, keywordCount, totalChecks);
  return {
    provider: "dataforseo" as const,
    pricingModel: "per_serp_usd" as const,
    ...baseCost,
    targetCount,
    totalChecks,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
  }
  return config;
}

function normalizeDomain(domain: string): string {
  let d = domain.trim().toLowerCase();
  // Strip protocol, path/query/fragment, trailing slash, and www. prefix.
  d = d.replace(/^https?:\/\//, "");
  d = d.replace(/[/?#].*$/, "");
  d = d.replace(/\/+$/, "");
  d = d.replace(/^www\./, "");
  if (!d) {
    throw new AppError("INTERNAL_ERROR", "Invalid domain");
  }
  return d;
}

async function cancelRun(input: {
  configId?: string;
  projectId: string;
  runId: string;
}): Promise<{
  ok: boolean;
  runId: string;
  status: string;
  alreadyTerminal?: boolean;
}> {
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (
    !run ||
    run.projectId !== input.projectId ||
    (input.configId && run.configId !== input.configId)
  ) {
    throw new AppError("NOT_FOUND", "Rank check run not found");
  }

  await getValidatedConfig(run.configId, input.projectId);

  // Idempotency: if already in a terminal state, return without duplicate side effects
  if (
    run.status === "completed" ||
    run.status === "failed" ||
    run.status === "partial" ||
    run.status === "cancelled"
  ) {
    return {
      ok: true,
      runId: run.id,
      status: run.status,
      alreadyTerminal: true,
    };
  }

  const nowIso = new Date().toISOString();
  await RankTrackingRepository.updateRun(run.id, {
    status: "cancelled",
    errorMessage: "Cancelled by user",
    completedAt: nowIso,
  });

  try {
    const instance = await env.RANK_CHECK_WORKFLOW.get(run.id);
    await instance.terminate();
  } catch {
    // Workflow instance may not exist or terminate is unsupported in test env
  }

  return { ok: true, runId: run.id, status: "cancelled" };
}

async function withEligibleNextCheckAt<
  T extends {
    id: string;
    scheduleInterval: RankTrackingConfig["scheduleInterval"];
    isActive: boolean;
    nextCheckAt: string | null;
  },
>(items: T[]): Promise<T[]> {
  if (items.length === 0) return items;
  const scheduledRuns =
    await RankTrackingRepository.getLatestScheduledRunsForConfigs(
      items.map((item) => item.id),
    );
  return items.map((item) => {
    const latestScheduled = scheduledRuns.get(item.id);
    const lastScheduledAt =
      latestScheduled?.completedAt ?? latestScheduled?.startedAt ?? null;
    return {
      ...item,
      nextCheckAt: resolveEligibleNextCheckAt({
        scheduleInterval: item.scheduleInterval,
        isActive: item.isActive,
        nextCheckAt: item.nextCheckAt,
        lastScheduledAt,
      }),
    };
  });
}

async function getConfigsForProject(projectId: string) {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  return withEligibleNextCheckAt(configs);
}

async function getConfigSummaries(projectId: string) {
  const summaries = await RankTrackingRepository.getConfigSummaries(projectId);
  return withEligibleNextCheckAt(summaries);
}

export const RankTrackingService = {
  getConfigsForProject,
  getConfigSummaries,
  createConfig,
  updateConfig,
  addKeywords,
  removeKeywords,
  triggerCheck,
  triggerReadOnlySync,
  getMissingRankingsSummary,
  getLatestRun,
  estimateCost,
  refreshKeywordMetrics,
  cancelRun,
  ...targetOps,
};
