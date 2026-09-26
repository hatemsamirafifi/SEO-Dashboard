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
import type { RankSerpResolver } from "@/server/features/serp/providerResolver";
import { SerpProvidersUnavailableError } from "@/server/features/serp/resolverCore";
import { SerpCancelledError } from "@/server/features/serp/types";
import {
  getIsoCountryCode,
  LOCATION_OPTIONS,
} from "@/shared/keyword-locations";

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
  rankSerp?: RankSerpResolver;
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
    const prevPos = previousPositions.get(`${r.keywordId}:${r.device}`) ?? null;
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

export const DEFAULT_LIVE_CONCURRENCY = 2;

export function getLiveCheckConcurrency(): number {
  if (typeof process !== "undefined" && process.env.RANK_CHECK_CONCURRENCY) {
    const val = parseInt(process.env.RANK_CHECK_CONCURRENCY, 10);
    if (!isNaN(val) && val > 0) return val;
  }
  return DEFAULT_LIVE_CONCURRENCY;
}

/**
 * Check keyword/device pairs against the live endpoint and persist snapshots.
 * Processes tasks through a bounded queue to allow responsive cancellation.
 * Immediately before dispatching each provider call, checks run cancellation.
 * Per-call failures are logged and recorded as CHECK_FAILED snapshots with diagnostics.
 * Returns the snapshot count written plus the first sanitized provider failure reason
 * (null when every call succeeded).
 */
async function checkBatchLive(
  ctx: CheckContext,
  tasks: RankCheckTaskInput[],
  options?: {
    concurrency?: number;
    baseKeywordsChecked?: number;
  },
): Promise<{
  written: number;
  distinctKeywordsChecked: number;
  firstError: string | null;
}> {
  const concurrency = options?.concurrency ?? getLiveCheckConcurrency();
  const baseKeywordsChecked = options?.baseKeywordsChecked;

  // Guard: if run was already cancelled before this batch, do not start
  const initialRun = await RankTrackingRepository.getRunById(ctx.runId);
  if (initialRun?.status === "cancelled") {
    return { written: 0, distinctKeywordsChecked: 0, firstError: null };
  }

  const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
    ctx.configId,
    tasks.map((t) => ({ keywordId: t.keywordId, device: t.device })),
    { excludeRunId: ctx.runId },
  );

  const today = new Date().toISOString().slice(0, 10);
  let firstError: string | null = null;
  let totalWritten = 0;
  const distinctKeywordsCheckedSet = new Set<string>();

  for (let i = 0; i < tasks.length; i += concurrency) {
    // 1. Check cancellation before pulling the next chunk from queue (Requirement 11)
    const chunkRun = await RankTrackingRepository.getRunById(ctx.runId);
    if (chunkRun?.status === "cancelled") {
      console.log(
        `[rank-check] ${ctx.runId} cancellation observed before task index ${i}; stopping`,
      );
      break;
    }

    const chunk = tasks.slice(i, i + concurrency);

    // 2. Execute at most `concurrency` tasks concurrently (Requirement 3)
    const chunkResults = await Promise.all(
      chunk.map(async (task) => {
        // Requirement 10: Check cancellation immediately before dispatching DataForSEO request
        const beforeDispatchRun = await RankTrackingRepository.getRunById(
          ctx.runId,
        );
        if (beforeDispatchRun?.status === "cancelled") {
          console.log(
            `[rank-check] ${ctx.runId} cancellation observed immediately before dispatch for ${task.keywordId}:${task.device}`,
          );
          return { task, dispatched: false, outcome: null };
        }

        try {
          if (
            process.env.NODE_ENV !== "production" &&
            process.env.RANK_CHECK_TEST_DELAY_MS
          ) {
            const delayMs = parseInt(process.env.RANK_CHECK_TEST_DELAY_MS, 10);
            if (!isNaN(delayMs) && delayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, delayMs));
            }
          }

          const countryCode = getIsoCountryCode(ctx.locationCode).toUpperCase();
          const countryName =
            LOCATION_OPTIONS.find((option) => option.code === ctx.locationCode)
              ?.label ?? countryCode;
          const normalizedInput = {
            keyword: task.keyword,
            keywordId: task.keywordId,
            location: {
              countryCode,
              languageCode: ctx.languageCode,
              locationName: ctx.locationName ?? countryName,
            },
            device: task.device,
            targetDomain: ctx.domain,
            depth: ctx.serpDepth,
            isCancelled: async () =>
              (await RankTrackingRepository.getRunById(ctx.runId))?.status ===
              "cancelled",
          };
          const res = ctx.rankSerp
            ? await ctx.rankSerp.search(normalizedInput)
            : await ctx.client.serp
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
                .then((legacy) => ({
                  ...legacy,
                  title: null,
                  domain: null,
                  provider: "dataforseo" as const,
                  inspectedDepth: ctx.serpDepth,
                  calls: [],
                }));
          return {
            task,
            dispatched: true,
            outcome: {
              status: "fulfilled" as const,
              value: { ...res, device: task.device },
            },
          };
        } catch (reason) {
          return {
            task,
            dispatched: true,
            outcome: {
              status: "rejected" as const,
              reason,
            },
          };
        }
      }),
    );

    const chunkSnapshotRows: Array<
      Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
    > = [];

    for (const res of chunkResults) {
      if (!res.dispatched || !res.outcome) continue;
      const { task, outcome } = res;
      distinctKeywordsCheckedSet.add(task.keywordId);
      const prevPos =
        previousPositions.get(`${task.keywordId}:${task.device}`) ?? null;

      if (outcome.status === "fulfilled") {
        const r = outcome.value;
        if (r.calls.length > 0) {
          await RankTrackingRepository.insertProviderCalls(
            r.calls.map((call) => ({
              runId: ctx.runId,
              trackingKeywordId: task.keywordId,
              device: task.device,
              ...call,
            })),
          );
        }
        const isRanked = r.position !== null;
        chunkSnapshotRows.push({
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
          provider: r.provider,
          providerStatus: isRanked
            ? "Ok"
            : `No ranking found in top ${r.inspectedDepth}`,
          providerStatusCode: r.calls.at(-1)?.httpStatus ?? null,
          errorMessage: null,
        });
      } else {
        console.error(
          `[rank-check] ${ctx.runId} live call failed:`,
          outcome.reason,
        );
        const reason = safeProviderReason(outcome.reason);
        const calls =
          outcome.reason instanceof SerpProvidersUnavailableError ||
          outcome.reason instanceof SerpCancelledError
            ? outcome.reason.calls
            : [];
        if (calls.length > 0) {
          await RankTrackingRepository.insertProviderCalls(
            calls.map((call) => ({
              runId: ctx.runId,
              trackingKeywordId: task.keywordId,
              device: task.device,
              ...call,
            })),
          );
        }
        firstError ??= reason;
        const statusCode = parseDataforseoStatusCode(outcome.reason);
        chunkSnapshotRows.push({
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
          provider: calls.at(-1)?.provider ?? "dataforseo",
          providerStatus: reason,
          providerStatusCode: calls.at(-1)?.httpStatus ?? statusCode,
          errorMessage: reason,
        });
      }
    }

    if (chunkSnapshotRows.length > 0) {
      await RankTrackingRepository.insertSnapshots(chunkSnapshotRows);
      totalWritten += chunkSnapshotRows.length;
      // Incrementally update run progress in DB so polling UI sees real-time increments
      if (baseKeywordsChecked !== undefined) {
        await RankTrackingRepository.updateRun(ctx.runId, {
          keywordsChecked:
            baseKeywordsChecked + distinctKeywordsCheckedSet.size,
        });
      }
    }

    // Check if cancellation was requested while chunk was executing
    const postChunkRun = await RankTrackingRepository.getRunById(ctx.runId);
    if (postChunkRun?.status === "cancelled") {
      console.log(
        `[rank-check] ${ctx.runId} cancellation observed after task chunk ${i}; halting further processing`,
      );
      break;
    }
  }

  return {
    written: totalWritten,
    distinctKeywordsChecked: distinctKeywordsCheckedSet.size,
    firstError,
  };
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
  let totalKeywordsChecked = 0;
  for (let i = 0; i < ctx.keywords.length; i += KEYWORDS_PER_BATCH) {
    const runCheck = await RankTrackingRepository.getRunById(ctx.runId);
    if (runCheck?.status === "cancelled") {
      console.log(
        `[rank-check] ${ctx.runId} cancellation observed before batch ${Math.floor(i / KEYWORDS_PER_BATCH)}`,
      );
      break;
    }

    const keywordBatch = ctx.keywords.slice(i, i + KEYWORDS_PER_BATCH);
    const batchTasks = expandToTaskInputs(keywordBatch, ctx.devices);
    const batchIndex = Math.floor(i / KEYWORDS_PER_BATCH);

    const written = await pgStep(
      step,
      `live-batch-${batchIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      async () => {
        const batch = await checkBatchLive(ctx, batchTasks, {
          baseKeywordsChecked: totalKeywordsChecked,
        });
        firstError ??= batch.firstError;
        totalKeywordsChecked += batch.distinctKeywordsChecked;
        // Progress for the UI; finalize recounts from the DB anyway.
        await RankTrackingRepository.updateRun(ctx.runId, {
          keywordsChecked: totalKeywordsChecked,
        });
        return batch.written;
      },
    );

    if (written < batchTasks.length) {
      const activeRun = await RankTrackingRepository.getRunById(ctx.runId);
      if (activeRun?.status === "cancelled") {
        break;
      }
    }
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
    const previousPositions =
      await RankTrackingRepository.getLatestPositionsMap(
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
    const runCheck = await RankTrackingRepository.getRunById(ctx.runId);
    if (runCheck?.status === "cancelled") {
      break;
    }

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

  const runBeforeFallback = await RankTrackingRepository.getRunById(ctx.runId);
  if (runBeforeFallback?.status === "cancelled") return stats;

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
