import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  SEO_DATA_COST_MARKUP,
  roundUsdForBilling,
} from "./billing";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

// ---------------------------------------------------------------------------
// Cost constants
// ---------------------------------------------------------------------------

/** Scheduled Pilot Constants (Single source of truth for pilot scope vs capacity) */
export const APPROVED_PILOT_CONFIG_ID = "2971425d-d350-4ee3-89b2-c83567c87713";
export const APPROVED_PILOT_PROJECT_ID = "367587e1-0c77-4d58-a2f8-7d7a171adfcb";
export const APPROVED_PILOT_KEYWORD_IDS = [
  "28131aad-fe42-43b6-bfdb-5fe0d7e046a3", // إنشاء ملاعب متعددة الأغراض
  "4bb3e3ac-3c10-464f-ae90-6c7b13b9c984", // ملعب كرة قدم خماسي
  "728c64ca-83f0-4bf7-8470-b4deea18595a", // مساحة ملعب خماسي
  "2edf9ce7-4ed0-4bae-b7b5-c1ce19bc3305", // ملاعب الخماسي
  "88c5e577-1bc7-4b58-863e-265f60fb3924", // تكلفة ملعب خماسي
  "26b1d63b-f304-42c1-9916-4552a290ee20", // ترتان صناعي
] as const;
export const APPROVED_PILOT_KEYWORD_ID = APPROVED_PILOT_KEYWORD_IDS[0];
export const APPROVED_PILOT_REMOTE_SITE_ID = 13188608;
export const APPROVED_PILOT_REMOTE_KEYWORD_ID = "24606031";
export const APPROVED_PILOT_DESKTOP_ENGINE_ID = 539194;
export const APPROVED_PILOT_MOBILE_ENGINE_ID = 545914;
export const APPROVED_PILOT_TARGET_IDS = [
  "e06e6d4a-59cb-4a5a-960e-d8910552f735", // Desktop
  "911aa14a-b8a7-4c06-8b5d-365ed93ae03b", // Mobile
] as const;

/** DataForSEO Live API: cost of first page (10 results) */
const LIVE_BASE_PAGE_COST_USD = 0.002;

/** DataForSEO Live API: cost of each additional page (75% of base) */
const LIVE_EXTRA_PAGE_COST_USD = 0.0015;

/** DataForSEO task queue (standard priority): cost of first page (10 results) */
const QUEUED_BASE_PAGE_COST_USD = 0.0006;

/** DataForSEO task queue (standard priority): cost of each additional page (75% of base) */
const QUEUED_EXTRA_PAGE_COST_USD = 0.00045;

/**
 * How a rank check reaches DataForSEO: "live" is the instant endpoint used for
 * an explicitly manual check of a single keyword; "queued" is the cheaper
 * task queue used for scheduled checks and manual bulk checks.
 */
export type RankCheckMethod = "live" | "queued";

/**
 * Resolve the dispatch method for a rank check from its trigger and the
 * ACTUAL scoped/eligible keyword count (after selection and missing-ranking
 * filters — never the pre-filter selection size).
 *
 *  - scheduled: always the Standard Queue (bulk out of Live by design);
 *  - manual with exactly ONE keyword: the Live endpoint (instant result);
 *  - manual with MORE than one keyword: the Standard Queue.
 *
 * One keyword with both devices still counts as ONE keyword — the device
 * expansion happens after method selection. This helper is the single source
 * of truth shared by the workflow's execution branch, the server credit
 * precheck, and the client's cost/time copy, so all three always agree.
 */
export function resolveRankCheckMethod(
  trigger: "manual" | "scheduled",
  scopedKeywordCount: number,
): RankCheckMethod {
  if (trigger === "scheduled") return "queued";
  return scopedKeywordCount === 1 ? "live" : "queued";
}

/** User-facing copy for how long a QUEUED (Standard Queue) check takes.
 *  The workflow polls DataForSEO's queue on a ~15-minute window (first
 *  collection pass ~4 minutes in), so instant-results copy must never be
 *  shown for queued bulk checks. */
export const QUEUED_RESULTS_WINDOW_TEXT = "Results in ~5–15 min";

/** How many keywords are checked per batch */
export const KEYWORDS_PER_BATCH = 10;

/** Approximate seconds per batch */
export const SECONDS_PER_BATCH = 6;

/** Maximum keywords allowed per rank tracking config */
export const MAX_KEYWORDS_PER_CONFIG = 1000;

/** Maximum length of a single tracked keyword */
export const MAX_TRACKED_KEYWORD_LENGTH = 200;

/** Maximum configs (domain+location combos) per project */
export const MAX_CONFIGS_PER_PROJECT = 500;

// ---------------------------------------------------------------------------
// Cost estimation
// ---------------------------------------------------------------------------

/** DataForSEO cost for a single SERP request at the given depth. */
function costPerSerpAtDepth(depth: number, method: RankCheckMethod): number {
  const pages = depth / 10;
  return method === "queued"
    ? QUEUED_BASE_PAGE_COST_USD + (pages - 1) * QUEUED_EXTRA_PAGE_COST_USD
    : LIVE_BASE_PAGE_COST_USD + (pages - 1) * LIVE_EXTRA_PAGE_COST_USD;
}

export function depthToPages(depth: number): number {
  return depth / 10;
}

export function pagesToDepth(pages: number): number {
  return pages * 10;
}

export function estimateRankCheckCredits(
  keywordCount: number,
  devices: RankTrackingConfig["devices"],
  depth: number,
  method: RankCheckMethod,
  totalChecksOverride?: number,
) {
  const totalChecks =
    typeof totalChecksOverride === "number"
      ? totalChecksOverride
      : keywordCount * devicesCount(devices);
  const costUsd = roundUsdForBilling(
    totalChecks * costPerSerpAtDepth(depth, method) * SEO_DATA_COST_MARKUP,
  );
  const costCredits = Math.ceil(costUsd * AUTUMN_SEO_DATA_CREDITS_PER_USD);
  return { costUsd, costCredits };
}

// ---------------------------------------------------------------------------
// Schedule
// ---------------------------------------------------------------------------

type ScheduledRankTrackingInterval = Exclude<
  RankTrackingConfig["scheduleInterval"],
  "manual"
>;

export function isScheduledRankTrackingInterval(
  interval: RankTrackingConfig["scheduleInterval"],
): interval is ScheduledRankTrackingInterval {
  return interval !== "manual";
}

function endOfMonthWithTime(source: Date, monthOffset = 0): Date {
  const endOfMonth = new Date(
    Date.UTC(
      source.getUTCFullYear(),
      source.getUTCMonth() + monthOffset + 1,
      0,
    ),
  );
  endOfMonth.setUTCHours(
    source.getUTCHours(),
    source.getUTCMinutes(),
    source.getUTCSeconds(),
    source.getUTCMilliseconds(),
  );
  return endOfMonth;
}

/** Minimum spacing between completed/partial weekly scheduled runs (6 days). */
export const WEEKLY_SCHEDULE_MIN_SPACING_MS = 6 * 86_400_000;

/**
 * Parse an ISO-8601 or SQLite UTC datetime string (`YYYY-MM-DD HH:MM:SS`)
 * into UTC epoch milliseconds without shifting by host local timezone.
 */
export function parseUtcTimestampMs(
  timestamp: string | null | undefined,
): number {
  if (!timestamp) return Number.NaN;
  const trimmed = timestamp.trim();
  if (!trimmed) return Number.NaN;

  // SQLite `datetime('now')` omits timezone designators; normalize to explicit UTC (`Z`).
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    return Date.parse(`${trimmed.replace(" ", "T")}Z`);
  }
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?$/.test(trimmed)) {
    return Date.parse(`${trimmed}Z`);
  }
  return Date.parse(trimmed);
}

/**
 * Compute the next check time for a scheduled config.
 *
 * If `previousNextCheckAt` is provided, advances from that anchor by the
 * interval until the result is strictly in the future and at least
 * `minEligibleMs` (when supplied, e.g. the 6-day weekly minimum spacing
 * boundary). This prevents schedule drift when runs are delayed and prevents
 * landing on an intermediate date that the spacing guard would immediately skip.
 *
 * Otherwise a random hour (04–09 UTC) and minute are chosen.
 */
export function computeNextCheckAt(
  interval: ScheduledRankTrackingInterval,
  previousNextCheckAt?: string | null,
  options?: { nowMs?: number; minEligibleMs?: number },
): string {
  const now = options?.nowMs ?? Date.now();
  const minEligibleMs = options?.minEligibleMs ?? 0;

  if (interval === "monthly") {
    if (previousNextCheckAt) {
      const anchor = new Date(previousNextCheckAt);
      let monthOffset = 1;
      let nextDate = endOfMonthWithTime(anchor, monthOffset);
      while (nextDate.getTime() <= now || nextDate.getTime() < minEligibleMs) {
        monthOffset += 1;
        nextDate = endOfMonthWithTime(anchor, monthOffset);
      }
      return nextDate.toISOString();
    }

    const hour = 4 + Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    const nextDate = endOfMonthWithTime(new Date(now));
    nextDate.setUTCHours(hour, minute, 0, 0);
    if (nextDate.getTime() <= now || nextDate.getTime() < minEligibleMs) {
      const followingMonth = endOfMonthWithTime(nextDate, 1);
      followingMonth.setUTCHours(hour, minute, 0, 0);
      return followingMonth.toISOString();
    }
    return nextDate.toISOString();
  }

  const daysAhead = interval === "daily" ? 1 : 7;

  if (previousNextCheckAt) {
    const anchorMs = parseUtcTimestampMs(previousNextCheckAt);
    const anchor = Number.isFinite(anchorMs)
      ? anchorMs
      : new Date(previousNextCheckAt).getTime();
    const intervalMs = daysAhead * 86_400_000;
    const minTargetExclusiveMs = Math.max(now, minEligibleMs - 1);
    const steps =
      Math.floor(Math.max(0, minTargetExclusiveMs - anchor) / intervalMs) + 1;
    let candidate = anchor + steps * intervalMs;
    while (candidate <= now || candidate < minEligibleMs) {
      candidate += intervalMs;
    }
    return new Date(candidate).toISOString();
  }

  const nextDate = new Date(Math.max(now, minEligibleMs));
  nextDate.setUTCDate(nextDate.getUTCDate() + daysAhead);
  const hour = 4 + Math.floor(Math.random() * 6);
  const minute = Math.floor(Math.random() * 60);
  nextDate.setUTCHours(hour, minute, 0, 0);
  return nextDate.toISOString();
}

/**
 * Returns the next genuinely eligible scheduled execution timestamp for a
 * config, accounting for the weekly 6-day minimum spacing guard driven ONLY by
 * prior `trigger = 'scheduled'` runs (manual checks & manual imports excluded).
 */
export function resolveEligibleNextCheckAt(input: {
  scheduleInterval: RankTrackingConfig["scheduleInterval"];
  isActive: boolean;
  nextCheckAt: string | null;
  lastScheduledAt?: string | null;
  nowMs?: number;
}): string | null {
  if (!input.isActive || !input.nextCheckAt) {
    return input.nextCheckAt;
  }
  if (input.scheduleInterval !== "weekly" || !input.lastScheduledAt) {
    return input.nextCheckAt;
  }

  const lastScheduledMs = parseUtcTimestampMs(input.lastScheduledAt);
  const nextCheckMs = parseUtcTimestampMs(input.nextCheckAt);
  if (!Number.isFinite(lastScheduledMs) || !Number.isFinite(nextCheckMs)) {
    return input.nextCheckAt;
  }

  const minEligibleMs = lastScheduledMs + WEEKLY_SCHEDULE_MIN_SPACING_MS;
  if (nextCheckMs >= minEligibleMs) {
    return input.nextCheckAt;
  }

  return computeNextCheckAt("weekly", input.nextCheckAt, {
    nowMs: input.nowMs ?? Date.now(),
    minEligibleMs,
  });
}

// ---------------------------------------------------------------------------
// Display labels
// ---------------------------------------------------------------------------

export function devicesLabel(devices: RankTrackingConfig["devices"]): string {
  if (devices === "both") return "Desktop + Mobile";
  return devices === "desktop" ? "Desktop" : "Mobile";
}

export function scheduleLabel(
  interval: RankTrackingConfig["scheduleInterval"],
): string {
  if (interval === "daily") return "Daily";
  if (interval === "weekly") return "Weekly";
  if (interval === "monthly") return "Monthly";
  return "Manual";
}

export function devicesCount(devices: RankTrackingConfig["devices"]): number {
  return devices === "both" ? 2 : 1;
}

// ---------------------------------------------------------------------------
// Missing-ranking eligibility ("Check missing rankings" bulk action)
// ---------------------------------------------------------------------------

/** User-visible missing-ranking buckets for the bulk action breakdown. */
export type MissingRankingBucket =
  | "ranking_unavailable"
  | "lost"
  | "no_ranking";

export const MISSING_RANKING_BUCKETS: readonly MissingRankingBucket[] = [
  "ranking_unavailable",
  "lost",
  "no_ranking",
] as const;

export const MISSING_RANKING_BUCKET_LABELS: Record<
  MissingRankingBucket,
  string
> = {
  ranking_unavailable: "Ranking unavailable",
  lost: "Lost",
  no_ranking: "No ranking",
};

export interface MissingRankingsBreakdown {
  ranking_unavailable: number;
  lost: number;
  no_ranking: number;
}

/**
 * Persisted ranking state for one (keyword, device) pair, derived from the
 * keyword's latest snapshot row — never from rendered UI strings.
 *
 * The three missing states stay semantically distinct:
 * - "ranking_unavailable": the latest check attempt could not determine a
 *   position (CHECK_FAILED). Retrying the check is the point of the action.
 * - "lost": previously ranked; the latest valid observation no longer finds
 *   the target within the tracked SERP depth.
 * - "no_ranking": a successful SERP inspection found no ranking (NO_RESULT,
 *   legacy rows), or the pair has never been checked.
 */
export type DeviceRankingState =
  | "ranked"
  | MissingRankingBucket
  | "not_checked";

export interface DeviceRankingFacts {
  /** A snapshot exists for this pair in any terminal run. */
  hasSnapshot: boolean;
  position: number | null;
  previousPosition?: number | null;
  rankingStatus?:
    | "RANKED"
    | "NO_RESULT"
    | "CHECK_FAILED"
    | "NOT_CHECKED"
    | null;
}

/**
 * Classify one (keyword, device) pair from its latest snapshot row. Mirrors
 * the table's rendering semantics: CHECK_FAILED renders "Ranking unavailable"
 * (even when a last valid position exists), a position renders "#N", and a
 * null position with a previous position renders "lost".
 */
export function classifyDeviceRankingState(
  facts: DeviceRankingFacts,
): DeviceRankingState {
  if (!facts.hasSnapshot) return "not_checked";
  if (facts.rankingStatus === "CHECK_FAILED") return "ranking_unavailable";
  if (typeof facts.position === "number") return "ranked";
  if (typeof facts.previousPosition === "number") return "lost";
  return "no_ranking";
}

export function isMissingRankingState(state: DeviceRankingState): boolean {
  return state !== "ranked";
}

/** Collapse a missing state into its breakdown bucket ("not checked" reports as no ranking). */
export function missingRankingBucket(
  state: DeviceRankingState,
): MissingRankingBucket {
  return state === "not_checked"
    ? "no_ranking"
    : state === "ranked"
      ? "no_ranking"
      : state;
}

const MISSING_BUCKET_PRIORITY: Record<MissingRankingBucket, number> = {
  ranking_unavailable: 0,
  lost: 1,
  no_ranking: 2,
};

export interface KeywordMissingRankingClassification {
  eligible: boolean;
  /** Highest-priority missing bucket across tracked devices; null when ranked. */
  bucket: MissingRankingBucket | null;
}

/**
 * Keyword-level eligibility: eligible when at least one tracked device pair is
 * missing a current ranking. The breakdown bucket is deterministic when
 * several devices are missing with different states.
 */
export function classifyKeywordMissingRankings(
  deviceStates: DeviceRankingState[],
): KeywordMissingRankingClassification {
  let best: MissingRankingBucket | null = null;
  for (const state of deviceStates) {
    if (!isMissingRankingState(state)) continue;
    const bucket = missingRankingBucket(state);
    if (
      best === null ||
      MISSING_BUCKET_PRIORITY[bucket] < MISSING_BUCKET_PRIORITY[best]
    ) {
      best = bucket;
    }
  }
  return { eligible: best !== null, bucket: best };
}

/** Facts for a pair with no snapshot at all ("never checked"). */
export function noRankingFacts(): DeviceRankingFacts {
  return {
    hasSnapshot: false,
    position: null,
    previousPosition: null,
    rankingStatus: null,
  };
}

/**
 * Classify a keyword from its per-device pair facts, considering only the
 * devices the config actually tracks. Eligibility is strictly pair-level:
 * a keyword with Desktop RANKED #5 and Mobile CHECK_FAILED / lost is still
 * eligible because the mobile pair is missing its ranking — preservation of
 * a last valid position, on any device, never suppresses the retry.
 */
export function classifyKeywordFromPairFacts(
  pairFacts: Map<string, DeviceRankingFacts>,
  keywordId: string,
  devices: "both" | "desktop" | "mobile",
): KeywordMissingRankingClassification {
  const trackedDevices: Array<"desktop" | "mobile"> =
    devices === "both" ? ["desktop", "mobile"] : [devices];
  const states = trackedDevices.map((device) =>
    classifyDeviceRankingState(
      pairFacts.get(`${keywordId}:${device}`) ?? noRankingFacts(),
    ),
  );
  return classifyKeywordMissingRankings(states);
}
