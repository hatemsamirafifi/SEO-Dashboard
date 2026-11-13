/* eslint-disable max-lines */
import type { WorkflowStep } from "cloudflare:workers";
import type { InferInsertModel } from "drizzle-orm";
import type { rankSnapshots } from "@/db/schema";
import { sanitizeDataforseoMessage } from "@/server/lib/dataforseo/shared";
import { scrubGlobalTraceText } from "@/shared/globalTraceTypes";
import { formatDataforseoTaskErrorMessage } from "@/shared/dataforseoDiagnosticsParser";
import { asAppError } from "@/server/lib/errors";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SerpOrganicSnapshotRepository } from "@/server/features/serp/clustering/SerpOrganicSnapshotRepository";
import type { SerpOrganicSnapshotRow } from "@/server/features/serp/clustering/SerpOrganicSnapshotRepository";
import { organicRowsForResult } from "@/server/features/serp/clustering/organicRows";
import {
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
  runWithDataforseoAccountContext,
} from "@/server/lib/dataforseo";
import type {
  createDataforseoClient,
  PostedRankCheckTask,
  RankCheckResult,
  RankCheckTaskInput,
  RejectedRankCheckTask,
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
  /**
   * The billing customer's scope, whose effective DataForSEO settings the
   * metered task_post ran under. Collection (task_get) binds to this scope so
   * it resolves the SAME account that received the posts — including
   * project-level credential overrides — instead of environment credentials.
   * projectId may be null when the billing context carries no project.
   */
  billingScope: { organizationId: string; projectId: string | null };
}

/** True when the run row is cancelled (missing rows stop the check too). */
async function isRunCancelled(runId: string): Promise<boolean> {
  const run = await RankTrackingRepository.getRunById(runId);
  return run?.status !== "running" && run?.status !== "pending";
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

/**
 * Store the organic results the provider already returned (spec 019).
 *
 * Fully isolated: a failed write is reported on its own and never changes the
 * rank snapshot, the run status, or the provider failure semantics.
 */
async function writeOrganicRows(
  ctx: CheckContext,
  rows: SerpOrganicSnapshotRow[],
): Promise<void> {
  if (rows.length === 0) return;
  try {
    await SerpOrganicSnapshotRepository.insertOrganicSnapshots(rows);
  } catch (error) {
    console.warn(
      `[rank-check] ${ctx.runId} organic snapshot write failed:`,
      error,
    );
  }
}

function organicRowsForResults(
  ctx: CheckContext,
  results: Array<{
    keywordId: string;
    keyword: string;
    device: "desktop" | "mobile";
    provider?: string;
    inspectedDepth?: number;
    organicResults?: Array<{
      position: number;
      title?: string | null;
      url: string;
      domain?: string | null;
    }>;
  }>,
  observedAt: string,
) {
  return results.flatMap((result) =>
    organicRowsForResult({
      projectId: ctx.projectId,
      configId: ctx.configId,
      runId: ctx.runId,
      trackingKeywordId: result.keywordId,
      keyword: result.keyword,
      device: result.device,
      provider: result.provider ?? "dataforseo",
      locationCode: ctx.locationCode,
      locationName: ctx.locationName ?? null,
      languageCode: ctx.languageCode,
      observedAt,
      inspectedDepth: result.inspectedDepth ?? ctx.serpDepth,
      organicResults: result.organicResults ?? [],
    }),
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
          const runCancelled = () => isRunCancelled(ctx.runId);
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
            // Honored by the account gate while waiting for the slot and
            // once more immediately before the actual network dispatch.
            isCancelled: runCancelled,
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
                  isCancelled: runCancelled,
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
    const chunkOrganicResults: Array<{
      keywordId: string;
      keyword: string;
      device: "desktop" | "mobile";
      provider: string;
      inspectedDepth: number;
      organicResults?: Array<{
        position: number;
        title?: string | null;
        url: string;
        domain?: string | null;
      }>;
    }> = [];

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
        chunkOrganicResults.push({
          keywordId: task.keywordId,
          keyword: task.keyword,
          device: task.device,
          provider: r.provider,
          inspectedDepth: r.inspectedDepth,
          organicResults: r.organicResults,
        });
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
        const lastDispatchedCall =
          calls.filter((c) => c.dispatched).at(-1) ?? calls.at(-1);
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
          provider: lastDispatchedCall?.provider ?? "dataforseo",
          providerStatus: reason,
          providerStatusCode: lastDispatchedCall?.httpStatus ?? statusCode,
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

    // Organic results the provider already returned (spec 019). Isolated: a
    // failed write never changes the rank snapshot or the run.
    await writeOrganicRows(
      ctx,
      organicRowsForResults(ctx, chunkOrganicResults, new Date().toISOString()),
    );

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
// minutes on average, so the first check waits 4 minutes; cumulative waits
// are 4 / 6 / 8 / 10 / 12 / 15 minutes, after which anything still pending is
// recorded as uncollected (with diagnostics) — never resubmitted to Live.
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

// Requests now share one account slot. Keep each durable step to two chunks
// so serialized requests fit its timeout and earlier results stay persisted.
const TASK_GETS_PER_COLLECT = 50;

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
  /** Tasks DataForSEO failed, recorded as CHECK_FAILED snapshots this round. */
  failed: PostedRankCheckTask[];
}

/**
 * One queued keyword/device pair that will never produce a queue result,
 * with the sanitized diagnostic to persist against it.
 */
interface UncollectedTaskDiagnostic {
  task: RankCheckTaskInput;
  reason: string;
}

/** Upper bound for a per-pair queue diagnostic kept in a snapshot row. */
const MAX_QUEUE_DIAGNOSTIC_LENGTH = 300;

/** Bound + sanitize a queue diagnostic so it is safe for a snapshot row. */
function queueDiagnostic(reason: string): string {
  const flattened = scrubGlobalTraceText(
    sanitizeDataforseoMessage(reason) ??
      "Queued rank check did not produce a result",
  );
  return flattened.length > MAX_QUEUE_DIAGNOSTIC_LENGTH
    ? `${flattened.slice(0, MAX_QUEUE_DIAGNOSTIC_LENGTH)}…`
    : flattened;
}

/** Snapshot rows for pairs that will never produce a queue result. */
function failedQueueSnapshotRows(
  ctx: CheckContext,
  tasks: Array<{
    keywordId: string;
    keyword: string;
    device: "desktop" | "mobile";
  }>,
  reasons: Map<string, string>,
  previousPositions: Map<string, number | null>,
) {
  const today = new Date().toISOString().slice(0, 10);
  return tasks.map((task) => {
    const reason =
      reasons.get(`${task.keywordId}:${task.device}`) ??
      "DataForSEO task did not produce a result";
    return {
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
      previousPosition:
        previousPositions.get(`${task.keywordId}:${task.device}`) ?? null,
      rankingStatus: "CHECK_FAILED" as const,
      url: null,
      serpFeatures: null,
      provider: "dataforseo",
      providerStatus: reason,
      providerStatusCode: null,
      errorMessage: reason,
    };
  });
}

/**
 * Persist CHECK_FAILED snapshots (with diagnostics) for pairs that will
 * never produce a queue result. Idempotent via the (run, keyword, device)
 * unique index, so workflow step replays are safe.
 */
async function recordUncollectedPairs(
  ctx: CheckContext,
  diagnostics: UncollectedTaskDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  const previousPositions = await RankTrackingRepository.getLatestPositionsMap(
    ctx.configId,
    diagnostics.map((d) => ({
      keywordId: d.task.keywordId,
      device: d.task.device,
    })),
    { excludeRunId: ctx.runId },
  );
  const reasons = new Map(
    diagnostics.map((d) => [
      `${d.task.keywordId}:${d.task.device}`,
      queueDiagnostic(d.reason),
    ]),
  );
  await RankTrackingRepository.insertSnapshots(
    failedQueueSnapshotRows(
      ctx,
      diagnostics.map((d) => d.task),
      reasons,
      previousPositions,
    ),
  );
  // Progress for the UI; finalize recounts keywordsChecked from the DB anyway.
  const snapshots = await RankTrackingRepository.getSnapshotsForRun(ctx.runId);
  await RankTrackingRepository.updateRun(ctx.runId, {
    keywordsChecked: new Set(snapshots.map((s) => s.trackingKeywordId)).size,
  });
}

/**
 * Fetch results for queued tasks (one free task_get each), persist completed
 * snapshots, and update run progress. Transient task_get failures stay
 * pending for the next round. Tasks DataForSEO reports as failed are
 * recorded immediately as CHECK_FAILED snapshots carrying the task's status
 * message — they are never resubmitted anywhere.
 *
 * The whole round runs bound to the billing scope's effective DataForSEO
 * account (runWithDataforseoAccountContext): the metered task_post ran under
 * that scope, so collection must ask the SAME account for the results — a
 * project-level credential override would otherwise leave task_get reading
 * environment credentials that never received the tasks. Collection itself
 * stays unmetered: task_get is free at DataForSEO.
 *
 * Cancellation is honored at every boundary: before each task_get chunk, and
 * inside every gated dispatch (the account gate re-checks immediately before
 * the network call). Remaining tasks stay pending for the cancelled run's
 * finalize step — nothing is dispatched after cancellation.
 */
async function collectQueuedRound(
  ctx: CheckContext,
  tasks: PostedRankCheckTask[],
): Promise<CollectRoundOutcome> {
  return runWithDataforseoAccountContext(ctx.billingScope, async () => {
    const completed: RankCheckResultWithDevice[] = [];
    const stillPending: PostedRankCheckTask[] = [];
    const failed: PostedRankCheckTask[] = [];
    const failedReasons = new Map<string, string>();
    const runCancelled = () => isRunCancelled(ctx.runId);

    for (let i = 0; i < tasks.length; i += TASK_GET_CONCURRENCY) {
      if (await runCancelled()) {
        console.log(
          `[rank-check] ${ctx.runId} cancellation observed between task_get chunks; leaving remaining tasks pending`,
        );
        stillPending.push(...tasks.slice(i));
        break;
      }
      const chunk = tasks.slice(i, i + TASK_GET_CONCURRENCY);
      const settled = await Promise.allSettled(
        chunk.map((task) =>
          fetchRankCheckTaskResult({
            taskId: task.taskId,
            keywordId: task.keywordId,
            keyword: task.keyword,
            targetDomain: ctx.domain,
            isCancelled: runCancelled,
          }),
        ),
      );
      settled.forEach((result, index) => {
        const task = chunk[index];
        if (result.status === "rejected") {
          // Transient fetch failure (or the gate's cancelled/bounded wait)
          // — try again next round.
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
          failedReasons.set(
            `${task.keywordId}:${task.device}`,
            `DataForSEO task failed: ${result.value.message}`,
          );
        } else {
          completed.push({ ...result.value.result, device: task.device });
        }
      });
    }

    const completedPairs = completed.map((r) => ({
      keywordId: r.keywordId,
      device: r.device,
    }));
    const failedPairs = failed.map((t) => ({
      keywordId: t.keywordId,
      device: t.device,
    }));
    const previousPositions =
      completed.length > 0 || failed.length > 0
        ? await RankTrackingRepository.getLatestPositionsMap(
            ctx.configId,
            [...completedPairs, ...failedPairs],
            { excludeRunId: ctx.runId },
          )
        : new Map<string, number | null>();

    if (completed.length > 0) {
      await RankTrackingRepository.insertSnapshots(
        mapResultsToSnapshotRows(ctx, completed, previousPositions),
      );
      // Organic results the provider already returned (spec 019). Isolated: a
      // failed write never changes the rank snapshot or the run.
      await writeOrganicRows(
        ctx,
        organicRowsForResults(ctx, completed, new Date().toISOString()),
      );
    }

    if (failed.length > 0) {
      await RankTrackingRepository.insertSnapshots(
        failedQueueSnapshotRows(ctx, failed, failedReasons, previousPositions),
      );
    }

    if (completed.length > 0 || failed.length > 0) {
      // Progress for the UI; finalize recounts keywordsChecked from the DB anyway.
      const snapshots = await RankTrackingRepository.getSnapshotsForRun(
        ctx.runId,
      );
      await RankTrackingRepository.updateRun(ctx.runId, {
        keywordsChecked: new Set(snapshots.map((s) => s.trackingKeywordId))
          .size,
      });
    }

    return { collected: completed.length, stillPending, failed };
  });
}

/** Per-run accounting for the queued path, in keyword/device task units. */
export interface QueuedCheckStats {
  /** Tasks accepted into DataForSEO's queue. */
  queueTasks: number;
  /** Task results collected from the queue within the polling window. */
  queueCollected: number;
  /** Pairs that never produced a queue result — post failures/rejections,
   *  DataForSEO task failures, or tasks still pending when the window
   *  closed. Recorded as CHECK_FAILED snapshots with diagnostics; never
   *  resubmitted to the Live endpoint. */
  uncollectedTasks: number;
}

/**
 * Post one chunk (one metered, single-attempt step). On failure the chunk is
 * NOT retried and NOT resubmitted to Live: its pairs are recorded as
 * CHECK_FAILED diagnostics (in their own durable step) and the run continues
 * so tasks already accepted by earlier chunks still get collected.
 */
async function postTaskChunk(
  step: WorkflowStep,
  ctx: CheckContext,
  chunk: RankCheckTaskInput[],
  postIndex: number,
  uncollected: UncollectedTaskDiagnostic[],
): Promise<{
  posted: PostedRankCheckTask[];
  rejected: RejectedRankCheckTask[];
} | null> {
  try {
    return await pgStep(
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
          // Honored by the account gate while waiting for the slot and once
          // more immediately before the paid POST goes on the wire.
          isCancelled: () => isRunCancelled(ctx.runId),
        }),
    );
  } catch (error) {
    // The post failed, was cancelled, or timed out — possibly while waiting
    // on the account gate or the network. NO Live fallback and NO retry: a
    // paid POST is never blindly resubmitted. Record diagnostics for the
    // chunk and let the caller keep collecting earlier chunks' tasks.
    console.warn(
      `[rank-check] ${ctx.runId} post-tasks-${postIndex} failed:`,
      error,
    );
    const reason = safeProviderReason(error);
    const chunkDiagnostics = chunk.map((task) => ({
      task,
      reason: `task_post failed: ${reason}`,
    }));
    await pgStep(
      step,
      `record-post-failures-${postIndex}`,
      SINGLE_ATTEMPT_STEP_CONFIG,
      () => recordUncollectedPairs(ctx, chunkDiagnostics),
    );
    uncollected.push(...chunkDiagnostics);
    return null;
  }
}

/**
 * Record per-entry post rejections (and unaccounted pairs from malformed
 * response entries) as CHECK_FAILED snapshots in a durable step, so every
 * rejected pair is visible with its reason — including when the whole run
 * has zero pending tasks left.
 */
async function recordPostRejections(
  step: WorkflowStep,
  ctx: CheckContext,
  postIndex: number,
  diagnostics: UncollectedTaskDiagnostic[],
): Promise<void> {
  if (diagnostics.length === 0) return;
  await pgStep(
    step,
    `record-post-rejections-${postIndex}`,
    SINGLE_ATTEMPT_STEP_CONFIG,
    () => recordUncollectedPairs(ctx, diagnostics),
  );
}

/**
 * Check keywords via DataForSEO's standard task queue (~30% of live cost).
 * Posts every keyword/device pair as a queued task (normal priority, <=100
 * per request), then polls task_get for ~15 minutes, writing snapshots
 * incrementally as tasks complete.
 *
 * Failure policy: bulk queue work NEVER falls back to the Live endpoint. A
 * failed post chunk is recorded as CHECK_FAILED diagnostics for its pairs —
 * and crucially, tasks ALREADY ACCEPTED by earlier chunks keep being
 * collected (they were paid for at task_post). The same applies to tasks
 * DataForSEO fails and to stragglers still pending when the polling window
 * closes. An ambiguous paid POST is never blindly retried (post steps are
 * single-attempt); a run surfaces partial/failure with per-keyword
 * diagnostics instead of success or zero rankings. Billing happens once, at
 * task_post.
 */
export async function runQueuedCheck(
  step: WorkflowStep,
  ctx: CheckContext,
): Promise<QueuedCheckStats> {
  const taskInputs = expandToTaskInputs(ctx.keywords, ctx.devices);

  // Post all tasks to the queue, <=100 per request, one metered step each.
  // A failed chunk must not abort the run — earlier chunks were already
  // charged at DataForSEO, so their results have to be collected.
  let pending: PostedRankCheckTask[] = [];
  const uncollected: UncollectedTaskDiagnostic[] = [];
  for (let i = 0; i < taskInputs.length; i += MAX_TASKS_PER_POST) {
    const chunk = taskInputs.slice(i, i + MAX_TASKS_PER_POST);
    const postIndex = Math.floor(i / MAX_TASKS_PER_POST);

    // Stop posting when the run was cancelled — the remaining pairs are
    // simply not attempted (finalize preserves the cancelled status).
    if (await isRunCancelled(ctx.runId)) {
      console.log(
        `[rank-check] ${ctx.runId} cancellation observed before post-tasks-${postIndex}; halting posts`,
      );
      break;
    }

    const postedResult = await postTaskChunk(
      step,
      ctx,
      chunk,
      postIndex,
      uncollected,
    );
    if (!postedResult) continue;

    pending.push(...postedResult.posted);

    // Pairs DataForSEO rejected at post time (per-entry status) get their
    // own persisted diagnostics; unmappable entries are reconciled so every
    // pair of the chunk is accounted for exactly once — accepted, rejected
    // with a reason, or (malformed response) generically rejected.
    const rejectedByPair = new Map(
      postedResult.rejected
        .filter((r) => r.task !== null)
        .map((r) => [`${r.task!.keywordId}:${r.task!.device}`, r]),
    );
    const rejectionDiagnostics: UncollectedTaskDiagnostic[] = [];
    for (const rejection of rejectedByPair.values()) {
      const detail = rejection.statusMessage
        ? ` ${rejection.statusMessage}`
        : "";
      rejectionDiagnostics.push({
        task: rejection.task!,
        reason: `DataForSEO rejected the task at post${rejection.statusCode ? ` (${rejection.statusCode})` : ""}:${detail}`,
      });
    }
    const accountedPairs = new Set([
      ...postedResult.posted.map((t) => `${t.keywordId}:${t.device}`),
      ...rejectedByPair.keys(),
    ]);
    const unaccounted = chunk.filter(
      (t) => !accountedPairs.has(`${t.keywordId}:${t.device}`),
    );
    if (unaccounted.length > 0) {
      console.warn(
        `[rank-check] ${ctx.runId} post-tasks-${postIndex}: ${unaccounted.length} pair(s) unaccounted after rejection entries`,
      );
      for (const task of unaccounted) {
        rejectionDiagnostics.push({
          task,
          reason: "DataForSEO did not accept the task at post time",
        });
      }
    }
    if (rejectionDiagnostics.length > 0) {
      await recordPostRejections(step, ctx, postIndex, rejectionDiagnostics);
      uncollected.push(...rejectionDiagnostics);
    }
  }

  const stats: QueuedCheckStats = {
    queueTasks: pending.length,
    queueCollected: 0,
    uncollectedTasks: 0,
  };

  // Poll until everything is collected or the ~15 minute window closes. A
  // collect failure (past its retries) leaves that round's tasks pending
  // for the next round — or recorded as uncollected at window close —
  // instead of failing the run; the posted tasks are already paid for.
  for (
    let round = 0;
    round < QUEUED_POLL_INTERVALS.length && pending.length > 0;
    round++
  ) {
    if (await isRunCancelled(ctx.runId)) {
      break;
    }

    await step.sleep(`wait-${round}`, QUEUED_POLL_INTERVALS[round]);

    // Re-check after the durable sleep: a run cancelled during the wait must
    // not wake up and dispatch a collect round.
    if (await isRunCancelled(ctx.runId)) {
      console.log(
        `[rank-check] ${ctx.runId} cancellation observed after wait-${round}`,
      );
      break;
    }

    const roundTasks = pending;
    pending = [];
    for (
      let offset = 0;
      offset < roundTasks.length;
      offset += TASK_GETS_PER_COLLECT
    ) {
      if (await isRunCancelled(ctx.runId)) {
        pending.push(...roundTasks.slice(offset));
        break;
      }
      const batch = roundTasks.slice(offset, offset + TASK_GETS_PER_COLLECT);
      const batchIndex = Math.floor(offset / TASK_GETS_PER_COLLECT);
      const stepName = `collect-${round}-${batchIndex}`;
      let outcome: CollectRoundOutcome;
      try {
        outcome = await pgStep(step, stepName, COLLECT_STEP_CONFIG, () =>
          collectQueuedRound(ctx, batch),
        );
      } catch (error) {
        console.warn(`[rank-check] ${ctx.runId} ${stepName} failed:`, error);
        pending.push(...batch);
        continue;
      }
      stats.queueCollected += outcome.collected;
      pending.push(...outcome.stillPending);
      stats.uncollectedTasks += outcome.failed.length;
    }
  }

  // Window closed (or nothing left). Stragglers still pending are recorded
  // as uncollected with diagnostics — never resubmitted to the Live
  // endpoint. Skipped entirely for a cancelled run: finalize preserves the
  // cancelled status and counts only what was actually collected.
  if (pending.length > 0 && !(await isRunCancelled(ctx.runId))) {
    console.log(
      `[rank-check] ${ctx.runId} polling window closed with ${pending.length} task(s) not collected`,
    );
    const stragglerDiagnostics: UncollectedTaskDiagnostic[] = pending.map(
      (task) => ({
        task,
        reason:
          "Queued task was not collected within the polling window (still in DataForSEO's queue)",
      }),
    );
    await pgStep(step, "record-uncollected-tasks", COLLECT_STEP_CONFIG, () =>
      recordUncollectedPairs(ctx, stragglerDiagnostics),
    );
    stats.uncollectedTasks += stragglerDiagnostics.length;
    pending = [];
  }

  stats.uncollectedTasks += uncollected.length;
  return stats;
}
