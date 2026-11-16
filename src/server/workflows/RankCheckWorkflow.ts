/* eslint-disable max-lines, complexity */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_KEYWORD_IDS,
} from "@/server/features/rank-tracking/services/scheduledRankChecks";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestRankingFactsForConfig } from "@/server/features/rank-tracking/repositories/missingRankingQueries";
import { failRunIfActive } from "@/server/features/rank-tracking/services/rankCheckRunGuards";
import {
  runLiveCheck,
  runQueuedCheck,
  type QueuedCheckStats,
} from "@/server/workflows/rankCheckPaths";
import { pgStep } from "@/server/workflows/pgStep";
import { createDataforseoClient } from "@/server/lib/dataforseo";
import { captureServerEvent } from "@/server/lib/posthog";
import { AppError } from "@/server/lib/errors";
import { autumn } from "@/server/billing/autumn";
import {
  AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
  AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
} from "@/shared/billing";
import {
  classifyKeywordFromPairFacts,
  estimateRankCheckCredits,
  type MissingRankingBucket,
  resolveRankCheckMethod,
} from "@/shared/rank-tracking";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { createRankSerpResolver } from "@/server/features/serp/providerResolver";
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import { runSeRankingCheck } from "@/server/workflows/seRankingCheckExecution";
import { reconstructExpectedPairs } from "@/server/workflows/seRankingCheckTargets";
import { freshToday } from "@/server/workflows/seRankingCheckBaseline";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

interface RankCheckParams {
  runId: string;
  configId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  devices: "both" | "desktop" | "mobile";
  serpDepth: number;
  trigger: "manual" | "scheduled";
  keywordIds?: string[];
  /** "Check missing rankings" mode: keywordIds were pre-resolved to the
   * eligible set at trigger time; prepare re-resolves against fresh state. */
  missingRankings?: boolean;
  missingRankingStates?: MissingRankingBucket[];
  readOnlySync?: boolean;
}

async function prepareRankCheckKeywords(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  devices: RankCheckParams["devices"];
  serpDepth: number;
  trigger: RankCheckParams["trigger"];
  locationCode: number;
  languageCode: string;
  locationName?: string;
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: MissingRankingBucket[];
  isSeRanking?: boolean;
  readOnlySync?: boolean;
}) {
  if (input.readOnlySync) {
    if (input.configId !== APPROVED_PILOT_CONFIG_ID) {
      throw new NonRetryableError(
        `Pilot allowlist violation: config ${input.configId} is not authorized for read-only sync pilot (authorized: ${APPROVED_PILOT_CONFIG_ID})`,
      );
    }
  }
  // If stale-cleanup marked our run failed before we got here, bail out
  // rather than resurrecting a superseded run.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (
    !run ||
    run.status === "failed" ||
    run.status === "completed" ||
    run.status === "partial" ||
    run.status === "cancelled"
  ) {
    throw new NonRetryableError(
      `Run ${input.runId} is no longer active (status=${run?.status ?? "missing"})`,
    );
  }

  await RankTrackingRepository.updateRun(input.runId, {
    status: "running",
  });

  let trackingKeywords = await RankTrackingRepository.getKeywordsForConfig(
    input.configId,
  );

  if (input.keywordIds && input.keywordIds.length > 0) {
    const idSet = new Set(input.keywordIds);
    trackingKeywords = trackingKeywords.filter((kw) => idSet.has(kw.id));
  }

  if (input.readOnlySync) {
    trackingKeywords = trackingKeywords.filter((kw) =>
      (APPROVED_PILOT_KEYWORD_IDS as readonly string[]).includes(kw.id),
    );
    if (trackingKeywords.length === 0) {
      throw new NonRetryableError(
        `Pilot allowlist violation: none of the approved keywords found in config.`,
      );
    }
  }

  // Missing-rankings mode re-resolves eligibility against fresh snapshot
  // state at execution time: a keyword that recovered on every tracked
  // device between trigger and execution is dropped here, before any
  // provider call is made. Pair-level, matching the trigger-time rule — a
  // keyword with a ranked device but a missing device stays in the run.
  // When missingRankingStates is provided, the keyword's current missing bucket
  // must also match one of the selected states.
  if (
    input.missingRankings &&
    input.keywordIds &&
    input.keywordIds.length > 0
  ) {
    const validBuckets = new Set<MissingRankingBucket>([
      "ranking_unavailable",
      "lost",
      "no_ranking",
    ]);
    const allowedStates =
      input.missingRankingStates !== undefined
        ? new Set(
            input.missingRankingStates.filter((s): s is MissingRankingBucket =>
              validBuckets.has(s),
            ),
          )
        : validBuckets;

    const facts = await getLatestRankingFactsForConfig(
      input.configId,
      trackingKeywords.map((kw) => kw.id),
    );
    trackingKeywords = trackingKeywords.filter((kw) => {
      const classification = classifyKeywordFromPairFacts(
        facts,
        kw.id,
        input.devices,
      );
      return (
        classification.eligible &&
        classification.bucket !== null &&
        allowedStates.has(classification.bucket)
      );
    });
  }

  if (trackingKeywords.length === 0) {
    throw new AppError("INTERNAL_ERROR", "No keywords to track");
  }

  // Verify the user has enough credits for the full check before starting.
  // The method (Live vs Standard Queue) is resolved from the SAME scoped
  // keyword count that the execution branch uses, so the precheck prices the
  // check exactly the way it will actually run: scheduled and multi-keyword
  // manual checks go through the cheaper task queue, and only a manual
  // single-keyword check pays the live price. A live-price estimate would
  // skip queued checks the user can afford.
  // SE Ranking Project API checks operate against the customer's remote
  // subscription quota, so skip DataForSEO autumn balance checks when active.
  if (!input.isSeRanking && (await isHostedServerAuthMode())) {
    const { costCredits } = estimateRankCheckCredits(
      trackingKeywords.length,
      input.devices,
      input.serpDepth,
      resolveRankCheckMethod(input.trigger, trackingKeywords.length),
    );
    const [monthlyCheck, topupCheck] = await Promise.all([
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_BALANCE_FEATURE_ID,
      }),
      autumn.check({
        customerId: input.billingCustomer.organizationId,
        featureId: AUTUMN_SEO_DATA_TOPUP_BALANCE_FEATURE_ID,
      }),
    ]);
    const available =
      (monthlyCheck.balance?.remaining ?? 0) +
      (topupCheck.balance?.remaining ?? 0);
    if (available < costCredits) {
      throw new AppError(
        "INSUFFICIENT_CREDITS",
        "Insufficient credits for rank check",
      );
    }
  }

  await RankTrackingRepository.updateRun(input.runId, {
    keywordsTotal: trackingKeywords.length,
  });

  const mappedKeywords = trackingKeywords.map((kw) => ({
    id: kw.id,
    keyword: kw.keyword,
  }));

  let expectedPairs: Array<{
    trackingKeywordId: string;
    trackingTargetId: string;
  }> = [];
  try {
    expectedPairs = await reconstructExpectedPairs({
      configId: input.configId,
      projectId: input.projectId,
      organizationId: input.billingCustomer.organizationId,
      devices: input.devices,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      locationName: input.locationName,
      keywords: mappedKeywords,
    });
  } catch (err) {
    console.warn(
      `[rank-check] Failed to reconstruct expected target pairs for ${input.configId}:`,
      err,
    );
  }

  return {
    keywords: mappedKeywords,
    expectedPairs,
  };
}

interface KeywordAccountingResult {
  successfulKeywords: number;
  partialKeywords: number;
  failedKeywords: number;
  allAttemptedKeywords: number;
  hasIncompletePairs: boolean;
}

export function evaluateTargetPairsAccounting(
  expectedPairs: Array<{ trackingKeywordId: string; trackingTargetId: string }>,
  snapshots: Awaited<
    ReturnType<typeof RankTrackingRepository.getSnapshotsForRun>
  >,
  runId: string,
): KeywordAccountingResult {
  const totalPairs = expectedPairs.length;
  let completedPairs = 0;
  let unverifiedPairs = 0;
  let failedPairs = 0;
  let pendingPairs = 0;

  const snapshotByTargetAndKw = new Map<string, (typeof snapshots)[0]>();
  const snapshotsByKw = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    if (s.trackingTargetId) {
      snapshotByTargetAndKw.set(
        `${s.trackingTargetId}:${s.trackingKeywordId}`,
        s,
      );
    }
    const list = snapshotsByKw.get(s.trackingKeywordId) ?? [];
    list.push(s);
    snapshotsByKw.set(s.trackingKeywordId, list);
  }

  const pairsByKeyword = new Map<
    string,
    Array<{ trackingKeywordId: string; trackingTargetId: string }>
  >();
  for (const pair of expectedPairs) {
    const list = pairsByKeyword.get(pair.trackingKeywordId) ?? [];
    list.push(pair);
    pairsByKeyword.set(pair.trackingKeywordId, list);
  }

  const fullySuccessfulKeywordIds = new Set<string>();
  const partiallySuccessfulKeywordIds = new Set<string>();
  const failedKeywordIds = new Set<string>();

  for (const [kwId, kwPairs] of pairsByKeyword.entries()) {
    let kwCompletedPairs = 0;

    for (const pair of kwPairs) {
      const snap =
        snapshotByTargetAndKw.get(
          `${pair.trackingTargetId}:${pair.trackingKeywordId}`,
        ) ??
        snapshotsByKw
          .get(pair.trackingKeywordId)
          ?.find((s) => !s.trackingTargetId);

      if (!snap) {
        pendingPairs++;
        continue;
      }

      const isUnverified =
        snap.completionConfidence === "UNVERIFIED" ||
        Boolean(snap.errorMessage?.includes("polling window")) ||
        Boolean(snap.providerStatus?.includes("polling window")) ||
        Boolean(
          snap.providerStatus?.includes("identical to pre-recheck baseline"),
        );

      const hasExplicitAcceptedConfidence =
        snap.completionConfidence === "CONFIRMED" ||
        snap.completionConfidence === "LIKELY_COMPLETE" ||
        ((snap.completionConfidence === null ||
          snap.completionConfidence === undefined) &&
          snap.provider !== "seranking" &&
          !isUnverified);

      if (isUnverified) {
        unverifiedPairs++;
      } else if (snap.rankingStatus === "CHECK_FAILED") {
        failedPairs++;
      } else if (
        (snap.rankingStatus === "RANKED" ||
          snap.rankingStatus === "NO_RESULT") &&
        hasExplicitAcceptedConfidence
      ) {
        completedPairs++;
        kwCompletedPairs++;
      } else {
        pendingPairs++;
      }
    }

    if (kwCompletedPairs === kwPairs.length && kwPairs.length > 0) {
      fullySuccessfulKeywordIds.add(kwId);
    } else if (kwCompletedPairs > 0) {
      partiallySuccessfulKeywordIds.add(kwId);
    } else {
      failedKeywordIds.add(kwId);
    }
  }

  let partialKeywords = partiallySuccessfulKeywordIds.size;
  let hasIncompletePairs = false;
  if (completedPairs < totalPairs) {
    hasIncompletePairs = true;
    if (completedPairs > 0 && partialKeywords === 0) {
      partialKeywords = 1;
    }
    console.log(
      `[rank-check] ${runId} target pairs breakdown: total=${totalPairs}, completed=${completedPairs}, unverified=${unverifiedPairs}, failed=${failedPairs}, pending=${pendingPairs}`,
    );
  }

  return {
    successfulKeywords: fullySuccessfulKeywordIds.size,
    partialKeywords,
    failedKeywords: failedKeywordIds.size,
    allAttemptedKeywords: pairsByKeyword.size,
    hasIncompletePairs,
  };
}

function evaluateDeviceBasedAccounting(
  devices: RankCheckParams["devices"] | undefined,
  snapshots: Awaited<
    ReturnType<typeof RankTrackingRepository.getSnapshotsForRun>
  >,
): KeywordAccountingResult {
  const expectedDevices: Array<"desktop" | "mobile"> =
    devices === "both"
      ? ["desktop", "mobile"]
      : devices === "mobile"
        ? ["mobile"]
        : devices === "desktop"
          ? ["desktop"]
          : [];

  const snapshotsByKeyword = new Map<string, typeof snapshots>();
  for (const s of snapshots) {
    const list = snapshotsByKeyword.get(s.trackingKeywordId) ?? [];
    list.push(s);
    snapshotsByKeyword.set(s.trackingKeywordId, list);
  }

  const fullySuccessfulKeywordIds = new Set<string>();
  const partiallySuccessfulKeywordIds = new Set<string>();
  const failedKeywordIds = new Set<string>();

  for (const [kwId, kwSnaps] of snapshotsByKeyword.entries()) {
    const hasFailed = kwSnaps.some(
      (s) =>
        s.rankingStatus === "CHECK_FAILED" ||
        s.completionConfidence === "UNVERIFIED",
    );
    const successfulSnaps = kwSnaps.filter(
      (s) =>
        (s.rankingStatus === "RANKED" || s.rankingStatus === "NO_RESULT") &&
        (s.completionConfidence === "CONFIRMED" ||
          s.completionConfidence === "LIKELY_COMPLETE" ||
          ((s.completionConfidence === null ||
            s.completionConfidence === undefined) &&
            s.provider !== "seranking")),
    );
    const successfulDevices = new Set(successfulSnaps.map((s) => s.device));

    const hasDevicesRecorded = kwSnaps.some(
      (s) => s.device === "desktop" || s.device === "mobile",
    );
    const allExpectedCovered =
      !hasDevicesRecorded ||
      expectedDevices.every((d) => successfulDevices.has(d));

    if (!hasFailed && allExpectedCovered && successfulSnaps.length > 0) {
      fullySuccessfulKeywordIds.add(kwId);
    } else if (successfulSnaps.length > 0) {
      partiallySuccessfulKeywordIds.add(kwId);
    } else {
      failedKeywordIds.add(kwId);
    }
  }

  return {
    successfulKeywords: fullySuccessfulKeywordIds.size,
    partialKeywords: partiallySuccessfulKeywordIds.size,
    failedKeywords: failedKeywordIds.size,
    allAttemptedKeywords: snapshotsByKeyword.size,
    hasIncompletePairs: false,
  };
}

export async function finalizeRankCheckRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: RankCheckParams["trigger"];
  batchError: string | null;
  queueStats: QueuedCheckStats | null;
  devices?: RankCheckParams["devices"];
  expectedPairs?: Array<{
    trackingKeywordId: string;
    trackingTargetId: string;
    device?: "desktop" | "mobile";
  }>;
  readOnlySync?: boolean;
}) {
  // If stale-cleanup already marked our run failed, don't overwrite that
  // decision with a completed status — a replacement run may already be
  // underway.
  const run = await RankTrackingRepository.getRunById(input.runId);
  if (
    !run ||
    run.status === "failed" ||
    run.status === "completed" ||
    run.status === "partial"
  ) {
    console.warn(
      `[rank-check] ${input.runId} no longer active (status=${run?.status ?? "missing"}), skipping finalization`,
    );
    return;
  }

  const nowIso = new Date().toISOString();

  // Snapshots were written incrementally by each batch step.
  // Derive authoritative counts strictly from per-keyword snapshot outcomes,
  // accounting for tracking targets: when multiple targets (country/city/language/device)
  // are configured, a completed pair does NOT imply other targets also completed.
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(
    input.runId,
  );

  // Read-only daily sync: if authentic snapshots were deduplicated (already existed for
  // today's check-date with identical data), reconcile them so the run accounting accurately
  // reflects that the keywords are up-to-date without writing duplicate snapshot rows.
  if (
    input.readOnlySync &&
    input.expectedPairs &&
    input.expectedPairs.length > 0
  ) {
    const today = freshToday();
    for (const pair of input.expectedPairs) {
      const alreadyInRun = snapshots.some(
        (s) =>
          s.trackingKeywordId === pair.trackingKeywordId &&
          (!pair.trackingTargetId ||
            s.trackingTargetId === pair.trackingTargetId),
      );
      if (!alreadyInRun) {
        const dev = pair.device ?? "desktop";
        const latestDate =
          await RankTrackingRepository.getLatestSnapshotDateForKeywordTarget({
            configId: input.configId,
            trackingKeywordId: pair.trackingKeywordId,
            trackingTargetId: pair.trackingTargetId,
            device: dev,
          });
        const match =
          await RankTrackingRepository.findExistingSnapshotForObservation({
            configId: input.configId,
            trackingKeywordId: pair.trackingKeywordId,
            trackingTargetId: pair.trackingTargetId,
            device: dev,
            dateStr: latestDate ?? today,
          });
        if (
          match &&
          (match.rankingStatus === "RANKED" ||
            match.rankingStatus === "NO_RESULT") &&
          match.completionConfidence !== "UNVERIFIED"
        ) {
          snapshots.push(match);
        }
      }
    }
  }

  const accounting =
    input.expectedPairs && input.expectedPairs.length > 0
      ? evaluateTargetPairsAccounting(
          input.expectedPairs,
          snapshots,
          input.runId,
        )
      : evaluateDeviceBasedAccounting(input.devices, snapshots);

  const {
    successfulKeywords,
    partialKeywords,
    failedKeywords,
    allAttemptedKeywords,
    hasIncompletePairs,
  } = accounting;

  // If the run was cancelled by user, preserve 'cancelled' status and update truthful checked count
  if (run.status === "cancelled") {
    await RankTrackingRepository.updateRun(input.runId, {
      status: "cancelled",
      keywordsChecked: successfulKeywords,
      completedAt: run.completedAt ?? nowIso,
      errorMessage: run.errorMessage ?? "Cancelled by user",
    });
    return;
  }

  const keywordsTotal = run.keywordsTotal || allAttemptedKeywords;
  const unattemptedCount = Math.max(0, keywordsTotal - allAttemptedKeywords);

  let status: "completed" | "partial" | "failed" = "completed";
  let errorMessage: string | undefined;

  if (
    successfulKeywords === 0 &&
    partialKeywords === 0 &&
    (failedKeywords > 0 || unattemptedCount > 0 || input.batchError)
  ) {
    status = "failed";
    errorMessage = input.batchError
      ? `Completed 0 of ${keywordsTotal} keyword(s). Error: ${input.batchError}`
      : `${keywordsTotal} keyword(s) could not be checked`;
  } else if (
    failedKeywords > 0 ||
    partialKeywords > 0 ||
    unattemptedCount > 0 ||
    hasIncompletePairs ||
    input.batchError
  ) {
    status = "partial";
    const partialNote =
      partialKeywords > 0 ? ` (${partialKeywords} partial)` : "";
    errorMessage = input.batchError
      ? `Completed ${successfulKeywords} of ${keywordsTotal} keyword(s)${partialNote}. Error: ${input.batchError}`
      : `${failedKeywords + unattemptedCount + partialKeywords} keyword(s) could not be fully checked`;
  } else {
    status = "completed";
  }

  // Flipping status away from 'pending'/'running' is what releases the
  // partial-index slot for the next run.
  await RankTrackingRepository.updateRun(input.runId, {
    status,
    keywordsChecked: successfulKeywords,
    completedAt: nowIso,
    ...(errorMessage ? { errorMessage } : {}),
  });

  // Clear any previous skip reason on success or partial success.
  // Note: nextCheckAt is NOT set here — the cron handler advances it eagerly
  // before starting the workflow to prevent retry storms.
  if (status !== "failed") {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastCheckedAt: nowIso,
      lastSkipReason: null,
    });
  }

  // One-line summary per run so queue outcome rates are visible in Workers
  // Logs. Keys match the PostHog event properties for log/event correlation.
  const queueSummary = input.queueStats
    ? ` queue_tasks=${input.queueStats.queueTasks} queue_collected=${input.queueStats.queueCollected} uncollected_tasks=${input.queueStats.uncollectedTasks}`
    : "";
  const readOnlyNote = input.readOnlySync
    ? " read_only_sync=true cost_credits=0"
    : "";
  // Error text can echo vendor/user content — keep it one line and bounded.
  const errorSummary = errorMessage
    ? ` error="${errorMessage.replace(/\s+/g, " ").slice(0, 200)}"`
    : "";
  console.log(
    `[rank-check] ${input.runId} completed org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} keywords=${successfulKeywords}/${keywordsTotal}${queueSummary}${readOnlyNote}${errorSummary}`,
  );

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status,
      trigger: input.trigger,
      keywords_checked: successfulKeywords,
      ...(input.readOnlySync
        ? {
            read_only_sync: true,
            cost_credits: 0,
            recheck_dispatches: 0,
          }
        : {}),
      ...(input.queueStats
        ? {
            queue_tasks: input.queueStats.queueTasks,
            queue_collected: input.queueStats.queueCollected,
            uncollected_tasks: input.queueStats.uncollectedTasks,
          }
        : {}),
    },
  });
}

async function markRankCheckRunFailed(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  error: unknown;
}) {
  const errorMessage =
    input.error instanceof Error ? input.error.message : "Unknown error";
  await failRunIfActive(input.runId, errorMessage);

  // Flag the config so the UI can show why the scheduled check was skipped
  const isInsufficientCredits =
    input.error instanceof AppError &&
    input.error.code === "INSUFFICIENT_CREDITS";
  if (isInsufficientCredits) {
    await RankTrackingRepository.updateConfig(input.configId, input.projectId, {
      lastSkipReason: "insufficient_credits",
    });
  }

  await captureServerEvent({
    distinctId: input.billingCustomer.userId,
    event: "rank_tracking:check_complete",
    organizationId: input.billingCustomer.organizationId,
    properties: {
      project_id: input.projectId,
      status: "failed",
      error: errorMessage,
    },
  });
}

export class RankCheckWorkflow extends WorkflowEntrypoint<
  Env,
  RankCheckParams
> {
  async run(event: WorkflowEvent<RankCheckParams>, step: WorkflowStep) {
    // Scope a per-request Postgres client for this workflow invocation (no-op in
    // D1 mode). The socket is reclaimed when the invocation ends, so there is
    // nothing to tear down here.
    return withPgClient(() => this.runScoped(event, step));
  }

  private async runScoped(
    event: WorkflowEvent<RankCheckParams>,
    step: WorkflowStep,
  ) {
    const {
      runId,
      configId,
      billingCustomer,
      projectId,
      domain,
      locationCode,
      languageCode,
      locationName,
      devices,
      serpDepth,
      trigger,
      keywordIds,
      missingRankings,
      missingRankingStates,
    } = event.payload;

    const seRankingConfig = await resolveEffectiveSeRankingConfig({
      organizationId: billingCustomer.organizationId,
      projectId,
    });
    const isSeRankingSelected = Boolean(seRankingConfig?.enabled);

    // Hard boundary: pilot allowlist enforcement at workflow execution boundary
    if (
      event.payload.readOnlySync ||
      (isSeRankingSelected && trigger === "scheduled")
    ) {
      const allowedConfigs = new Set([APPROVED_PILOT_CONFIG_ID]);
      if (
        !allowedConfigs.has(configId) ||
        projectId !== APPROVED_PILOT_PROJECT_ID
      ) {
        throw new NonRetryableError(
          `Execution boundary violation: configuration ${configId} for project ${projectId} is not authorized for scheduled pilot execution`,
        );
      }
      if (
        keywordIds &&
        keywordIds.some(
          (id) =>
            !(APPROVED_PILOT_KEYWORD_IDS as readonly string[]).includes(id),
        )
      ) {
        throw new NonRetryableError(
          `Execution boundary violation: keyword scope contains unauthorized keywords for scheduled pilot execution`,
        );
      }
    }

    const client = isSeRankingSelected
      ? null
      : createDataforseoClient(billingCustomer);
    const rankSerp = isSeRankingSelected
      ? null
      : await createRankSerpResolver({
          client: client!,
          organizationId: billingCustomer.organizationId,
          projectId,
        });

    // Guard: skip if config was archived after the workflow was triggered
    const configCheck = await pgStep(
      step,
      "check-active",
      { retries: { limit: 0, delay: "1 second" } },
      async () => {
        const cfg = await RankTrackingRepository.getConfigById({
          configId,
          projectId,
        });
        return { isActive: cfg?.isActive ?? false };
      },
    );
    if (!configCheck.isActive) {
      await failRunIfActive(runId, "Config has been archived");
      return;
    }

    try {
      if (isSeRankingSelected && !seRankingConfig?.apiKey) {
        throw new NonRetryableError(
          "SE Ranking is selected for Rank Tracking, but no API key is configured. Will not fall back to DataForSEO, Serper, or Zenserp.",
        );
      }

      if (event.payload.readOnlySync && configId !== APPROVED_PILOT_CONFIG_ID) {
        throw new NonRetryableError(
          `Pilot allowlist violation: config ${configId} is not authorized for read-only sync pilot (authorized: ${APPROVED_PILOT_CONFIG_ID})`,
        );
      }

      console.log(
        `[rank-check] ${runId} starting (trigger=${trigger}, devices=${devices})`,
      );

      const prepareResult = await pgStep(
        step,
        "prepare",
        { retries: { limit: 0, delay: "1 second" } },
        async () =>
          prepareRankCheckKeywords({
            runId,
            configId,
            projectId,
            billingCustomer,
            devices,
            serpDepth,
            trigger,
            locationCode,
            languageCode,
            locationName,
            keywordIds,
            missingRankings,
            missingRankingStates,
            isSeRanking: isSeRankingSelected,
            readOnlySync: event.payload.readOnlySync,
          }),
      );

      const keywords = prepareResult.keywords;
      const expectedPairs = prepareResult.expectedPairs;

      console.log(`[rank-check] ${runId} loaded ${keywords.length} keywords`);

      let batchError: string | null = null;
      let queueStats: QueuedCheckStats | null = null;

      try {
        if (isSeRankingSelected && seRankingConfig.apiKey) {
          const seResult = await runSeRankingCheck(step, {
            runId,
            projectId,
            configId,
            domain,
            billingCustomer,
            keywords,
            devices,
            locationCode,
            languageCode,
            locationName,
            apiKey: seRankingConfig.apiKey,
            readOnlySync: event.payload.readOnlySync,
            trigger,
          });
          batchError = seResult.batchError;
        } else {
          const checkContext = {
            client: client!,
            rankSerp: rankSerp!,
            keywords,
            devices,
            serpDepth,
            domain,
            locationCode,
            languageCode,
            locationName,
            runId,
            projectId,
            configId,
            // The scope whose effective DataForSEO settings the metered posts
            // run under — queued collection binds to the same account.
            billingScope: {
              organizationId: billingCustomer.organizationId,
              projectId: billingCustomer.projectId ?? null,
            },
            trigger,
          };
          // Method selection from the ACTUAL scoped keyword count: scheduled
          // checks and manual bulk checks run through DataForSEO's Standard
          // Queue (~30% of live cost); only an explicitly manual check of a
          // single keyword stays on the live endpoint for instant results.
          // resolveRankCheckMethod is the same helper the credit precheck and
          // the client cost/time copy use, so all three agree.
          const method = resolveRankCheckMethod(trigger, keywords.length);
          if (method === "queued") {
            queueStats = await runQueuedCheck(step, checkContext);
          } else {
            const liveFirstError = await runLiveCheck(step, checkContext);
            // Observability only: record the first sanitized provider failure
            // reason in the run record so the trace can name the actual
            // underlying error. No control-flow, retry, scope, or billing
            // change — finalize still recounts from the DB.
            batchError ??= liveFirstError;
          }
        }
      } catch (error) {
        // Batch failure — snapshots for completed batches are already
        // persisted incrementally. Continue to finalization.
        const errorDetail =
          error instanceof Error
            ? "issues" in error
              ? `${error.message}: ${JSON.stringify((error as { issues?: unknown }).issues)}`
              : error.stack || error.message
            : String(error);
        batchError = errorDetail;
        console.error(`[rank-check] ${runId} partial failure:`, errorDetail);
      }

      await pgStep(step, "finalize", SINGLE_ATTEMPT_STEP_CONFIG, async () =>
        finalizeRankCheckRun({
          runId,
          configId,
          projectId,
          billingCustomer,
          trigger,
          batchError,
          queueStats,
          devices,
          expectedPairs,
          readOnlySync: event.payload.readOnlySync,
        }),
      );
    } catch (error) {
      console.error(`Rank check ${runId} failed:`, error);
      await pgStep(step, "mark-failed", SINGLE_ATTEMPT_STEP_CONFIG, async () =>
        markRankCheckRunFailed({
          runId,
          configId,
          projectId,
          billingCustomer,
          error,
        }),
      );
      throw error;
    }
  }
}
