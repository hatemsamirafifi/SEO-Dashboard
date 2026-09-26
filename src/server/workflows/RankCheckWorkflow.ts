/* eslint-disable max-lines */
import {
  WorkflowEntrypoint,
  type WorkflowEvent,
  type WorkflowStep,
} from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { withPgClient } from "@/db";
import type { BillingCustomerContext } from "@/server/billing/subscription";
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
} from "@/shared/rank-tracking";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { createRankSerpResolver } from "@/server/features/serp/providerResolver";

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
}

async function prepareRankCheckKeywords(input: {
  runId: string;
  configId: string;
  billingCustomer: BillingCustomerContext;
  devices: RankCheckParams["devices"];
  serpDepth: number;
  trigger: RankCheckParams["trigger"];
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: MissingRankingBucket[];
}) {
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
  // Scheduled checks go through the cheaper task queue, so estimate at queued
  // pricing — a live-price estimate would skip checks the user can afford.
  if (await isHostedServerAuthMode()) {
    const { costCredits } = estimateRankCheckCredits(
      trackingKeywords.length,
      input.devices,
      input.serpDepth,
      input.trigger === "scheduled" ? "queued" : "live",
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

  return {
    keywords: trackingKeywords.map((kw) => ({
      id: kw.id,
      keyword: kw.keyword,
    })),
  };
}

async function finalizeRankCheckRun(input: {
  runId: string;
  configId: string;
  projectId: string;
  billingCustomer: BillingCustomerContext;
  trigger: RankCheckParams["trigger"];
  batchError: string | null;
  queueStats: QueuedCheckStats | null;
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
  // Derive authoritative counts strictly from per-keyword snapshot outcomes.
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(
    input.runId,
  );
  const successfulSnapshots = snapshots.filter(
    (s) => s.rankingStatus === "RANKED" || s.rankingStatus === "NO_RESULT",
  );
  const failedSnapshots = snapshots.filter(
    (s) => s.rankingStatus === "CHECK_FAILED",
  );
  const successfulKeywords = new Set(
    successfulSnapshots.map((s) => s.trackingKeywordId),
  ).size;
  const failedKeywords = new Set(
    failedSnapshots.map((s) => s.trackingKeywordId),
  ).size;
  const allAttemptedKeywords = new Set(
    snapshots.map((s) => s.trackingKeywordId),
  ).size;

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
    (failedKeywords > 0 || unattemptedCount > 0 || input.batchError)
  ) {
    status = "failed";
    errorMessage = input.batchError
      ? `Completed 0 of ${keywordsTotal} keyword(s). Error: ${input.batchError}`
      : `${keywordsTotal} keyword(s) could not be checked`;
  } else if (failedKeywords > 0 || unattemptedCount > 0 || input.batchError) {
    status = "partial";
    errorMessage = input.batchError
      ? `Completed ${successfulKeywords} of ${keywordsTotal} keyword(s). Error: ${input.batchError}`
      : `${failedKeywords + unattemptedCount} keyword(s) could not be checked`;
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

  // One-line summary per run so fallback rates are visible in Workers Logs.
  // Keys match the PostHog event properties for log/event correlation.
  const queueSummary = input.queueStats
    ? ` queue_tasks=${input.queueStats.queueTasks} queue_collected=${input.queueStats.queueCollected} fallback_tasks=${input.queueStats.fallbackTasks} fallback_checked=${input.queueStats.fallbackChecked}`
    : "";
  // Error text can echo vendor/user content — keep it one line and bounded.
  const errorSummary = errorMessage
    ? ` error="${errorMessage.replace(/\s+/g, " ").slice(0, 200)}"`
    : "";
  console.log(
    `[rank-check] ${input.runId} completed org=${input.billingCustomer.organizationId} project=${input.projectId} trigger=${input.trigger} keywords=${successfulKeywords}/${keywordsTotal}${queueSummary}${errorSummary}`,
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
      ...(input.queueStats
        ? {
            queue_tasks: input.queueStats.queueTasks,
            queue_collected: input.queueStats.queueCollected,
            fallback_tasks: input.queueStats.fallbackTasks,
            fallback_checked: input.queueStats.fallbackChecked,
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

    const client = createDataforseoClient(billingCustomer);
    const rankSerp = await createRankSerpResolver({
      client,
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
            billingCustomer,
            devices,
            serpDepth,
            trigger,
            keywordIds,
            missingRankings,
            missingRankingStates,
          }),
      );

      const keywords = prepareResult.keywords;

      console.log(`[rank-check] ${runId} loaded ${keywords.length} keywords`);

      let batchError: string | null = null;
      let queueStats: QueuedCheckStats | null = null;

      try {
        const checkContext = {
          client,
          rankSerp,
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
        };
        // Scheduled checks use DataForSEO's task queue (~30% of live cost);
        // manual checks stay on the live endpoint for instant results.
        if (trigger === "scheduled") {
          queueStats = await runQueuedCheck(step, checkContext);
        } else {
          const liveFirstError = await runLiveCheck(step, checkContext);
          // Observability only: record the first sanitized provider failure
          // reason in the run record so the trace can name the actual
          // underlying error. No control-flow, retry, scope, or billing
          // change — finalize still recounts from the DB.
          batchError ??= liveFirstError;
        }
      } catch (error) {
        // Batch failure — snapshots for completed batches are already
        // persisted incrementally. Continue to finalization.
        batchError = error instanceof Error ? error.message : String(error);
        console.warn(`[rank-check] ${runId} partial failure: ${batchError}`);
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
