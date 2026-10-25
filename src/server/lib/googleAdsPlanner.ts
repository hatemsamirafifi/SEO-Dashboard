/** Google Ads Keyword Planner (v26) request/response contracts.
 *
 * Every shape here is pinned to the official v26 reference:
 *  - POST /v26/customers/{customerId}:generateKeywordIdeas
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordIdeasRequest
 *  - POST /v26/customers/{customerId}:generateKeywordHistoricalMetrics
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordHistoricalMetricsRequest
 *  - KeywordPlanHistoricalMetrics (the shared metric block)
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordPlanHistoricalMetrics
 *  - MonthOfYearEnum.MonthOfYear
 *    https://developers.google.com/google-ads/api/reference/enums/v26/MonthOfYearEnum
 *  - KeywordPlanCompetitionLevelEnum.KeywordPlanCompetitionLevel
 *    https://developers.google.com/google-ads/api/reference/enums/v26/KeywordPlanCompetitionLevelEnum
 *
 * This module is deliberately free of transport code: it builds request
 * bodies, parses response payloads and normalizes metrics. The authenticated
 * transport, the error taxonomy and the HTTP calls stay in googleAdsClient.
 * Upstream payloads are narrowed with Zod at the trust boundary, so no
 * untrusted value is ever asserted into a typed shape.
 *
 * Semantics that must survive normalization (master plan, Phase 2):
 *  - Google Ads advertising competition is NOT organic keyword difficulty.
 *  - An absent metric is null. It is never zero.
 *  - Average CPC and the top-of-page bid range are three different numbers.
 *  - Close variants stay one result with membership.
 *  - Money is micros of the selected account's currency, never USD.
 */

/** The v26 seed accepts at least one and no more than 20 keywords. */
export const GOOGLE_ADS_MAX_SEED_KEYWORDS = 20;
/** The v26 request accepts at most 10 geo target constants. */
export const GOOGLE_ADS_MAX_GEO_TARGET_CONSTANTS = 10;
/** The v26 historical-metrics request accepts at most 10,000 keywords. */
export const GOOGLE_ADS_MAX_HISTORICAL_KEYWORDS = 10_000;
/** The v26 planner ignores a page size above 10,000 results. */
export const GOOGLE_ADS_MAX_PLANNER_PAGE_SIZE = 10_000;
/** Default per-page result count for the Planner (bounded by design). */
export const GOOGLE_ADS_DEFAULT_PLANNER_PAGE_SIZE = 100;
/** Hard ceiling on Planner pages fetched for one call. */
export const GOOGLE_ADS_MAX_PLANNER_PAGES = 10;
/** Default total result ceiling for one Planner call. */
export const GOOGLE_ADS_DEFAULT_PLANNER_MAX_RESULTS = 1_000;
/** Hard ceiling on the total results one Planner call may collect. */
export const GOOGLE_ADS_MAX_PLANNER_MAX_RESULTS = 10_000;
/** The v26 request omits `keywordPlanNetwork`, which then means Google
 *  Search and Partners. The default is recorded explicitly so a consumer
 *  never has to guess which network produced a number. */
export const GOOGLE_ADS_DEFAULT_PLANNER_NETWORK = "GOOGLE_SEARCH_AND_PARTNERS";
/** Provenance of every result produced by this boundary. */
export const GOOGLE_ADS_PLANNER_SOURCE = "google_ads";

/** Google Ads advertising competition level. This is ad-placement
 *  competition, NOT organic keyword difficulty. */
export type GoogleAdsKeywordCompetition = "LOW" | "MEDIUM" | "HIGH";

/** One month of search-volume history. `volume` is null when Google has no
 *  data for that month — a missing month is never reported as zero. */
export type GoogleAdsMonthlySearchVolume = {
  /** Calendar year, e.g. 2026. */
  year: number;
  /** Calendar month, 1-12. */
  month: number;
  /** Searches in that month; null when unavailable. */
  volume: number | null;
};

/** The shared v26 metric block (`KeywordPlanHistoricalMetrics`). Every value
 *  is nullable: absent upstream data is null, never zero. */
export type GoogleAdsKeywordMetrics = {
  /** Average monthly searches over the last 12 months. */
  avgMonthlySearches: number | null;
  /** Monthly search-volume history. */
  monthlySearchVolumes: GoogleAdsMonthlySearchVolume[];
  /** Advertising competition level. */
  competition: GoogleAdsKeywordCompetition | null;
  /** Advertising competition index (0-100): ad-slot competition. */
  competitionIndex: number | null;
  /** Average cost per click, in micros of the account currency. */
  averageCpcMicros: number | null;
  /** Top-of-page bid low range (20th percentile), in micros. */
  lowTopOfPageBidMicros: number | null;
  /** Top-of-page bid high range (80th percentile), in micros. */
  highTopOfPageBidMicros: number | null;
};

/** One keyword with its metrics. `keyword` is Google's canonical text, which
 *  may stand for several close variants; `closeVariants` lists them. */
export type GoogleAdsKeywordRecord = GoogleAdsKeywordMetrics & {
  keyword: string;
  closeVariants: string[];
};

export type GoogleAdsKeywordIdeasResult = {
  ideas: GoogleAdsKeywordRecord[];
  /** Total results Google reported as available (`totalSize`); null when the
   *  upstream did not report it. */
  totalResults: number | null;
  /** True when a page or result ceiling stopped the traversal: `ideas` is NOT
   *  the complete set Google offered. */
  truncated: boolean;
  /** Idea rows the upstream returned that could not be parsed. */
  malformedIdeas: number;
  /** truncated || malformedIdeas > 0 — the single "these are not everything"
   *  flag. */
  partial: boolean;
  source: typeof GOOGLE_ADS_PLANNER_SOURCE;
  /** When OpenSEO fetched the data (ISO 8601). */
  fetchedAt: string;
  /** Currency of the selected Google Ads account. null when the caller could
   *  not supply it: money is never assumed to be USD. */
  currencyCode: string | null;
  network: typeof GOOGLE_ADS_DEFAULT_PLANNER_NETWORK;
};

export type GoogleAdsHistoricalMetricsResult = {
  /** One record per canonical keyword group. */
  keywords: GoogleAdsKeywordRecord[];
  /** Requested keywords for which Google returned no group at all. They are
   *  absent upstream, not zero. */
  missingKeywords: string[];
  /** Rows the upstream returned that could not be parsed. */
  malformedKeywords: number;
  /** Groups the upstream returned more than once (merged into one record). */
  duplicateKeywords: number;
  /** The historical-metrics contract has no paging, so it is never truncated. */
  truncated: boolean;
  /** malformedKeywords > 0 || missingKeywords.length > 0 */
  partial: boolean;
  source: typeof GOOGLE_ADS_PLANNER_SOURCE;
  fetchedAt: string;
  currencyCode: string | null;
  network: typeof GOOGLE_ADS_DEFAULT_PLANNER_NETWORK;
};

export type GoogleAdsKeywordIdeasInput = {
  customerId: string;
  /** Keyword seed: 1..20 keywords. */
  keywords?: string[];
  /** URL seed. May be combined with a keyword seed. */
  url?: string;
  /** Geo target constant resource names, at most 10. */
  geoTargetConstants?: string[];
  /** Language constant resource name. */
  language?: string;
  /** Currency of the selected Google Ads account (explicit metadata). */
  currencyCode?: string | null;
  /** Per-page result count (Planner's own paging contract). */
  pageSize?: number;
  /** Total results this call may collect. */
  maxResults?: number;
  /** Pages this call may fetch. */
  maxPages?: number;
  /** Manager account used as the login customer, when authorized. */
  loginCustomerId?: string | null;
};

export type GoogleAdsHistoricalMetricsInput = {
  customerId: string;
  /** Keywords to look up: 1..10,000. */
  keywords: string[];
  geoTargetConstants?: string[];
  language?: string;
  currencyCode?: string | null;
  loginCustomerId?: string | null;
};

/** A validation or parse outcome. The caller decides which error a failure
 *  becomes, so this module never throws its own error classes. */
export type GoogleAdsParseResult<T> = { ok: true; value: T } | { ok: false };

const GEO_TARGET_CONSTANT_PATTERN = /^geoTargetConstants\/\d+$/;
const LANGUAGE_CONSTANT_PATTERN = /^languageConstants\/\d+$/;
const CURRENCY_CODE_PATTERN = /^[A-Za-z]{3}$/;
/** A URL seed is either an absolute http(s) URL or a bare host with an
 *  optional path. Whitespace is never valid. */
const URL_SEED_PATTERN =
  /^(?:https?:\/\/[^\s]+|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+(?:\/\S*)?)$/i;
/** Client-side guard for a single seed keyword (upstream trims much higher). */
const MAX_SEED_KEYWORD_LENGTH = 100;
/** Client-side guard for a URL seed. */
const MAX_URL_SEED_LENGTH = 500;

function fail(reason: string): { ok: false; reason: string } {
  return { ok: false, reason };
}

function validateSeedKeywords(
  value: unknown,
): { ok: true; value: string[] } | { ok: false; reason: string } {
  if (!Array.isArray(value)) {
    return fail("Google Ads keyword seeds must be an array of keywords.");
  }
  if (value.length === 0) {
    return fail("Google Ads keyword seeds need at least one keyword.");
  }
  if (value.length > GOOGLE_ADS_MAX_SEED_KEYWORDS) {
    return fail(
      `Google Ads accepts at most ${GOOGLE_ADS_MAX_SEED_KEYWORDS} seed keywords per request.`,
    );
  }
  const keywords: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string") {
      return fail("Google Ads seed keywords must be strings.");
    }
    const trimmed = entry.trim();
    if (trimmed.length === 0) {
      return fail("Google Ads seed keywords must not be empty.");
    }
    if (trimmed.length > MAX_SEED_KEYWORD_LENGTH) {
      return fail(
        `Google Ads seed keywords must be ${MAX_SEED_KEYWORD_LENGTH} characters or fewer.`,
      );
    }
    keywords.push(trimmed);
  }
  return { ok: true, value: keywords };
}

function validateUrlSeed(
  value: unknown,
): { ok: true; value: string } | { ok: false; reason: string } {
  if (typeof value !== "string") {
    return fail("The Google Ads URL seed must be a string.");
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return fail("The Google Ads URL seed must not be empty.");
  }
  if (trimmed.length > MAX_URL_SEED_LENGTH) {
    return fail(
      `The Google Ads URL seed must be ${MAX_URL_SEED_LENGTH} characters or fewer.`,
    );
  }
  if (!URL_SEED_PATTERN.test(trimmed)) {
    return fail(
      "The Google Ads URL seed must be an http(s) URL or a domain name.",
    );
  }
  return { ok: true, value: trimmed };
}

function validateGeoTargetConstants(
  value: unknown,
): { ok: true; value: string[] | undefined } | { ok: false; reason: string } {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (!Array.isArray(value)) {
    return fail("Google Ads geo target constants must be an array.");
  }
  if (value.length > GOOGLE_ADS_MAX_GEO_TARGET_CONSTANTS) {
    return fail(
      `Google Ads accepts at most ${GOOGLE_ADS_MAX_GEO_TARGET_CONSTANTS} geo target constants per request.`,
    );
  }
  const constants: string[] = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !GEO_TARGET_CONSTANT_PATTERN.test(entry)) {
      return fail(
        "Google Ads geo target constants must be resource names such as geoTargetConstants/2840.",
      );
    }
    constants.push(entry);
  }
  return { ok: true, value: constants };
}

function validateLanguageConstant(
  value: unknown,
): { ok: true; value: string | undefined } | { ok: false; reason: string } {
  if (value === undefined || value === null)
    return { ok: true, value: undefined };
  if (typeof value !== "string" || !LANGUAGE_CONSTANT_PATTERN.test(value)) {
    return fail(
      "The Google Ads language must be a resource name such as languageConstants/1000.",
    );
  }
  return { ok: true, value };
}

function validateCurrencyCode(
  value: unknown,
): { ok: true; value: string | null } | { ok: false; reason: string } {
  if (value === undefined || value === null) return { ok: true, value: null };
  if (typeof value !== "string" || !CURRENCY_CODE_PATTERN.test(value)) {
    return fail(
      "The Google Ads account currency must be a three-letter currency code.",
    );
  }
  return { ok: true, value: value.toUpperCase() };
}

function validateBoundedInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  label: string,
): { ok: true; value: number } | { ok: false; reason: string } {
  if (value === undefined || value === null)
    return { ok: true, value: fallback };
  if (typeof value !== "number" || !Number.isInteger(value)) {
    return fail(`Google Ads ${label} must be a whole number.`);
  }
  if (value < min || value > max) {
    return fail(`Google Ads ${label} must be between ${min} and ${max}.`);
  }
  return { ok: true, value };
}

export type GoogleAdsKeywordIdeasRequest = {
  body: Record<string, unknown>;
  pageSize: number;
  maxResults: number;
  maxPages: number;
  currencyCode: string | null;
};

/** Builds the `generateKeywordIdeas` request body. The seed form follows the
 *  v26 oneof: keywords only, URL only, or the combined keyword+URL seed. */
export function buildKeywordIdeasRequest(
  input: GoogleAdsKeywordIdeasInput,
):
  | { ok: true; value: GoogleAdsKeywordIdeasRequest }
  | { ok: false; reason: string } {
  const keywords =
    input.keywords === undefined
      ? undefined
      : validateSeedKeywords(input.keywords);
  if (keywords && !keywords.ok) return keywords;
  const url = input.url === undefined ? undefined : validateUrlSeed(input.url);
  if (url && !url.ok) return url;
  if (!keywords && !url) {
    return fail(
      "Google Ads keyword ideas need a keyword seed, a URL seed, or both.",
    );
  }
  const geoTargets = validateGeoTargetConstants(input.geoTargetConstants);
  if (!geoTargets.ok) return geoTargets;
  const language = validateLanguageConstant(input.language);
  if (!language.ok) return language;
  const currency = validateCurrencyCode(input.currencyCode);
  if (!currency.ok) return currency;
  const pageSize = validateBoundedInteger(
    input.pageSize,
    GOOGLE_ADS_DEFAULT_PLANNER_PAGE_SIZE,
    1,
    GOOGLE_ADS_MAX_PLANNER_PAGE_SIZE,
    "page size",
  );
  if (!pageSize.ok) return pageSize;
  const maxResults = validateBoundedInteger(
    input.maxResults,
    GOOGLE_ADS_DEFAULT_PLANNER_MAX_RESULTS,
    1,
    GOOGLE_ADS_MAX_PLANNER_MAX_RESULTS,
    "result limit",
  );
  if (!maxResults.ok) return maxResults;
  const maxPages = validateBoundedInteger(
    input.maxPages,
    GOOGLE_ADS_MAX_PLANNER_PAGES,
    1,
    GOOGLE_ADS_MAX_PLANNER_PAGES,
    "page limit",
  );
  if (!maxPages.ok) return maxPages;

  const body: Record<string, unknown> = { pageSize: pageSize.value };
  const keywordValues = keywords?.ok ? keywords.value : undefined;
  const urlValue = url?.ok ? url.value : undefined;
  if (keywordValues && urlValue) {
    body.keywordAndUrlSeed = { keywords: keywordValues, url: urlValue };
  } else if (keywordValues) {
    body.keywordSeed = { keywords: keywordValues };
  } else if (urlValue) {
    body.urlSeed = { url: urlValue };
  }
  // An omitted list means "all targeting geos" upstream, so the field is only
  // sent when the caller actually selected some.
  if (geoTargets.value && geoTargets.value.length > 0) {
    body.geoTargetConstants = geoTargets.value;
  }
  if (language.value) body.language = language.value;
  // averageCpcMicros is only returned when the request asks for it.
  body.historicalMetricsOptions = { includeAverageCpc: true };

  return {
    ok: true,
    value: {
      body,
      pageSize: pageSize.value,
      maxResults: maxResults.value,
      maxPages: maxPages.value,
      currencyCode: currency.value,
    },
  };
}

export type GoogleAdsHistoricalMetricsRequest = {
  body: Record<string, unknown>;
  /** The validated keyword list that was requested. */
  keywords: string[];
  currencyCode: string | null;
};

/** Builds the `generateKeywordHistoricalMetrics` request body. That endpoint
 *  has no paging contract: no pageSize and no pageToken are ever sent. The
 *  official v26 request accepts at most 10,000 keywords, so the whole
 *  validated input fits into ONE request — there is no batching loop, and
 *  therefore no unbounded loop to guard against. */
export function buildHistoricalMetricsRequest(
  input: GoogleAdsHistoricalMetricsInput,
):
  | { ok: true; value: GoogleAdsHistoricalMetricsRequest }
  | { ok: false; reason: string } {
  if (!Array.isArray(input.keywords)) {
    return fail("Google Ads historical metrics need an array of keywords.");
  }
  if (input.keywords.length === 0) {
    return fail("Google Ads historical metrics need at least one keyword.");
  }
  if (input.keywords.length > GOOGLE_ADS_MAX_HISTORICAL_KEYWORDS) {
    return fail(
      `Google Ads accepts at most ${GOOGLE_ADS_MAX_HISTORICAL_KEYWORDS} keywords per historical-metrics request.`,
    );
  }
  const keywords: string[] = [];
  for (const entry of input.keywords) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      return fail(
        "Google Ads historical metric keywords must be non-empty strings.",
      );
    }
    keywords.push(entry.trim());
  }
  const geoTargets = validateGeoTargetConstants(input.geoTargetConstants);
  if (!geoTargets.ok) return geoTargets;
  const language = validateLanguageConstant(input.language);
  if (!language.ok) return language;
  const currency = validateCurrencyCode(input.currencyCode);
  if (!currency.ok) return currency;

  const body: Record<string, unknown> = { keywords };
  if (geoTargets.value && geoTargets.value.length > 0) {
    body.geoTargetConstants = geoTargets.value;
  }
  if (language.value) body.language = language.value;
  body.historicalMetricsOptions = { includeAverageCpc: true };

  return { ok: true, value: { body, keywords, currencyCode: currency.value } };
}

/** Converts account-currency micros into account-currency units. The
 *  conversion is explicit on purpose: money leaves this client in micros
 *  unless a caller asks for the conversion, and a bid range is never
 *  relabeled as a cost per click. */
export function googleAdsMicrosToAmount(micros: number | null): number | null {
  if (micros === null) return null;
  return micros / 1_000_000;
}
