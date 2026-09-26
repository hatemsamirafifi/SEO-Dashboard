export type Ga4SyncGrain =
  | "summary"
  | "acquisition"
  | "landing_pages"
  | "events";

export const GA4_GRAINS: Ga4SyncGrain[] = [
  "summary",
  "acquisition",
  "landing_pages",
  "events",
];

export type Ga4CoverageStatus =
  | "PENDING"
  | "SUCCESS_WITH_DATA"
  | "SUCCESS_ZERO_ROWS"
  | "FAILED";

/** Engine tunables (final-plan §9.5; live calibration per §23.1 stays external). */
export const GA4_SYNC_CHUNK_DAYS = 7;
export const GA4_LANDING_PAGE_TOP_N = 1000;
export const GA4_REPORT_PAGE_LIMIT = 10_000;
export const GA4_REPORT_MAX_PAGES = 10;
export const GA4_INITIAL_WINDOW_DAYS = 90;
/** Runs stuck pending/running longer than this are treated as crashed. */
export const GA4_STALE_RUN_MS = 2 * 60 * 60 * 1000;
/** Minimum interval between scheduled syncs per property. */
export const GA4_SYNC_MIN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** Truncation metadata recorded on coverage rows (final-plan §9.5). */
export type Ga4TruncationMeta = {
  row_limit: number | null;
  rows_returned: number;
  is_truncated: boolean;
  total_rows_if_known: number | null;
  sampling_state: "SAMPLED" | "NOT_SAMPLED" | null;
  data_loss_from_other_row: boolean | null;
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
