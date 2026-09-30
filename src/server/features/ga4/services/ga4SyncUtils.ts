import { GA4_OTHER_DIMENSION } from "@/shared/ga4";

export type Ga4SyncGrain =
  | "summary"
  | "acquisition"
  | "landing_pages"
  | "events"
  | "geo"
  | "technology";

export const GA4_GRAINS: Ga4SyncGrain[] = [
  "summary",
  "acquisition",
  "landing_pages",
  "events",
  "geo",
  "technology",
];

export type Ga4CoverageStatus =
  | "PENDING"
  | "SUCCESS_WITH_DATA"
  | "SUCCESS_ZERO_ROWS"
  | "FAILED";

/** Engine tunables (final-plan §9.5; live calibration per §23.1 stays external). */
export const GA4_SYNC_CHUNK_DAYS = 7;
export const GA4_LANDING_PAGE_TOP_N = 1000;
/** Per-date cardinality bounds for the geo/tech grains. Countries top out
 *  near 250 distinct values; the tech composite (device×browser×os) is open-
 *  ended, so it mirrors the landing-page bound. Overflow rolls into a
 *  deterministic "(other)" row (rollUpOtherTail) — never dropped. */
export const GA4_GEO_TOP_N = 300;
export const GA4_TECHNOLOGY_TOP_N = 1000;
export const GA4_REPORT_PAGE_LIMIT = 10_000;
export const GA4_REPORT_MAX_PAGES = 10;
export const GA4_INITIAL_WINDOW_DAYS = 90;
/** Runs stuck pending/running longer than this are treated as crashed. */
export const GA4_STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** Minimum interval between scheduled syncs per property. */
export const GA4_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Truncation metadata recorded on coverage rows (final-plan §9.5).
 *  The tail-* fields serve the geo/technology "(other)" rollup: counts are
 *  present only when reliably known from a fully-fetched result set — never
 *  fabricated when the API hides true cardinality. */
export type Ga4TruncationMeta = {
  row_limit: number | null;
  rows_returned: number;
  is_truncated: boolean;
  total_rows_if_known: number | null;
  sampling_state: "SAMPLED" | "NOT_SAMPLED" | null;
  data_loss_from_other_row: boolean | null;
  retained_dimension_count?: number | null;
  omitted_dimension_count?: number | null;
  other_row_present?: boolean;
};

const SUMMARY_CORE_METRICS = [
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  "screenPageViews",
  "eventCount",
  "newUsers",
  "totalUsers",
  "activeUsers",
];

const SUMMARY_REVENUE_METRICS = [
  "totalRevenue",
  "purchaseRevenue",
  "transactions",
  "addToCarts",
  "checkouts",
];

const ACQUISITION_METRICS = [
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  "screenPageViews",
  "eventCount",
  "newUsers",
];

const LANDING_METRICS = [
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  "screenPageViews",
];

export type Ga4GrainSubRequest = {
  propertyId: string;
  dateRanges: Array<{ startDate: string; endDate: string }>;
  dimensions: string[];
  metrics: string[];
  orderBys?: Array<{ name: string; desc?: boolean }>;
  limit?: number;
  offset?: number;
};

/** One batchRunReports call per chunk covering all grains: five
 *  sub-requests (summary ships as core + revenue halves for the Data API
 *  10-metric cap). Landing pages are sessions-desc top-N bounded. */
export const GA4_BATCH_SUB_REQUEST_COUNT = 5;
export function buildGrainSubRequests(input: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Ga4GrainSubRequest[] {
  const base = {
    propertyId: input.propertyId,
    dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
  };
  const requests: Ga4GrainSubRequest[] = [
    {
      ...base,
      dimensions: ["date"],
      metrics: SUMMARY_CORE_METRICS,
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
    {
      ...base,
      dimensions: ["date"],
      metrics: SUMMARY_REVENUE_METRICS,
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
    {
      ...base,
      dimensions: [
        "date",
        "sessionDefaultChannelGroup",
        "sessionSource",
        "sessionMedium",
      ],
      metrics: ACQUISITION_METRICS,
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
    {
      ...base,
      dimensions: ["date", "landingPagePlusQueryString"],
      metrics: LANDING_METRICS,
      orderBys: [{ name: "sessions", desc: true }],
      limit: GA4_LANDING_PAGE_TOP_N,
    },
    {
      ...base,
      dimensions: ["date", "eventName"],
      metrics: ["eventCount", "keyEvents"],
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
  ];
  if (requests.length !== GA4_BATCH_SUB_REQUEST_COUNT) {
    throw new Error("GA4 grain sub-requests drifted from the batch count");
  }
  return requests;
}

const GEO_TECH_METRICS = [
  "sessions",
  "engagedSessions",
  "userEngagementDuration",
  "screenPageViews",
  "eventCount",
  "newUsers",
];

/** Geo + technology sub-requests. These run as individual runReport calls
 *  (NOT inside the 5-request batchRunReports quota — the Data API caps a
 *  batch at five) with full offset pagination, so the "(other)" rollup sees
 *  the complete result set and aggregates stay exact. */
export const GA4_GEO_TECH_SUB_REQUEST_COUNT = 2;
export function buildGeoTechSubRequests(input: {
  propertyId: string;
  startDate: string;
  endDate: string;
}): Ga4GrainSubRequest[] {
  const base = {
    propertyId: input.propertyId,
    dateRanges: [{ startDate: input.startDate, endDate: input.endDate }],
  };
  const requests: Ga4GrainSubRequest[] = [
    {
      ...base,
      dimensions: ["date", "country"],
      metrics: GEO_TECH_METRICS,
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
    {
      ...base,
      dimensions: ["date", "deviceCategory", "browser", "operatingSystem"],
      metrics: GEO_TECH_METRICS,
      orderBys: [{ name: "date", desc: false }],
      limit: GA4_REPORT_PAGE_LIMIT,
    },
  ];
  if (requests.length !== GA4_GEO_TECH_SUB_REQUEST_COUNT) {
    throw new Error("GA4 geo/tech sub-requests drifted from the batch count");
  }
  return requests;
}

export type Ga4TailMetrics = {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
  newUsers: number;
};

export type Ga4TailRollup = {
  retained: Array<{ key: string; metrics: Ga4TailMetrics }>;
  other: Ga4TailMetrics | null;
  isTruncated: boolean;
  retainedDimensionCount: number;
  omittedDimensionCount: number | null;
  otherRowPresent: boolean;
};

function zeroTailMetrics(): Ga4TailMetrics {
  return {
    sessions: 0,
    engagedSessions: 0,
    userEngagementDuration: 0,
    screenPageViews: 0,
    eventCount: 0,
    newUsers: 0,
  };
}

function addTailMetrics(
  into: Ga4TailMetrics,
  extra: Ga4TailMetrics,
): Ga4TailMetrics {
  return {
    sessions: into.sessions + extra.sessions,
    engagedSessions: into.engagedSessions + extra.engagedSessions,
    userEngagementDuration:
      into.userEngagementDuration + extra.userEngagementDuration,
    screenPageViews: into.screenPageViews + extra.screenPageViews,
    eventCount: into.eventCount + extra.eventCount,
    newUsers: into.newUsers + extra.newUsers,
  };
}

/** Deterministic "(other)" tail rollup for one date's dimension rows.
 *  Sort is sessions-desc, key-asc (ties stable across runs/backends); the
 *  first topN keys are retained and the remainder sums component-wise into
 *  a single tail aggregate so totals stay exact — tail values are never
 *  dropped. Rows the API itself labeled "(other)" fold into the same tail
 *  and force counts-unknown (the API hid true cardinality — never
 *  fabricated). countsKnown=false when pagination stopped early with rows
 *  still pending. */
export function rollUpOtherTail(input: {
  rows: Array<{ key: string; metrics: Ga4TailMetrics }>;
  topN: number;
  countsKnown: boolean;
}): Ga4TailRollup {
  const { rows, topN, countsKnown } = input;
  let apiOther = zeroTailMetrics();
  let apiOtherSeen = false;
  const real: Array<{ key: string; metrics: Ga4TailMetrics }> = [];
  for (const row of rows) {
    if (row.key === GA4_OTHER_DIMENSION) {
      apiOther = addTailMetrics(apiOther, row.metrics);
      apiOtherSeen = true;
    } else {
      real.push(row);
    }
  }
  const ranked = [...real].toSorted((a, b) => {
    if (b.metrics.sessions !== a.metrics.sessions) {
      return b.metrics.sessions - a.metrics.sessions;
    }
    return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  });
  const retained = ranked.slice(0, Math.max(0, topN));
  const dropped = ranked.slice(retained.length);
  let tail = apiOther;
  for (const row of dropped) tail = addTailMetrics(tail, row.metrics);
  const otherRowPresent = apiOtherSeen || dropped.length > 0;
  return {
    retained,
    other: otherRowPresent ? tail : null,
    isTruncated: otherRowPresent,
    retainedDimensionCount: retained.length,
    omittedDimensionCount:
      otherRowPresent && countsKnown && !apiOtherSeen
        ? dropped.length
        : null,
    otherRowPresent,
  };
}
/** Every calendar day in a closed [startDate, endDate] range (UTC). */
export function eachDayUtc(startDate: string, endDate: string): string[] {
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    return [];
  }
  const days: string[] = [];
  for (let ms = startMs; ms <= endMs; ms += 24 * 60 * 60 * 1000) {
    days.push(new Date(ms).toISOString().slice(0, 10));
  }
  return days;
}

const FATAL_GA4_ERROR_CLASSES = new Set([
  "OAUTH_TOKEN_FAILURE",
  "PERMISSION_DENIED",
  "PROPERTY_NOT_FOUND",
  "INVALID_REQUEST",
  "NOT_CONNECTED",
]);

/** Fatal classes finalize the run as FAILED (final-plan §9.5 matrix).
 *  QUOTA_EXHAUSTED halts with the remainder PENDING instead. */
export function isFatalGa4ErrorClass(errorClass: string): boolean {
  return FATAL_GA4_ERROR_CLASSES.has(errorClass);
}

/** Coverage units in these states count as successfully finalized —
 *  case-insensitive because stored rows use lowercase status values. */
export function isSuccessCoverageStatus(status: string): boolean {
  const upper = status.toUpperCase();
  return upper === "SUCCESS_WITH_DATA" || upper === "SUCCESS_ZERO_ROWS";
}

export function isGa4SyncGrain(value: string): value is Ga4SyncGrain {
  return (GA4_GRAINS as string[]).includes(value);
}
