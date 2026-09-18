import {
  AUTUMN_SEO_DATA_CREDITS_PER_USD,
  SEO_DATA_COST_MARKUP,
  roundUsdForBilling,
} from "./billing";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

// ---------------------------------------------------------------------------
// Cost constants
// ---------------------------------------------------------------------------

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
 * manual checks; "queued" is the cheaper task queue used for scheduled checks.
 */
type RankCheckMethod = "live" | "queued";

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
) {
  const totalChecks = keywordCount * devicesCount(devices);
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

/**
 * Compute the next check time for a scheduled config.
 *
 * If `previousNextCheckAt` is provided, advances from that anchor by the
 * interval until the result is in the future. This prevents schedule drift
 * when runs are delayed (e.g., a weekly config due Monday that fires on
 * Wednesday will still schedule the next check for the following Monday).
 *
 * Otherwise a random hour (04–09 UTC) and minute are chosen.
 */
export function computeNextCheckAt(
  interval: ScheduledRankTrackingInterval,
  previousNextCheckAt?: string | null,
): string {
  const now = Date.now();

  if (interval === "monthly") {
    if (previousNextCheckAt) {
      const anchor = new Date(previousNextCheckAt);
      let monthOffset = 1;
      let nextDate = endOfMonthWithTime(anchor, monthOffset);
      while (nextDate.getTime() <= now) {
        monthOffset += 1;
        nextDate = endOfMonthWithTime(anchor, monthOffset);
      }
      return nextDate.toISOString();
    }

    const hour = 4 + Math.floor(Math.random() * 6);
    const minute = Math.floor(Math.random() * 60);
    const nextDate = endOfMonthWithTime(new Date());
    nextDate.setUTCHours(hour, minute, 0, 0);
    if (nextDate.getTime() <= now) {
      const followingMonth = endOfMonthWithTime(nextDate, 1);
      followingMonth.setUTCHours(hour, minute, 0, 0);
      return followingMonth.toISOString();
    }
    return nextDate.toISOString();
  }

  const daysAhead = interval === "daily" ? 1 : 7;

  if (previousNextCheckAt) {
    const anchor = new Date(previousNextCheckAt).getTime();
    const intervalMs = daysAhead * 86_400_000;
    const steps = Math.floor(Math.max(0, now - anchor) / intervalMs) + 1;
    return new Date(anchor + steps * intervalMs).toISOString();
  }

  const nextDate = new Date();
  nextDate.setUTCDate(nextDate.getUTCDate() + daysAhead);
  const hour = 4 + Math.floor(Math.random() * 6);
  const minute = Math.floor(Math.random() * 60);
  nextDate.setUTCHours(hour, minute, 0, 0);
  return nextDate.toISOString();
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
