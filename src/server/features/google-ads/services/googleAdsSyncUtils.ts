// Pure helpers and tunables for the durable Google Ads sync (master plan
// phase 7). No I/O, no provider calls: everything here is deterministic
// calendar/error arithmetic the sync service and the cron entry both reuse.

import {
  GOOGLE_ADS_GRAINS,
  type GoogleAdsGrain,
  type GoogleAdsSyncErrorClass,
} from "../repositories/googleAdsAnalyticsModel";
import { GOOGLE_ADS_MAX_WINDOW_MONTHS } from "./googleAdsAnalyticsMath";
import { scrubGlobalTraceText } from "@/shared/globalTraceTypes";

/** Initial backfill depth when an account has no covered history yet. */
export const GOOGLE_ADS_SYNC_INITIAL_WINDOW_DAYS = 28;
/** Recent sliding lookback covering Google Ads conversion-reporting lag. */
export const GOOGLE_ADS_SYNC_CONVERSION_LOOKBACK_DAYS = 3;
/** Durable run lease (matches the repository default). */
export const GOOGLE_ADS_SYNC_LEASE_SECONDS = 900;
/** Minimum interval between scheduled syncs per connected project. */
export const GOOGLE_ADS_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;
/** Bounded retry attempts for TRANSIENT fetch failures only. */
export const GOOGLE_ADS_SYNC_MAX_TRANSIENT_RETRIES = 3;
/** Base backoff in ms; attempt n waits base * n (bounded). */
export const GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS = 500;
export const GOOGLE_ADS_SYNC_RETRY_MAX_DELAY_MS = 15_000;

/** Bounded sync-worker error classes. Never an upstream response body; only
 *  the sanitized classifier output ever maps into one of these. */
export const GOOGLE_ADS_SYNC_STORAGE_ERROR_CLASSES = [
  "oauth_reconnect_required",
  "api_access_denied",
  "quota_exhausted",
  "rate_limited",
  "transient_upstream",
  "validation_error",
  "malformed_response",
  "connection_fenced",
  "unknown_error",
] as const;
export type GoogleAdsSyncStorageErrorClass =
  (typeof GOOGLE_ADS_SYNC_STORAGE_ERROR_CLASSES)[number];

/** Bounded plain-language error text: message properties are picked up
 *  without any type assertion and scrubbed before they are ever stored —
 *  no upstream body, id or credential text can reach a ledger row. */
export function googleAdsSafeErrorText(err: unknown, fallback: string): string {
  if (typeof err !== "object" || err === null) return fallback;
  for (const [key, value] of Object.entries(err)) {
    if (key !== "message") continue;
    if (typeof value === "string" && value.length >= 1) {
      return scrubGlobalTraceText(value);
    }
  }
  return fallback;
}

export function isGoogleAdsSyncStorageErrorClass(
  value: string,
): value is GoogleAdsSyncStorageErrorClass {
  return (GOOGLE_ADS_SYNC_STORAGE_ERROR_CLASSES as readonly string[]).includes(
    value,
  );
}

export function addGoogleAdsDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00.000Z`) + days * 86_400_000)
    .toISOString()
    .slice(0, 10);
}

export function eachGoogleAdsDay(start: string, end: string): string[] {
  const days: string[] = [];
  for (let date = start; date <= end; date = addGoogleAdsDays(date, 1)) {
    days.push(date);
  }
  return days;
}

/** UTC calendar date "today"; sync windows never reach into the future. */
export function googleAdsSyncToday(today: Date = new Date()): string {
  return today.toISOString().slice(0, 10);
}

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function monthIndexOf(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
}

function dayOfMonthOf(value: string): number {
  return Number(value.slice(8, 10));
}

function isRealCalendarDate(value: string): boolean {
  if (!ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(parsed.getTime()) &&
    parsed.toISOString().slice(0, 10) === value
  );
}

/** Clamps an inclusive manual window into the sync bounds: real calendar
 *  dates, start <= end, end never beyond the UTC "today" and the span never
 *  past the 37-month Google Ads reporting-history cap (a too-wide window is
 *  SHRUNK from the start, never silently widened or rejection-wrapped). */
export function clampGoogleAdsSyncWindow(
  startDate: string,
  endDate: string,
  todayUtc: string = googleAdsSyncToday(),
): { startDate: string; endDate: string } | null {
  if (!isRealCalendarDate(startDate) || !isRealCalendarDate(endDate)) {
    return null;
  }
  const end = endDate > todayUtc ? todayUtc : endDate;
  let start = startDate > end ? end : startDate;
  if (windowExceedsMonths(start, end)) {
    start = monthClampFloor(end);
    if (start > end) start = end;
  }
  return { startDate: start, endDate: end };
}

/** The earliest start that always satisfies the month-span cap for `end`. */
function monthClampFloor(end: string): string {
  // Start 35 whole months before the end month at day 1: the month gap is
  // then always <= 35 <= MAX-1, so the day-of-month anniversary rule can
  // never trip regardless of the end date's day.
  const [year, month] = end.split("-").map(Number);
  const startMonths =
    year * 12 + month - 1 - (GOOGLE_ADS_MAX_WINDOW_MONTHS - 2);
  const startY = Math.floor((startMonths - 1) / 12);
  const startM = ((startMonths - 1) % 12) + 1;
  return `${String(startY).padStart(4, "0")}-${String(startM).padStart(2, "0")}-01`;
}

function windowExceedsMonths(start: string, end: string): boolean {
  const monthGap = monthIndexOf(end) - monthIndexOf(start);
  return (
    monthGap > GOOGLE_ADS_MAX_WINDOW_MONTHS - 1 ||
    (monthGap === GOOGLE_ADS_MAX_WINDOW_MONTHS - 1 &&
      dayOfMonthOf(end) > dayOfMonthOf(start))
  );
}

export type GoogleAdsSyncWindowDecision = {
  startDate: string;
  endDate: string;
  syncType: "initial" | "incremental" | "refresh";
};

/** Resolves the non-explicit sync window from the last fully covered
 *  account date: incremental catch-up from covered+1 with a 3-day sliding
 *  conversion-lag floor; a fully covered account re-checks only the 3-day
 *  recent window. No covered history means the bounded initial backfill. */
export function resolveGoogleAdsSyncWindow(
  lastFullyCoveredDate: string | null,
  todayUtc: string = googleAdsSyncToday(),
): GoogleAdsSyncWindowDecision {
  const end = todayUtc;
  if (!lastFullyCoveredDate) {
    return {
      startDate: addGoogleAdsDays(
        todayUtc,
        -(GOOGLE_ADS_SYNC_INITIAL_WINDOW_DAYS - 1),
      ),
      endDate: end,
      syncType: "initial",
    };
  }
  const next = addGoogleAdsDays(lastFullyCoveredDate, 1);
  const recentFloor = addGoogleAdsDays(
    todayUtc,
    -GOOGLE_ADS_SYNC_CONVERSION_LOOKBACK_DAYS,
  );
  // next beyond today: everything covered -> refresh the recent window.
  // Behind the floor: catch up from the first uncovered day.
  // Inside the floor: slide to the floor for the conversion lag.
  const startDate =
    next > todayUtc ? recentFloor : next < recentFloor ? next : recentFloor;
  const clamped = clampGoogleAdsSyncWindow(startDate, end);
  return {
    startDate: clamped?.startDate ?? recentFloor,
    endDate: clamped?.endDate ?? end,
    syncType: next > todayUtc ? "refresh" : "incremental",
  };
}

export type GoogleAdsGrainUnitStatus = {
  date: string;
  grain: string;
  status: string;
  publishedGenerationId: string | null;
};

const COVERING_STATUSES = new Set(["success_with_data", "success_zero_rows"]);

/** The latest date whose unit for EVERY grain (all seven) is a published
 *  covering success. A date missing any grain is not fully covered. */
export function googleAdsLastFullyCoveredDate(
  units: readonly GoogleAdsGrainUnitStatus[],
): string | null {
  const byDate = new Map<string, Map<GoogleAdsGrain, boolean>>();
  for (const unit of units) {
    if (
      !COVERING_STATUSES.has(unit.status) ||
      unit.publishedGenerationId === null
    ) {
      continue;
    }
    let day = byDate.get(unit.date);
    if (!day) {
      day = new Map();
      byDate.set(unit.date, day);
    }
    const grain = GOOGLE_ADS_GRAINS.find((g) => g === unit.grain);
    if (!grain) continue;
    day.set(grain, true);
  }
  const coveredDates = [...byDate.keys()].toSorted();
  for (const date of coveredDates.toReversed()) {
    const day = byDate.get(date);
    if (day && GOOGLE_ADS_GRAINS.every((grain) => day.has(grain))) {
      return date;
    }
  }
  return null;
}

export type GoogleAdsErrorMapping = {
  errorClass: GoogleAdsSyncStorageErrorClass;
  /** Match against the storage-unit failure statuses. */
  fatal: boolean;
  /** ONLY the three documented transient classes ever retry. */
  retryable: boolean;
  /** Run-lifecycle error class for abandonRun (GOOGLE_ADS_SYNC_ERROR_CLASSES). */
  runErrorClass: GoogleAdsSyncErrorClass;
};

/** Maps the sanitized client error classification onto the bounded storage
 *  classes. Fatal means the run stops immediately (reconnect/access/quota
 *  are not fixable by retrying); retryable means another attempt is worth
 *  its quota only for the documented transient cases. */
export function mapGoogleAdsSyncError(
  classification: { errorClass: string; retryable: boolean },
  choices: { retryable: boolean } = { retryable: classification.retryable },
): GoogleAdsErrorMapping {
  switch (classification.errorClass) {
    case "OAUTH_TOKEN_FAILURE":
    case "OAUTH_TOKEN_INVALID":
      return {
        errorClass: "oauth_reconnect_required",
        fatal: true,
        retryable: false,
        runErrorClass: "AUTH",
      };
    case "PERMISSION_DENIED":
    case "API_ACCESS_RESTRICTED":
    case "CUSTOMER_NOT_FOUND":
      return {
        errorClass: "api_access_denied",
        fatal: true,
        retryable: false,
        runErrorClass: "PERMISSION",
      };
    case "QUOTA_EXHAUSTED":
      return {
        errorClass: "quota_exhausted",
        fatal: true,
        retryable: false,
        runErrorClass: "QUOTA_EXHAUSTED",
      };
    case "QUOTA_TEMPORARILY_EXHAUSTED":
      return {
        errorClass: "rate_limited",
        fatal: false,
        retryable: choices.retryable,
        runErrorClass: "QUOTA_TRANSIENT",
      };
    case "MALFORMED_RESPONSE":
      return {
        errorClass: "malformed_response",
        fatal: false,
        retryable: false,
        runErrorClass: "TRANSIENT",
      };
    case "INVALID_REQUEST":
      return {
        errorClass: "validation_error",
        fatal: false,
        retryable: false,
        runErrorClass: "INTERNAL",
      };
  }
  if (
    classification.errorClass.startsWith("HTTP_ERROR_") &&
    classification.retryable
  ) {
    return {
      errorClass: "transient_upstream",
      fatal: false,
      retryable: choices.retryable,
      runErrorClass: "TRANSIENT",
    };
  }
  return {
    errorClass: "unknown_error",
    fatal: false,
    retryable: false,
    runErrorClass: "INTERNAL",
  };
}

/** Bounded backoff wait for attempt n (1-based): base * n, capped. */
export function googleAdsSyncRetryDelay(
  attempt: number,
  baseMs = GOOGLE_ADS_SYNC_RETRY_BASE_DELAY_MS,
): number {
  const index = Math.max(0, Math.min(attempt - 1, 100));
  return Math.min(baseMs * (index + 1), GOOGLE_ADS_SYNC_RETRY_MAX_DELAY_MS);
}
