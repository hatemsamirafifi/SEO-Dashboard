import { normalizeGoogleAdsCustomerId } from "@/shared/google-ads";

/* Types, window validation and fixed GAQL builders for the fixed daily
 * reporting reads (master-plan Phase 3). Every read is one fixed query
 * against one documented v26 resource: no caller-supplied GAQL, no
 * aggregation across grains, no future-dated windows. The queries are the
 * contracts — the client may add nothing but its own pageToken traversal. */

/** Google Ads keeps granular daily reporting for at most 37 months:
 *  https://support.google.com/google-ads/answer/9549009 */
export const GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS = 37;

export const GOOGLE_ADS_DAILY_GRAINS = [
  "account",
  "campaign",
  "ad_group",
  "keyword",
  "search_term",
  "device",
  "landing_page",
] as const;

export type GoogleAdsReportingGrain = (typeof GOOGLE_ADS_DAILY_GRAINS)[number];

export type GoogleAdsDevice =
  | "CONNECTED_TV"
  | "DESKTOP"
  | "MOBILE"
  | "OTHER"
  | "TABLET"
  | "UNKNOWN"
  | "UNSPECIFIED";

export type GoogleAdsKeywordMatchType = "EXACT" | "PHRASE" | "BROAD";

/** One metric cell of a segmented daily row. Absent cells are `null`
 *  (Google omits zero-metric segmented rows; absence is not a zero). int64
 *  cells over JavaScript's safe range stay digits text so consumers can do
 *  explicit big-integer math instead of trusting a lossy float. */
export type GoogleAdsDailyMetricValue = number | string | null;

export type GoogleAdsDailyMetrics = {
  impressions: GoogleAdsDailyMetricValue;
  clicks: GoogleAdsDailyMetricValue;
  costMicros: GoogleAdsDailyMetricValue;
  conversions: number | null;
  conversionsValue: number | null;
};

export type GoogleAdsDailyFactsInput = {
  customerId: string;
  loginCustomerId?: string | null;
  startDate: string;
  endDate: string;
};

export type GoogleAdsDailyWindowValue = {
  customerId: string;
  loginCustomerId: string | null;
  startDate: string;
  endDate: string;
};

export type GoogleAdsDailyWindowValidation =
  | { ok: true; value: GoogleAdsDailyWindowValue }
  | { ok: false; reason: string };

export type GoogleAdsDailyAccountRow = {
  date: string;
  resourceName: string;
  displayName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyCampaignRow = {
  date: string;
  campaignResourceId: string;
  campaignId: string | null;
  campaignName: string | null;
  campaignStatus: string | null;
  servingStatus: string | null;
  advertisingChannelType: string | null;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyAdGroupRow = {
  date: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  adGroupId: string | null;
  adGroupName: string | null;
  adGroupStatus: string | null;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyKeywordRow = {
  date: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  keywordResourceId: string;
  criterionId: string;
  keywordText: string | null;
  keywordMatchType: GoogleAdsKeywordMatchType | null;
  metrics: GoogleAdsDailyMetrics;
};

/** v26 search_term_view has no matched-keyword attributes, so the matched
 *  keyword fields stay null instead of being guessed from another view. */
export type GoogleAdsDailySearchTermRow = {
  date: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  searchTermResourceId: string | null;
  searchText: string;
  keywordText: null;
  keywordMatchType: null;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyDeviceRow = {
  date: string;
  campaignResourceId: string;
  device: GoogleAdsDevice;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyLandingPageRow = {
  date: string;
  campaignResourceId: string;
  landingPageResourceId: string;
  landingPageUrl: string;
  metrics: GoogleAdsDailyMetrics;
};

export type GoogleAdsDailyFactsResult<Row> = {
  grain: GoogleAdsReportingGrain;
  customerId: string;
  startDate: string;
  endDate: string;
  /** The segmented-date basis for every fixed daily read: interaction day. */
  metricDateBasis: "interaction_date";
  source: "google_ads";
  fetchedAt: string;
  rows: Row[];
  truncated: boolean;
  malformedRows: number;
  partial: boolean;
};

export type GoogleAdsDailyQueryBuild =
  | { ok: true; value: string }
  | { ok: false; reason: string };

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const SHARED_DAILY_FIELDS = [
  "segments.date",
  "metrics.impressions",
  "metrics.clicks",
  "metrics.cost_micros",
  "metrics.conversions",
  "metrics.conversions_value",
] as const;

function isCalendarIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const date = new Date(`${value}T00:00:00.000Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

function monthIndexOf(value: string): number {
  return Number(value.slice(0, 4)) * 12 + Number(value.slice(5, 7));
}

function dayOfMonthOf(value: string): number {
  return Number(value.slice(8, 10));
}

/** Validates the fixed daily-read window BEFORE any network or auth work:
 *  normalized customer ids, real calendar dates, start <= end, no window
 *  past the 37-month reporting history and no future end beyond tomorrow
 *  (an account's local "today" can differ from UTC by up to one day). */
export function validateGoogleAdsDailyFactsWindow(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyWindowValidation {
  const customerId = normalizeGoogleAdsCustomerId(input.customerId);
  if (!customerId) {
    return { ok: false, reason: "The Google Ads customer id is invalid." };
  }
  let loginCustomerId: string | null = null;
  if (input.loginCustomerId) {
    loginCustomerId = normalizeGoogleAdsCustomerId(input.loginCustomerId);
    if (!loginCustomerId) {
      return {
        ok: false,
        reason: "The Google Ads manager (login) customer id is invalid.",
      };
    }
  }
  if (!isCalendarIsoDate(input.startDate)) {
    return {
      ok: false,
      reason:
        "The Google Ads report start date must be a calendar date (YYYY-MM-DD).",
    };
  }
  if (!isCalendarIsoDate(input.endDate)) {
    return {
      ok: false,
      reason:
        "The Google Ads report end date must be a calendar date (YYYY-MM-DD).",
    };
  }
  const { startDate, endDate } = input;
  if (startDate > endDate) {
    return {
      ok: false,
      reason: "The Google Ads report window ends before it starts.",
    };
  }
  // Up to GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS calendar months of granular
  // data: the whole-month gap must stay below MAX_REPORT_WINDOW_MONTHS-1,
  // and inside the (MAX-1)th month the end date may not pass the start
  // date's day-of-month anniversary.
  const monthGap = monthIndexOf(endDate) - monthIndexOf(startDate);
  if (
    monthGap > GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS - 1 ||
    (monthGap === GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS - 1 &&
      dayOfMonthOf(endDate) > dayOfMonthOf(startDate))
  ) {
    return {
      ok: false,
      reason: `The Google Ads report window may span at most ${GOOGLE_ADS_MAX_REPORT_WINDOW_MONTHS} months.`,
    };
  }
  const tomorrowUtc = new Date(Date.now() + 86_400_000)
    .toISOString()
    .slice(0, 10);
  if (endDate > tomorrowUtc) {
    return {
      ok: false,
      reason: "The Google Ads report window must not end in the future.",
    };
  }
  return {
    ok: true,
    value: { customerId, loginCustomerId, startDate, endDate },
  };
}

/** The single fixed date predicate every daily query uses. Input dates are
 *  strict ISO strings already validated by the window validator, so the
 *  quoted literals cannot inject GAQL. */
export function buildGoogleAdsDailyWindowClause(
  startDate: string,
  endDate: string,
): string {
  return `WHERE segments.date BETWEEN '${startDate}' AND '${endDate}'`;
}

function buildDailyQuery(
  input: GoogleAdsDailyFactsInput,
  fromResource: string,
  resourceFields: readonly string[],
  extraFields: readonly string[] = [],
  extraConditions: readonly string[] = [],
): GoogleAdsDailyQueryBuild {
  const window = validateGoogleAdsDailyFactsWindow(input);
  if (!window.ok) return { ok: false, reason: window.reason };
  const fields = [...resourceFields, ...extraFields, ...SHARED_DAILY_FIELDS];
  const conditions = [
    buildGoogleAdsDailyWindowClause(
      window.value.startDate,
      window.value.endDate,
    ),
    ...extraConditions,
  ];
  const where = conditions.map((part, index) =>
    index === 0 ? part : `AND ${part}`,
  );
  const value = [
    "SELECT",
    ...fields.map((field) => `  ${field}`),
    `FROM ${fromResource}`,
    ...where,
  ].join("\n");
  return { ok: true, value };
}

export function buildGoogleAdsDailyAccountQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  return buildDailyQuery(input, "customer", [
    "customer.resource_name",
    "customer.descriptive_name",
    "customer.currency_code",
    "customer.time_zone",
  ]);
}

export function buildGoogleAdsDailyCampaignQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  return buildDailyQuery(input, "campaign", [
    "campaign.resource_name",
    "campaign.id",
    "campaign.name",
    "campaign.status",
    "campaign.serving_status",
    "campaign.advertising_channel_type",
  ]);
}

export function buildGoogleAdsDailyAdGroupQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  return buildDailyQuery(input, "ad_group", [
    "ad_group.resource_name",
    "ad_group.id",
    "ad_group.name",
    "ad_group.status",
    "campaign.resource_name",
  ]);
}

export function buildGoogleAdsDailyKeywordQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  // keyword_view filtered to advertising keyword criteria only.
  return buildDailyQuery(
    input,
    "keyword_view",
    [
      "ad_group_criterion.resource_name",
      "ad_group_criterion.criterion_id",
      "ad_group_criterion.keyword.text",
      "ad_group_criterion.keyword.match_type",
      "ad_group.resource_name",
      "campaign.resource_name",
    ],
    [],
    ["ad_group_criterion.type = KEYWORD"],
  );
}

export function buildGoogleAdsDailySearchTermQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  // v26 search_term_view exposes no matched-keyword fields; matched keyword
  // attributes are intentionally not selected from any other view.
  return buildDailyQuery(input, "search_term_view", [
    "search_term_view.resource_name",
    "search_term_view.search_term",
    "ad_group.resource_name",
    "campaign.resource_name",
  ]);
}

export function buildGoogleAdsDailyDeviceQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  // The storage grain requires campaignResourceId + device, so the device
  // read segments by campaign instead of collapsing into an account total.
  return buildDailyQuery(
    input,
    "campaign",
    ["campaign.resource_name"],
    ["segments.device"],
  );
}

export function buildGoogleAdsDailyLandingPageQuery(
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  // The storage grain requires campaignResourceId + full unexpanded URL, so
  // landing pages read per campaign — never rolled up account-wide.
  return buildDailyQuery(input, "landing_page_view", [
    "landing_page_view.resource_name",
    "landing_page_view.unexpanded_final_url",
    "campaign.resource_name",
  ]);
}

/** Grain → fixed query dispatch for the client's shared runner. */
export function buildGoogleAdsDailyQuery(
  grain: GoogleAdsReportingGrain,
  input: GoogleAdsDailyFactsInput,
): GoogleAdsDailyQueryBuild {
  switch (grain) {
    case "account":
      return buildGoogleAdsDailyAccountQuery(input);
    case "campaign":
      return buildGoogleAdsDailyCampaignQuery(input);
    case "ad_group":
      return buildGoogleAdsDailyAdGroupQuery(input);
    case "keyword":
      return buildGoogleAdsDailyKeywordQuery(input);
    case "search_term":
      return buildGoogleAdsDailySearchTermQuery(input);
    case "device":
      return buildGoogleAdsDailyDeviceQuery(input);
    case "landing_page":
      return buildGoogleAdsDailyLandingPageQuery(input);
  }
}
