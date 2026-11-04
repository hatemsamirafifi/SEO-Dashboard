import { z } from "zod";
import {
  SerpApiStopCrawlOnMatchInfo,
  SerpGoogleLocalFinderLiveAdvancedRequestInfo,
  SerpGoogleMapsLiveAdvancedRequestInfo,
  SerpGoogleOrganicLiveAdvancedRequestInfo,
  SerpGoogleOrganicTaskPostRequestInfo,
} from "dataforseo-client";
import {
  serpApi,
  resolveDataforseoAccountBinding,
} from "@/server/lib/dataforseo/core";
import { runWithDataforseoContext } from "@/server/lib/dataforseo/context";
import {
  withDataforseoAccountRequest,
  type DataforseoRankCheckRequestKind,
} from "@/server/features/rank-tracking/services/dataforseoAccountGate";
import { MAX_TASKS_PER_POST } from "@/server/lib/dataforseo/shared";
import {
  assertOk,
  buildTaskBilling,
  isNoResultsTask,
  parseTaskItems,
  type DataforseoApiResponse,
} from "@/server/lib/dataforseo/envelope";
import { AppError } from "@/server/lib/errors";

/** DataForSEO bills SERPs in pages of 10; depth outside 10-100 is rejected. */
function clampSerpDepth(depth: number): number {
  return Math.min(100, Math.max(10, depth));
}

/**
 * Stop crawling SERP pages once the target domain is found — DataForSEO only
 * bills the pages crawled, so a page-1 ranking at depth 20 costs one page
 * instead of two. Matching is restricted to organic results and uses
 * with_subdomains, mirroring buildRankCheckResult exactly: without
 * find_targets_in, a sitelink or PAA mention could stop the crawl before the
 * domain's organic listing and record a false "not ranking".
 */
function stopCrawlOnTarget(targetDomain: string) {
  return {
    stop_crawl_on_match: [
      new SerpApiStopCrawlOnMatchInfo({
        match_value: targetDomain,
        match_type: "with_subdomains",
      }),
    ],
    find_targets_in: ["organic"],
  };
}

// Kept as a hand-written schema: the SDK's BaseSerpApiElementItem type omits
// etv / estimated_paid_traffic_cost / backlinks_info / rank_changes, which we
// rely on. The fields survive deserialization (the SDK copies unknown keys), so
// validating here is both our type-safety guard and how we read those fields.
const serpSnapshotItemSchema = z
  .object({
    type: z.string(),
    rank_group: z.number().nullable().optional(),
    rank_absolute: z.number().nullable().optional(),
    domain: z.string().nullable().optional(),
    title: z.string().nullable().optional(),
    url: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    breadcrumb: z.string().nullable().optional(),
    etv: z.number().nullable().optional(),
    estimated_paid_traffic_cost: z.number().nullable().optional(),
    backlinks_info: z
      .object({
        referring_domains: z.number().nullable().optional(),
        backlinks: z.number().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
    rank_changes: z
      .object({
        previous_rank_absolute: z.number().nullable().optional(),
        is_new: z.boolean().nullable().optional(),
        is_up: z.boolean().nullable().optional(),
        is_down: z.boolean().nullable().optional(),
      })
      .passthrough()
      .nullable()
      .optional(),
  })
  .passthrough();

export type SerpLiveItem = z.infer<typeof serpSnapshotItemSchema>;

export async function fetchLiveSerp(input: {
  keyword: string;
  locationCode: number;
  languageCode: string;
}): Promise<DataforseoApiResponse<SerpLiveItem[]>> {
  const response = await serpApi().googleOrganicLiveAdvanced([
    new SerpGoogleOrganicLiveAdvancedRequestInfo({
      keyword: input.keyword,
      location_code: input.locationCode,
      language_code: input.languageCode,
      device: "desktop",
      os: "windows",
      depth: 100,
    }),
  ]);
  const task = assertOk(response);
  return {
    data: parseTaskItems(
      "google-organic-live-advanced",
      task,
      serpSnapshotItemSchema,
    ),
    billing: buildTaskBilling(task),
  };
}

export interface RankCheckOrganicEntry {
  position: number;
  title: string | null;
  url: string;
  domain: string;
}

/**
 * Async liveness probe honored by every coordinated rank-check dispatch
 * (Live, task_post, task_get): checked while waiting for the account slot
 * and once more immediately after acquiring, so a cancelled run's request
 * is never sent. Never called mid-dispatch — it cannot abort a request
 * that is already on the wire.
 */
export interface RankCheckDispatchCancellation {
  isCancelled?: () => Promise<boolean>;
}

/**
 * Run one rank-check SDK dispatch through the account coordination gate.
 *
 * ONE credential resolution decides BOTH the coordinated account (SHA-256 of
 * the effective login) and the pinned credentials for the dispatch: the
 * resolved pair is re-bound around the gated SDK call, so the request can
 * only ever run as the account the slot was acquired for — settings drift
 * while waiting on the slot cannot redirect it to a different account. (A
 * raw API key that does not decode to login:password has no pair to pin; the
 * fetch's own env resolution applies, which is where the hash came from.)
 *
 * The gate bounds the wait, honors cancellation (signal / isCancelled),
 * fails closed when coordination storage errors, and always releases.
 */
async function gatedAccountDispatch<T>(
  kind: DataforseoRankCheckRequestKind,
  cancellation: RankCheckDispatchCancellation,
  sdkCall: () => Promise<T>,
): Promise<T> {
  const binding = await resolveDataforseoAccountBinding();
  return withDataforseoAccountRequest(
    binding.accountHash,
    kind,
    () => {
      if (!binding.login || !binding.password) return sdkCall();
      return runWithDataforseoContext(
        { login: binding.login, password: binding.password },
        sdkCall,
      );
    },
    { isCancelled: cancellation.isCancelled },
  );
}

/** Organic results kept per keyword and device (spec 019). */
const MAX_ORGANIC_CAPTURE = 10;

export interface RankCheckResult {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  serpFeatures: string[];
  /**
   * The organic results the provider already returned (top 10, observed
   * only). The rank check paid for them, so they are captured here instead of
   * asking the provider again.
   */
  organicResults?: RankCheckOrganicEntry[];
}

function buildRankCheckResult(
  input: { keywordId: string; keyword: string; targetDomain: string },
  items: SerpLiveItem[],
): RankCheckResult {
  const target = input.targetDomain.toLowerCase();
  const organicMatch = items.find((item) => {
    if (item.type !== "organic" || item.domain == null) return false;
    const domain = item.domain.toLowerCase();
    return domain === target || domain.endsWith(`.${target}`);
  });
  const organicResults: RankCheckOrganicEntry[] = [];
  for (const item of items) {
    if (item.type !== "organic") continue;
    const url = item.url;
    const domain = item.domain;
    if (!url || !domain) continue;
    const position = item.rank_group ?? item.rank_absolute;
    if (!position) continue;
    organicResults.push({
      position,
      title: item.title ?? null,
      url,
      domain,
    });
  }
  organicResults.sort((a, b) => a.position - b.position);

  return {
    keywordId: input.keywordId,
    keyword: input.keyword,
    // rank_group = position among organic results only (what users count as
    // "my ranking"). rank_absolute would also count SERP features (local
    // pack, PAA, AI overviews) and reads as worse than what users see.
    position: organicMatch
      ? (organicMatch.rank_group ?? organicMatch.rank_absolute ?? null)
      : null,
    url: organicMatch?.url ?? null,
    serpFeatures: [...new Set(items.map((item) => item.type).filter(Boolean))],
    organicResults: organicResults.slice(0, MAX_ORGANIC_CAPTURE),
  };
}

export async function fetchRankCheckSerp(
  input: {
    keyword: string;
    keywordId: string;
    locationCode: number;
    languageCode: string;
    locationName?: string;
    device: "desktop" | "mobile";
    targetDomain: string;
    depth: number;
  } & RankCheckDispatchCancellation,
): Promise<DataforseoApiResponse<RankCheckResult>> {
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  // The single-keyword Live rank check is a paid, account-scoped dispatch:
  // it goes through the same account coordination gate as the queue paths so
  // concurrent projects sharing one DataForSEO account cannot multiply its
  // outbound request concurrency.
  const response = await gatedAccountDispatch("live_rank_check", input, () =>
    serpApi().googleOrganicLiveAdvanced([
      new SerpGoogleOrganicLiveAdvancedRequestInfo({
        keyword: input.keyword,
        ...locationParams,
        language_code: input.languageCode,
        device: input.device,
        os: input.device === "desktop" ? "windows" : "android",
        depth,
        ...stopCrawlOnTarget(input.targetDomain),
      }),
    ]),
  );

  // "No Search Results" (40501) is valid for obscure/new keywords — treat as an
  // empty result set rather than failing the whole rank-tracking run.
  const task = assertOk(response, { treatNoResultsAsEmpty: true });
  const items = parseTaskItems(
    "google-organic-live-advanced",
    task,
    serpSnapshotItemSchema,
  );

  return {
    data: buildRankCheckResult(input, items),
    billing: buildTaskBilling(task),
  };
}

// ---------------------------------------------------------------------------
// Task-queue rank checks (bulk runs). DataForSEO's standard queue costs
// ~30% of the live endpoint; tasks complete in ~5 minutes on average. The flow
// is task_post (charged) -> poll task_get (free), orchestrated by the rank
// check workflow. Queue outcomes that never produce a result (rejections,
// failures, or tasks still pending when the polling window closes) are
// surfaced as per-keyword diagnostics — bulk queue work is NEVER resubmitted
// to the Live endpoint.
// ---------------------------------------------------------------------------

export interface RankCheckTaskInput {
  keyword: string;
  keywordId: string;
  device: "desktop" | "mobile";
}

export interface PostedRankCheckTask extends RankCheckTaskInput {
  taskId: string;
}

/** A keyword/device pair DataForSEO refused at task_post, with its reason. */
export interface RejectedRankCheckTask {
  /** The pair DataForSEO rejected; null when the response entry's tag could
   *  not be mapped back to a submitted pair (malformed response). */
  task: RankCheckTaskInput | null;
  /** DataForSEO's task-level status_code for the rejected entry, when present. */
  statusCode: number | null;
  /** Sanitized, bounded status message ("Task Limit Exceeded", ...). */
  statusMessage: string | null;
}

/** Result of one task_post batch: accepted tasks plus rejected pairs. */
export interface PostRankCheckTasksResult {
  posted: PostedRankCheckTask[];
  rejected: RejectedRankCheckTask[];
}

export async function postRankCheckTasks(
  input: {
    tasks: RankCheckTaskInput[];
    locationCode: number;
    languageCode: string;
    locationName?: string;
    depth: number;
    targetDomain: string;
  } & RankCheckDispatchCancellation,
): Promise<DataforseoApiResponse<PostRankCheckTasksResult>> {
  if (input.tasks.length === 0 || input.tasks.length > MAX_TASKS_PER_POST) {
    throw new AppError(
      "INTERNAL_ERROR",
      `task_post accepts 1-${MAX_TASKS_PER_POST} tasks, got ${input.tasks.length}`,
    );
  }
  const depth = clampSerpDepth(input.depth);
  const locationParams = input.locationName
    ? { location_name: input.locationName }
    : { location_code: input.locationCode };
  // task_post is a PAID, account-scoped dispatch: it goes through the
  // account coordination gate so concurrent projects sharing one DataForSEO
  // account cannot multiply outbound request concurrency. A wait that times
  // out or is cancelled never dispatches (the caller records diagnostics
  // for the unposted pairs; it never blindly retries an ambiguous paid POST).
  const response = await gatedAccountDispatch("task_post", input, () =>
    serpApi().googleOrganicTaskPost(
      input.tasks.map(
        (task) =>
          new SerpGoogleOrganicTaskPostRequestInfo({
            keyword: task.keyword,
            ...locationParams,
            language_code: input.languageCode,
            device: task.device,
            os: task.device === "desktop" ? "windows" : "android",
            depth,
            // Standard Queue at normal priority (1) — never priority_high,
            // which DataForSEO bills at a premium.
            priority: 1,
            // Queued tasks are billed provisionally at full depth at post time;
            // task_get later reports the reduced actual cost when the crawl
            // stopped early. We meter customers on the post-time amount —
            // collection-time metering is a possible future optimization.
            ...stopCrawlOnTarget(input.targetDomain),
            // Echoed back on the response entry and task_get; used to map a
            // DataForSEO task id back to our keyword without relying on order.
            tag: `${task.keywordId}:${task.device}`,
          }),
      ),
    ),
  );

  if (!response || response.status_code !== 20000) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO task_post failed",
    );
  }

  // One response entry per submitted task; accepted entries have status 20100
  // "Task Created" and their own cost (charged at post time). Cost is summed
  // over every entry — accepted or not — so anything DataForSEO charged is
  // metered. Rejected pairs are returned (not silently dropped) so the
  // workflow can record per-keyword diagnostics; bulk queue rejections are
  // NEVER resubmitted to the Live endpoint.
  const byTag = new Map(
    input.tasks.map((task) => [`${task.keywordId}:${task.device}`, task]),
  );
  const posted: PostedRankCheckTask[] = [];
  const rejected: RejectedRankCheckTask[] = [];
  let costUsd = 0;
  for (const entry of response.tasks ?? []) {
    costUsd += entry.cost ?? 0;
    const tag: unknown = entry.data?.tag;
    const task = typeof tag === "string" ? byTag.get(tag) : undefined;
    if (entry.status_code !== 20100 || !entry.id || !task) {
      console.warn(
        `dataforseo.task_post.rejected-entry (${entry.status_code}): ${entry.status_message}`,
      );
      rejected.push({
        // Null task = unmappable tag; the caller reconciles the chunk so no
        // pair is ever silently lost (unaccounted pairs get a generic
        // rejection diagnostic).
        task: task ?? null,
        statusCode: entry.status_code ?? null,
        statusMessage:
          typeof entry.status_message === "string" && entry.status_message
            ? entry.status_message.slice(0, 300)
            : null,
      });
      continue;
    }
    posted.push({ ...task, taskId: entry.id });
  }

  return {
    data: { posted, rejected },
    billing: {
      path: ["v3", "serp", "google", "organic", "task_post"],
      costUsd,
    },
  };
}

type RankCheckTaskOutcome =
  | { status: "pending" }
  | { status: "failed"; message: string }
  | { status: "completed"; result: RankCheckResult };

// Task lifecycle codes meaning "not done yet": Task Created / Task Handed /
// Task In Queue.
const TASK_IN_PROGRESS_STATUS_CODES = new Set([20100, 40601, 40602]);

/**
 * Collect one queued task's result. Deliberately not metered and not wrapped
 * in the billing envelope: collection is free (the task was charged at
 * task_post), and the task_get response carries the task's settled cost
 * (reduced when stop_crawl_on_match ended the crawl early) — running it
 * through the metering seam would charge the customer twice.
 */
export async function fetchRankCheckTaskResult(
  input: {
    taskId: string;
    keywordId: string;
    keyword: string;
    targetDomain: string;
  } & RankCheckDispatchCancellation,
): Promise<RankCheckTaskOutcome> {
  // task_get is free at DataForSEO but still an account-scoped HTTP
  // dispatch: it shares the account coordination gate (and the account's
  // request budget) with the paid paths. Callers wrap it in
  // runWithDataforseoAccountContext so it resolves the same effective
  // account the metered task_post used — including project-level credential
  // overrides — instead of falling back to environment credentials.
  const response = await gatedAccountDispatch("task_get", input, () =>
    serpApi().googleOrganicTaskGetAdvanced(input.taskId),
  );
  const task = response?.tasks?.[0];
  if (!response || response.status_code !== 20000 || !task) {
    throw new AppError(
      "INTERNAL_ERROR",
      response?.status_message || "DataForSEO task_get failed",
    );
  }

  if (
    task.status_code !== undefined &&
    TASK_IN_PROGRESS_STATUS_CODES.has(task.status_code)
  ) {
    return { status: "pending" };
  }

  if (task.status_code !== 20000) {
    // "No Search Results" is valid for obscure/new keywords — same treatment
    // as the live path's treatNoResultsAsEmpty.
    if (!isNoResultsTask(task)) {
      return {
        status: "failed",
        message:
          task.status_message || `DataForSEO task failed (${task.status_code})`,
      };
    }
    return {
      status: "completed",
      result: buildRankCheckResult(input, []),
    };
  }

  const items = parseTaskItems(
    "google-organic-task-get-advanced",
    task,
    serpSnapshotItemSchema,
  );
  return { status: "completed", result: buildRankCheckResult(input, items) };
}

export async function fetchLocalSerp(input: {
  keyword: string;
  locationCoordinate?: string;
  languageCode: string;
  searchType: "maps" | "local_finder";
  device: "desktop" | "mobile";
  depth: number;
  searchPlaces?: boolean;
}): Promise<DataforseoApiResponse<Record<string, unknown>[]>> {
  const os = input.device === "desktop" ? "windows" : "android";

  // Maps and Local Finder return different SDK item models; both carry an index
  // signature, so the typed items assign cleanly to the generic row shape.
  if (input.searchType === "maps") {
    const response = await serpApi().googleMapsLiveAdvanced([
      new SerpGoogleMapsLiveAdvancedRequestInfo({
        keyword: input.keyword,
        location_coordinate: input.locationCoordinate,
        language_code: input.languageCode,
        device: input.device,
        os,
        depth: input.depth,
        search_places: input.searchPlaces,
      }),
    ]);
    const task = assertOk(response);
    return {
      data: task.result?.[0]?.items ?? [],
      billing: buildTaskBilling(task),
    };
  }

  const response = await serpApi().googleLocalFinderLiveAdvanced([
    new SerpGoogleLocalFinderLiveAdvancedRequestInfo({
      keyword: input.keyword,
      location_coordinate: input.locationCoordinate,
      language_code: input.languageCode,
      device: input.device,
      os,
      depth: input.depth,
    }),
  ]);
  const task = assertOk(response);
  return {
    data: task.result?.[0]?.items ?? [],
    billing: buildTaskBilling(task),
  };
}
