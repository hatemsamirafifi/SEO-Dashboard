/* eslint-disable max-lines-per-function */
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import { SeRankingProjectSyncService } from "@/server/features/rank-tracking/services/SeRankingProjectSyncService";
import { createSeRankingClient } from "@/server/lib/seranking";
import { pgStep } from "@/server/workflows/pgStep";
import { AppError } from "@/server/lib/errors";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_IDS,
  APPROVED_PILOT_TARGET_IDS,
} from "@/server/features/rank-tracking/services/scheduledRankChecks";
import {
  buildScopedPendingPairs,
  captureSeRankingRecheckBaseline,
  collectSeRankingPollRound,
  freshToday,
  isSeRankingRunCancelled,
  recordSeRankingUncollected,
  resolveConfigTargets,
} from "./seRankingCheckHelpers";
import {
  buildRecheckDispatchScope,
  dispatchSeRankingRecheck,
} from "./seRankingCheckDispatch";
import type { RecheckParams } from "@/server/lib/seranking";

const STEP_CONFIG = {
  retries: { limit: 1, delay: "2 seconds" as const },
  timeout: "5 minutes" as const,
};

const DEFAULT_POLL_INTERVALS = [
  "15 seconds",
  "30 seconds",
  "45 seconds",
  "1 minute",
  "1 minute",
  "2 minutes",
  "2 minutes",
] as const;

export interface SeRankingCheckContext {
  runId: string;
  projectId: string;
  configId: string;
  domain: string;
  billingCustomer: BillingCustomerContext;
  keywords: Array<{ id: string; keyword: string }>;
  devices: "both" | "desktop" | "mobile";
  locationCode: number;
  languageCode: string;
  locationName?: string;
  apiKey: string;
  pollIntervals?: readonly Parameters<WorkflowStep["sleep"]>[1][];
  readOnlySync?: boolean;
  trigger?: "manual" | "scheduled";
}

export async function runSeRankingCheck(
  step: WorkflowStep,
  ctx: SeRankingCheckContext,
): Promise<{ batchError: string | null; checkedCount: number }> {
  if (ctx.readOnlySync) {
    if (ctx.configId !== APPROVED_PILOT_CONFIG_ID) {
      throw new NonRetryableError(
        `Pilot allowlist violation: config ${ctx.configId} is not authorized for read-only sync pilot`,
      );
    }
    ctx.keywords = ctx.keywords.filter((kw) =>
      (APPROVED_PILOT_KEYWORD_IDS as readonly string[]).includes(kw.id),
    );
    if (ctx.keywords.length === 0) {
      throw new NonRetryableError(
        `Pilot allowlist violation: no approved keywords found in execution context`,
      );
    }
  }

  const client = createSeRankingClient({ apiKey: ctx.apiKey });

  // 1. Ensure SE Ranking remote project exists (validates access & quota)
  const projectSync = await pgStep(
    step,
    "seranking-ensure-project",
    STEP_CONFIG,
    async () => {
      try {
        const res = await SeRankingProjectSyncService.ensureProject({
          localProjectId: ctx.projectId,
          organizationId: ctx.billingCustomer.organizationId,
          domain: ctx.domain,
          apiKey: ctx.apiKey,
          client,
          readOnlySync: ctx.readOnlySync,
        });
        return {
          projectBinding: res.projectBinding,
          remoteSiteId: res.remoteSiteId,
        };
      } catch (err) {
        if (
          err instanceof AppError &&
          (err.code === "PAYMENT_REQUIRED" || err.code === "FORBIDDEN")
        ) {
          try {
            await RankTrackingRepository.updateConfig(
              ctx.configId,
              ctx.projectId,
              {
                isActive: false,
                lastSkipReason: `Paused: ${err.message}`,
              },
            );
            const proj =
              await SeRankingBindingRepository.getProjectBindingByLocalProject(
                ctx.projectId,
              );
            if (proj) {
              await SeRankingBindingRepository.updateProjectBinding(proj.id, {
                status: "paused",
                errorMessage: err.message,
              });
            }
          } catch {
            // best-effort config pause
          }
          throw new NonRetryableError(err.message);
        }
        throw err;
      }
    },
  );

  const { projectBinding, remoteSiteId } = projectSync;
  if (!remoteSiteId) {
    throw new NonRetryableError(
      "Failed to discover or create remote SE Ranking project",
    );
  }

  // 2. Ensure local tracking targets & remote search engines exist
  const targets = await pgStep(
    step,
    "seranking-ensure-targets",
    STEP_CONFIG,
    async () => {
      const resolved = await resolveConfigTargets({
        configId: ctx.configId,
        projectId: ctx.projectId,
        organizationId: ctx.billingCustomer.organizationId,
        devices: ctx.devices,
        locationCode: ctx.locationCode,
        languageCode: ctx.languageCode,
        locationName: ctx.locationName,
      });
      const finalTargets = ctx.readOnlySync
        ? resolved.filter((t) =>
            (APPROVED_PILOT_TARGET_IDS as readonly string[]).includes(t.id),
          )
        : resolved;
      await SeRankingProjectSyncService.ensureSearchEngines({
        localProjectId: ctx.projectId,
        organizationId: ctx.billingCustomer.organizationId,
        projectBindingId: projectBinding.id,
        remoteSiteId,
        client,
        targetIds: finalTargets.map((t) => t.id),
        readOnlySync: ctx.readOnlySync,
      });
      return finalTargets;
    },
  );

  // 3. Synchronize tracked keywords to remote project (non-destructive, idempotent, scoped to ctx.keywords)
  await pgStep(step, "seranking-sync-keywords", STEP_CONFIG, async () => {
    return SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: ctx.projectId,
      configId: ctx.configId,
      projectBindingId: projectBinding.id,
      remoteSiteId,
      client,
      keywords: ctx.keywords,
      readOnlySync: ctx.readOnlySync,
    });
  });

  let pendingPairs = await buildScopedPendingPairs({
    projectBindingId: projectBinding.id,
    targets,
    keywords: ctx.keywords,
  });

  if (pendingPairs.length === 0) {
    return { batchError: null, checkedCount: 0 };
  }

  const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
    ctx.configId,
    pendingPairs.map((p) => ({
      keywordId: p.trackingKeywordId,
      device: p.device,
    })),
    { excludeRunId: ctx.runId },
  );

  // 3b. Read-only daily sync mode: synchronize authentic provider positions
  //     without triggering any paid recheck POST or altering project check_freq.
  if (ctx.readOnlySync) {
    if (await isSeRankingRunCancelled(ctx.runId)) {
      return { batchError: "Cancelled by user", checkedCount: 0 };
    }

    const roundOutcome = await pgStep(
      step,
      "seranking-read-only-sync",
      STEP_CONFIG,
      async () =>
        collectSeRankingPollRound({
          client,
          remoteSiteId,
          runId: ctx.runId,
          projectId: ctx.projectId,
          configId: ctx.configId,
          today: freshToday(),
          pendingPairs,
          previousPositions,
          readOnlySync: true,
        }),
    );

    const checkedCount = roundOutcome.collectedCount;
    pendingPairs = roundOutcome.stillPending;

    if (pendingPairs.length > 0) {
      console.log(
        `[seranking-sync] ${pendingPairs.length} pair(s) had no observation available on SE Ranking for read-only sync.`,
      );
    } else {
      await SeRankingBindingRepository.updateProjectBinding(projectBinding.id, {
        status: "connected",
        lastSuccessfulSync: new Date().toISOString(),
        errorMessage: null,
      });
    }

    return { batchError: null, checkedCount };
  }

  // Hard safety barrier: verify readOnlySync cannot proceed to paid recheck dispatch under any circumstance
  if (ctx.readOnlySync) {
    throw new NonRetryableError(
      "CRITICAL: Recheck baseline capture and recheck dispatch are strictly forbidden in readOnlySync mode.",
    );
  }

  // 4. Same-day attribution baseline (FIX 1). Before dispatching the paid
  //    recheck, record each engine's check-date state and a fingerprint of any
  //    today-dated observation. Without this, an engine that was already
  //    checked earlier today (e.g. by a prior run or a scheduled check) cannot
  //    be distinguished from "this run's recheck completed" — the poll loop
  //    would accept stale same-day data as proof.
  if (await isSeRankingRunCancelled(ctx.runId)) {
    return { batchError: "Cancelled by user", checkedCount: 0 };
  }

  const recheckBaseline = await pgStep(
    step,
    "seranking-capture-baseline",
    STEP_CONFIG,
    async () =>
      captureSeRankingRecheckBaseline({
        client,
        remoteSiteId,
        today: freshToday(),
        pendingPairs,
      }),
  );

  if (await isSeRankingRunCancelled(ctx.runId)) {
    return { batchError: "Cancelled by user", checkedCount: 0 };
  }

  // 5. Trigger the scoped recheck through the durable dispatch state machine
  //    (FIX 2). Scope and params are derived outside the step so a retried
  //    step does not re-derive them from mutated state; the dispatch record
  //    guarantees the non-idempotent paid POST is never sent twice.
  const engineKeywordPairs: Array<{
    siteEngineId: number;
    keywordId: string;
  }> = [];
  const fallbackKeywordIds: string[] = [];

  for (const pair of pendingPairs) {
    if (!pair.remoteKeywordId) continue;
    if (pair.remoteSiteEngineId) {
      engineKeywordPairs.push({
        siteEngineId: pair.remoteSiteEngineId,
        keywordId: pair.remoteKeywordId,
      });
    } else {
      fallbackKeywordIds.push(pair.remoteKeywordId);
    }
  }

  const dispatchScope = buildRecheckDispatchScope(pendingPairs);
  const recheckParams: RecheckParams =
    engineKeywordPairs.length > 0
      ? { siteId: remoteSiteId, engineKeywordPairs }
      : { siteId: remoteSiteId, keywordIds: [...new Set(fallbackKeywordIds)] };

  const recheckStartedAt = Date.now();
  const dispatch = await pgStep(
    step,
    "seranking-trigger-recheck",
    STEP_CONFIG,
    async () =>
      dispatchSeRankingRecheck({
        client,
        remoteSiteId,
        runId: ctx.runId,
        configId: ctx.configId,
        dispatchScope,
        recheckParams,
        readOnlySync: ctx.readOnlySync,
      }),
  );

  // Audit rows only when the POST was actually sent by this run — an
  // already_dispatched / outcome_unknown / skipped_no_scope outcome means this
  // invocation did not (re)issue the provider call.
  if (dispatch.outcome === "dispatched") {
    const uniqueKeywords = [
      ...new Set(pendingPairs.map((p) => p.trackingKeywordId)),
    ];
    await pgStep(step, "seranking-log-recheck-call", STEP_CONFIG, async () =>
      RankTrackingRepository.insertProviderCalls(
        uniqueKeywords.map((kwId) => ({
          runId: ctx.runId,
          trackingKeywordId: kwId,
          device: ctx.devices === "mobile" ? "mobile" : "desktop",
          provider: "seranking",
          endpoint: "/v1/project-management/sites/positions/recheck",
          status: "success",
          httpStatus: 200,
          errorCode: null,
          durationMs: Math.max(0, Date.now() - recheckStartedAt),
        })),
      ),
    );
  }

  // 6. Durable polling loop for GET /sites/positions observations
  const pollIntervals = ctx.pollIntervals ?? DEFAULT_POLL_INTERVALS;
  let checkedCount = 0;

  for (
    let round = 0;
    round < pollIntervals.length && pendingPairs.length > 0;
    round++
  ) {
    if (await isSeRankingRunCancelled(ctx.runId)) {
      break;
    }

    if (typeof step.sleep === "function") {
      await step.sleep(`seranking-wait-${round}`, pollIntervals[round]);
    }

    if (await isSeRankingRunCancelled(ctx.runId)) {
      break;
    }

    const roundOutcome = await pgStep(
      step,
      `seranking-poll-${round}`,
      STEP_CONFIG,
      async () =>
        collectSeRankingPollRound({
          client,
          remoteSiteId,
          runId: ctx.runId,
          projectId: ctx.projectId,
          configId: ctx.configId,
          today: freshToday(),
          pendingPairs,
          previousPositions,
          recheckBaseline,
          trigger: ctx.trigger,
        }),
    );

    checkedCount += roundOutcome.collectedCount;
    pendingPairs = roundOutcome.stillPending;
  }

  // 7. Stragglers still uncollected: NOT_CHECKED if cancelled, CHECK_FAILED if timed out
  let batchError: string | null = null;
  if (pendingPairs.length > 0) {
    const cancelled = await isSeRankingRunCancelled(ctx.runId);
    const status = cancelled ? "NOT_CHECKED" : "CHECK_FAILED";
    const uncollectedMessage = cancelled
      ? "SE Ranking check was cancelled before completion"
      : "SE Ranking queued recheck did not produce a completed observation within the polling window";
    if (!cancelled) {
      batchError = uncollectedMessage;
    }

    await pgStep(step, "seranking-record-uncollected", STEP_CONFIG, async () =>
      recordSeRankingUncollected({
        runId: ctx.runId,
        projectId: ctx.projectId,
        configId: ctx.configId,
        today: freshToday(),
        message: uncollectedMessage,
        rankingStatus: status,
        pendingPairs,
        previousPositions,
        client,
        remoteSiteId,
        recheckBaseline,
        trigger: ctx.trigger,
      }),
    );
  } else {
    await SeRankingBindingRepository.updateProjectBinding(projectBinding.id, {
      status: "connected",
      lastSuccessfulSync: new Date().toISOString(),
      errorMessage: null,
    });
  }

  return { batchError, checkedCount };
}
