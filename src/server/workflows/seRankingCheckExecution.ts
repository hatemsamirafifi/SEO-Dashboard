import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import { SeRankingProjectSyncService } from "@/server/features/rank-tracking/services/SeRankingProjectSyncService";
import {
  SeRankingProjectService,
  createSeRankingClient,
} from "@/server/lib/seranking";
import { pgStep } from "@/server/workflows/pgStep";
import { AppError } from "@/server/lib/errors";
import {
  buildScopedPendingPairs,
  collectSeRankingPollRound,
  isSeRankingRunCancelled,
  recordSeRankingUncollected,
  resolveConfigTargets,
} from "./seRankingCheckHelpers";

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
}

export async function runSeRankingCheck(
  step: WorkflowStep,
  ctx: SeRankingCheckContext,
): Promise<{ batchError: string | null; checkedCount: number }> {
  const client = createSeRankingClient({ apiKey: ctx.apiKey });

  // 1. Ensure SE Ranking remote project exists (validates access & quota)
  const projectSync = await pgStep(
    step,
    "seranking-ensure-project",
    STEP_CONFIG,
    async () => {
      try {
        return await SeRankingProjectSyncService.ensureProject({
          localProjectId: ctx.projectId,
          organizationId: ctx.billingCustomer.organizationId,
          domain: ctx.domain,
          apiKey: ctx.apiKey,
          client,
        });
      } catch (err) {
        if (
          err instanceof AppError &&
          (err.code === "PAYMENT_REQUIRED" || err.code === "FORBIDDEN")
        ) {
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
      await SeRankingProjectSyncService.ensureSearchEngines({
        localProjectId: ctx.projectId,
        organizationId: ctx.billingCustomer.organizationId,
        projectBindingId: projectBinding.id,
        remoteSiteId,
        client,
        targetIds: resolved.map((t) => t.id),
      });
      return resolved;
    },
  );

  // 3. Synchronize tracked keywords to remote project (non-destructive, idempotent)
  await pgStep(step, "seranking-sync-keywords", STEP_CONFIG, async () => {
    return SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: ctx.projectId,
      configId: ctx.configId,
      projectBindingId: projectBinding.id,
      remoteSiteId,
      client,
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

  // 4. Trigger scoped recheck in SE Ranking (honoring run cancellation)
  if (await isSeRankingRunCancelled(ctx.runId)) {
    return { batchError: "Cancelled by user", checkedCount: 0 };
  }

  const recheckStartedAt = Date.now();
  await pgStep(step, "seranking-trigger-recheck", STEP_CONFIG, async () => {
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

    const res =
      engineKeywordPairs.length > 0
        ? await SeRankingProjectService.recheckPositions(client, {
            siteId: remoteSiteId,
            engineKeywordPairs,
          })
        : await SeRankingProjectService.recheckPositions(client, {
            siteId: remoteSiteId,
            keywordIds: [...new Set(fallbackKeywordIds)],
          });

    const uniqueKeywords = [
      ...new Set(pendingPairs.map((p) => p.trackingKeywordId)),
    ];
    await RankTrackingRepository.insertProviderCalls(
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
    );

    return res;
  });

  // 5. Durable polling loop for GET /sites/positions observations
  const today = new Date().toISOString().slice(0, 10);
  const pollIntervals = ctx.pollIntervals ?? DEFAULT_POLL_INTERVALS;
  let checkedCount = 0;

  const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
    ctx.configId,
    pendingPairs.map((p) => ({
      keywordId: p.trackingKeywordId,
      device: p.device,
    })),
    { excludeRunId: ctx.runId },
  );

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
          today,
          pendingPairs,
          previousPositions,
        }),
    );

    checkedCount += roundOutcome.collectedCount;
    pendingPairs = roundOutcome.stillPending;
  }

  // 6. Stragglers still uncollected: NOT_CHECKED if cancelled, CHECK_FAILED if timed out
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
        today,
        message: uncollectedMessage,
        rankingStatus: status,
        pendingPairs,
        previousPositions,
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
