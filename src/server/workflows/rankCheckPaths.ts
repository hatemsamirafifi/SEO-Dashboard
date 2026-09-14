/* eslint-disable max-lines */
import type { WorkflowStep } from "cloudflare:workers";
import type { InferInsertModel } from "drizzle-orm";
import type { rankSnapshots } from "@/db/schema";
import { sanitizeDataforseoMessage } from "@/server/lib/dataforseo/shared";
import { scrubGlobalTraceText } from "@/shared/globalTraceTypes";
import { formatDataforseoTaskErrorMessage } from "@/shared/dataforseoDiagnosticsParser";
import { asAppError } from "@/server/lib/errors";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";
import type {
  createDataforseoClient,
  PostedRankCheckTask,
  RankCheckResult,
  RankCheckTaskInput,
} from "@/server/lib/dataforseo";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { KEYWORDS_PER_BATCH } from "@/shared/rank-tracking";
import { pgStep } from "@/server/workflows/pgStep";

const SINGLE_ATTEMPT_STEP_CONFIG = {
  retries: { limit: 0, delay: "1 second" as const },
  timeout: "2 minutes" as const,
};

type KeywordEntry = { id: string; keyword: string };
type RankCheckResultWithDevice = RankCheckResult & {
  device: "desktop" | "mobile";
};

interface CheckContext {
  client: ReturnType<typeof createDataforseoClient>;
  keywords: KeywordEntry[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  domain: string;
  locationCode: number;
  languageCode: string;
  locationName?: string;
  runId: string;
  projectId: string;
  configId: string;
}

function mapResultsToSnapshotRows(
  ctx: CheckContext,
  results: RankCheckResultWithDevice[],
  previousPositions: Map<string, number | null>,
): Array<Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">> {
  const today = new Date().toISOString().slice(0, 10);
  return results.map((r) => {
    const isRanked = r.position !== null;
    const prevPos =
      previousPositions.get(`${r.keywordId}:${r.device}`) ?? null;
    return {
      runId: ctx.runId,
      projectId: ctx.projectId,
      configId: ctx.configId,
      trackingKeywordId: r.keywordId,
      keyword: r.keyword,
      device: r.device,
      searchEngine: "google",
      searchType: "organic",
      location: ctx.locationName ?? String(ctx.locationCode),
      language: ctx.languageCode,
      checkedDate: today,
      position: r.position,
      previousPosition: prevPos,
      rankingStatus: isRanked ? "RANKED" : "NO_RESULT",
      url: r.url ?? null,
      serpFeatures:
        r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
      provider: "dataforseo",
      providerStatus: isRanked ? "Ok" : "No ranking found",
      providerStatusCode: 20000,
      errorMessage: null,
    };
  });
}

/** Expand keywords into one task input per keyword/device pair. */
function expandToTaskInputs(
  keywords: KeywordEntry[],
  devices: RankTrackingConfig["devices"],
): RankCheckTaskInput[] {
  const deviceList: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  return keywords.flatMap((kw) =>
    deviceList.map((device) => ({
      keyword: kw.keyword,
      keywordId: kw.id,
      device,
    })),
  );
}

// ---------------------------------------------------------------------------
// Step bodies. Each runs inside a single step.do: inputs are its parameters,
// the return value is what the workflow engine persists and replays. They must
// not touch any mutable state outside their arguments.
// ---------------------------------------------------------------------------

/** Upper bound for a captured provider failure reason (run.errorMessage). */
const MAX_PROVIDER_REASON_LENGTH = 500;

/**
 * Reduce a per-call rejection to a safe, bounded reason string for the run
 * record. DataForSEO HTTP failures already carry a canonical pre-scrubbed
 * message ("DataForSEO HTTP <status> on <path>: <message> (<code>)");
 * anything else is scrubbed and truncated here. Never credentials.
 */
export function safeProviderReason(reason: unknown): string {
  const appError = asAppError(reason);
  const statusCode = parseDataforseoStatusCode(reason);
  const raw = reason instanceof Error ? reason.message : String(reason);
  const sanitized =
    sanitizeDataforseoMessage(raw) ?? "DataForSEO request failed";
  // Chain the stronger Global-trace scrubber (covers bare password=/login=
  // pairs the SAM scrubber leaves alone). The SAM scrubber itself is
  // untouched.
  const scrubbed = scrubGlobalTraceText(sanitized);

  let formatted = scrubbed;
  if (
    (statusCode === 40201 || appError?.code === "DATAFORSEO_ACCOUNT_PAUSED") &&
    !scrubbed.startsWith("DataForSEO")
  ) {
    formatted = formatDataforseoTaskErrorMessage(40201, scrubbed);
  }

  return formatted.length > MAX_PROVIDER_REASON_LENGTH
    ? `${formatted.slice(0, MAX_PROVIDER_REASON_LENGTH)}…`
    : formatted;
}

export function parseDataforseoStatusCode(reason: unknown): number | null {
  const appError = asAppError(reason);
  if (appError) {
    if (appError.code === "DATAFORSEO_ACCOUNT_PAUSED") {
      return 40201;
    }
    const detailCode = appError.details?.providerStatusCode;
    if (detailCode) {
      const num = parseInt(detailCode, 10);
      if (!Number.isNaN(num)) return num;
    }
  }
  if (typeof reason === "object" && reason !== null) {
    const statusCode: unknown = Reflect.get(reason, "statusCode");
    if (typeof statusCode === "number") {
      return statusCode;
    }
    const statusCodeSnake: unknown = Reflect.get(reason, "status_code");
    if (typeof statusCodeSnake === "number") {
      return statusCodeSnake;
    }
  }
  const raw = reason instanceof Error ? reason.message : String(reason);
  const match = raw.match(/\((\d{5})\)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

/**
 * Check keyword/device pairs against the live endpoint and persist snapshots.
 * Per-call failures are logged and recorded as CHECK_FAILED snapshots with diagnostics.
 * Returns the snapshot count written plus the first sanitized provider failure reason
 * (null when every call succeeded).
 */
async function checkBatchLive(
  ctx: CheckContext,
  tasks: RankCheckTaskInput[],
): Promise<{ written: number; firstError: string | null }> {
  const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
    ctx.configId,
    tasks.map((t) => ({ keywordId: t.keywordId, device: t.device })),
    { excludeRunId: ctx.runId },
  );

  const settled = await Promise.allSettled(
    tasks.map((task) =>
      ctx.client.serp
        .rankCheck({
          keyword: task.keyword,
          keywordId: task.keywordId,
          locationCode: ctx.locationCode,
          languageCode: ctx.languageCode,
          locationName: ctx.locationName,
          device: task.device,
          targetDomain: ctx.domain,
          depth: ctx.serpDepth,
        })
        .then((r) => ({ ...r, device: task.device })),
    ),
  );

  const today = new Date().toISOString().slice(0, 10);
  const snapshotRows: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
  > = [];
  let firstError: string | null = null;

  settled.forEach((outcome, index) => {
    const task = tasks[index];
    const prevPos =
      previousPositions.get(`${task.keywordId}:${task.device}`) ?? null;

    if (outcome.status === "fulfilled") {
      const r = outcome.value;
      const isRanked = r.position !== null;
      snapshotRows.push({
        runId: ctx.runId,
        projectId: ctx.projectId,
        configId: ctx.configId,
        trackingKeywordId: task.keywordId,
        keyword: task.keyword,
        device: task.device,
        searchEngine: "google",
        searchType: "organic",
        location: ctx.locationName ?? String(ctx.locationCode),
        language: ctx.languageCode,
        checkedDate: today,
        position: r.position,
        previousPosition: prevPos,
        rankingStatus: isRanked ? "RANKED" : "NO_RESULT",
        url: r.url ?? null,
        serpFeatures:
          r.serpFeatures.length > 0 ? JSON.stringify(r.serpFeatures) : null,
        provider: "dataforseo",
        providerStatus: isRanked ? "Ok" : "No ranking found",
        providerStatusCode: 20000,
        errorMessage: null,
      });
    } else {
      console.error(
        `[rank-check] ${ctx.runId} live call failed:`,
        outcome.reason,
      );
      const reason = safeProviderReason(outcome.reason);
      firstError ??= reason;
      const statusCode = parseDataforseoStatusCode(outcome.reason);
      snapshotRows.push({
        runId: ctx.runId,
        projectId: ctx.projectId,
        configId: ctx.configId,
        trackingKeywordId: task.keywordId,
        keyword: task.keyword,
        device: task.device,
        searchEngine: "google",
        searchType: "organic",
        location: ctx.locationName ?? String(ctx.locationCode),
        language: ctx.languageCode,
        checkedDate: today,
        position: null,
        previousPosition: prevPos,
        rankingStatus: "CHECK_FAILED",
        url: null,
        serpFeatures: null,
        provider: "dataforseo",
        providerStatus: reason,
        providerStatusCode: statusCode,
        errorMessage: reason,
      });
    }
  });

  if (snapshotRows.length > 0) {
    await RankTrackingRepository.insertSnapshots(snapshotRows);
  }
  return { written: snapshotRows.length, firstError };
}

/**
 * Check keywords via Live API, parallel devices per keyword, real-time progress.
 * Snapshots are written incrementally after each batch so partial results
 * survive batch failures. ~6s per keyword batch.
 * Billing is handled per-call by the metered client.
 *
 * Returns the first sanitized provider failure reason across batches (null
 * when every call succeeded) so the caller can record the actual underlying
 * error. The persisted step result stays the written count — the reason only
 * travels in-memory to the run record. Observability only.
 */
export async function runLiveCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<string | null> {
  let firstError: string | null = null;
  for (let i = 0; i < ctx.keywords.length; i += KEYWORDS_PER_BATCH) {
    const keywordBatch = ctx.keywords.slice(i, i + KEYWORDS_PER_BATCH);
    const batchTasks = expandToTaskInputs(keywordBatch, ctx.devices);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);
    const keywordsChecked = i + keywordBatch.length;

    await pgStep(
      step,
      `live-batch-${batchIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      async () => {
        const batch = await checkBatchLive(ctx, batchTasks);
        firstError ??= batch.firstError;
        // Progress for the UI; finalize recounts from the DB anyway.
        await RankTrackingRepository.updateRun(ctx.runId, {
          keywordsChecked,
        });
        return batch.written;
      },
    );
  }
  return firstError;
}

// Poll cadence for queued tasks. Standard-priority tasks complete in ~5
// minutes on average, so the first check waits 4 minutes; cumulative waits are
// 4 / 6 / 8 / 10 / 12 / 15 minutes, after which stragglers fall back to the
// live endpoint.
const QUEUED_POLL_INTERVALS = [
  "4 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "2 minutes",
  "3 minutes",
] as const;

/** Concurrent task_get requests within a collect step. */
const TASK_GET_CONCURRENCY = 25;

/** Max task_get calls per collect round (per-invocation subrequest budget). */
const TASK_GETS_PER_COLLECT = 500;

// Collect steps may issue hundreds of task_get calls, so they get more room
// than SINGLE_ATTEMPT_STEP_CONFIG's 2-minute timeout. Unlike the metered
// steps, retrying is safe and free: task_get isn't charged and snapshot
// inserts are onConflictDoNothing.
const COLLECT_STEP_CONFIG = {
  retries: { limit: 2, delay: "10 seconds" as const },
  timeout: "5 minutes" as const,
};

interface CollectRoundOutcome {
  /** Snapshots written this round. */
  collected: number;
  /** Tasks still in DataForSEO's queue — poll again next round. */
  stillPending: PostedRankCheckTask[];
  /** Tasks DataForSEO failed — route to the live fallback. */
  failed: PostedRankCheckTask[];
}

/**
 * Fetch results for queued tasks (one free task_get each), persist completed
 * snapshots, and update run progress. Transient task_get failures stay
 * pending for the next round.
 */
async function collectQueuedRound(
  ctx: CheckContext,
  tasks: PostedRankCheckTask[],
): Promise<CollectRoundOutcome> {
  const completed: RankCheckResultWithDevice[] = [];
  const stillPending: PostedRankCheckTask[] = [];
  const failed: PostedRankCheckTask[] = [];

  for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
    const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
    const settled = await Promise.allSettled(
      chunk.map((task) =>
        fetchRankCheckTaskResult({
          taskId: task.taskId,
          keywordId: task.keywordId,
          keyword: task.keyword,
          targetDomain: ctx.domain,
        }),
      ),
    );
    settled.forEach((result, index) => {
      const task = chunk[index];
      if (result.status === "rejected") {
        // Transient fetch failure — try again next round.
        console.warn(
          `[rank-check] ${ctx.runId} task_get failed:`,
          result.reason,
        );
        stillPending.push(task);
      } else if (result.value.status === "pending") {
        stillPending.push(task);
      } else if (result.value.status === "failed") {
        console.warn(
          `[rank-check] ${ctx.runId} task ${task.taskId} failed: ${result.value.message}`,
        );
        failed.push(task);
      } else {
        completed.push({ ...result.value.result, device: task.device });
      }
    });
  }

  if (completed.length > 0) {
    const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
      ctx.configId,
      completed.map((t) => ({ keywordId: t.keywordId, device: t.device })),
      { excludeRunId: ctx.runId },
    );
    await RankTrackingRepository.insertSnapshots(
      mapResultsToSnapshotRows(ctx, completed, previousPositions),
    );
    // Progress for the UI; finalize recounts from the DB anyway.
    const snapshots = await RankTrackingRepository.getSnapshotsForRun(
      ctx.runId,
    );
    await RankTrackingRepository.updateRun(ctx.runId, {
      keywordsChecked: new Set(snapshots.map((s) => s.trackingKeywordId)).size,
    });
  }

  return { collected: completed.length, stillPending, failed };
}

/** Per-run accounting for the queued path, in keyword/device task units. */
export interface QueuedCheckStats {
  /** Tasks accepted into DataForSEO's queue. */
  queueTasks: number;
  /** Task results collected from the queue within the polling window. */
  queueCollected: number;
  /** Tasks routed to the live fallback (rejected, failed, or timed out). */
  fallbackTasks: number;
  /** Fallback tasks that produced a snapshot. */
  fallbackChecked: number;
}

/**
 * Check keywords via DataForSEO's standard task queue (~30% of live cost).
 * Posts every keyword/device pair as a queued task, then polls task_get for
 * ~15 minutes, writing snapshots incrementally as tasks complete. Anything
 * still unfinished after the polling window — plus tasks DataForSEO rejected
 * or failed — gets one shot at the live endpoint so a run never hangs on a
 * stuck queue. Billing happens at task_post (and per live-fallback call).
 */
export async function runQueuedCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<QueuedCheckStats> {
  const taskInputs = expandToTaskInputs(ctx.keywords, ctx.devices);

  // Post all tasks to the queue, <=100 per request, one metered step each.
  // A failed chunk must not abort the run — earlier chunks were already
  // charged at DataForSEO, so their results have to be collected. The failed
  // chunk's pairs go to the live fallback instead.
  let pending: PostedRankCheckTask[] = [];
  const fallback: RankCheckTaskInput[] = [];
  for (let i = 0; i < taskInputs.length; i += MAX_TASKS_PER_POST) {
    const chunk = taskInputs.slice(i, i + MAX_TASKS_PER_POST);
    const postIndex = Math.floor(i / MAX_TASKS_PER_POST);
    let posted: PostedRankCheckTask[];
    try {
      posted = await pgStep(
        step,
        `post-tasks-${postIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        async () =>
          ctx.client.serp.rankCheckTaskPost({
            tasks: chunk,
            locationCode: ctx.locationCode,
            languageCode: ctx.languageCode,
            locationName: ctx.locationName,
            depth: ctx.serpDepth,
            targetDomain: ctx.domain,
          }),
      );
    } catch (error) {
      console.warn(
        `[rank-check] ${ctx.runId} post-tasks-${postIndex} failed:`,
        error,
      );
      fallback.push(...chunk);
      continue;
    }
    pending.push(...posted);
    if (posted.length < chunk.length) {
      const acceptedKeys = new Set(
        posted.map((t) => `${t.keywordId}:${t.device}`),
      );
      fallback.push(
        ...chunk.filter((t) => !acceptedKeys.has(`${t.keywordId}:${t.device}`)),
      );
    }
  }

  const stats: QueuedCheckStats = {
    queueTasks: pending.length,
    queueCollected: 0,
    fallbackTasks: 0,
    fallbackChecked: 0,
  };

  // Poll until everything is collected or the ~15 minute window closes. A
  // collect failure (past its retries) leaves that round's tasks pending for
  // the next round — or the live fallback — instead of failing the run; the
  // posted tasks are already paid for.
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);

    // Cap task_gets per round so one collect step stays well inside the
    // per-invocation subrequest limit at the 1000-keyword config ceiling.
    const batch = pending.slice(0, TASK_GETS_PER_COLLECT);
    const overflow = pending.slice(TASK_GETS_PER_COLLECT);

    let outcome: CollectRoundOutcome;
    try {
      outcome = await pgStep(
        step,
        `collect-${round}`,
        COLLECT_STEP_CONFIG,
        () => collectQueuedRound(ctx, batch),
      );
    } catch (error) {
      console.warn(`[rank-check] ${ctx.runId} collect-${round} failed:`, error);
      continue;
    }

    stats.queueCollected += outcome.collected;
    pending = [...outcome.stillPending, ...overflow];
    fallback.push(...outcome.failed);
  }

  // Live fallback: queued tasks that never finished, failed, or were rejected
  // at post time. A straggler is double-billed (customer was metered the
  // queued post cost and now the live call too — fractions of a cent).
  // Progress isn't updated here; finalize recounts keywordsChecked from the
  // DB.
  const stragglers: RankCheckTaskInput[] = [...fallback, ...pending];
  stats.fallbackTasks = stragglers.length;
  if (stragglers.length === 0) return stats;

  console.log(
    `[rank-check] ${ctx.runId} live fallback for ${stragglers.length} task(s)`,
  );

  for (let i = 0; i < stragglers.length; i += KEYWORDS_PER_BATCH) {
    const batch = stragglers.slice(i, i + KEYWORDS_PER_BATCH);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);

    stats.fallbackChecked += (
      await pgStep(
        step,
        `fallback-batch-${batchIndex}`,
        SINGLE_ATTEMPT_STEP_CONFIG,
        () => checkBatchLive(ctx, batch),
      )
    ).written;
  }

  return stats;
}
