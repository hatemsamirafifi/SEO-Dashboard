/* eslint-disable max-lines */
import { z } from "zod";
import type {
  GoogleAdsDailyAccountRow,
  GoogleAdsDailyAdGroupRow,
  GoogleAdsDailyCampaignRow,
  GoogleAdsDailyDeviceRow,
  GoogleAdsDailyKeywordRow,
  GoogleAdsDailyLandingPageRow,
  GoogleAdsDailyMetrics,
  GoogleAdsDailySearchTermRow,
  GoogleAdsDevice,
  GoogleAdsKeywordMatchType,
} from "./googleAdsReporting";

/* Per-row parsers for the fixed daily reporting reads. v26 REST rows are
 * lowerCamelCase JSON with the selected resource nested under its resource
 * key. Every row either becomes a typed fact or is counted as malformed —
 * partial data is reported by the caller, never silently rebuilt. */

/** Per-row parse envelope. */
export type DailyRowParseResult<T> = { ok: true; value: T } | { ok: false };

export type GoogleAdsDailyPageParse<T> =
  | {
      ok: true;
      value: { rows: T[]; malformedRows: number; nextPageToken: string | null };
    }
  | { ok: false };

const RESOURCE_MAX_LENGTH = 512;
const TEXT_MAX_LENGTH = 255;
const URL_MAX_LENGTH = 2048;

const CUSTOMER_RESOURCE_PATTERN = /^customers\/\d{10}$/;
const CAMPAIGN_RESOURCE_PATTERN = /^customers\/\d{10}\/campaigns\/\d+$/;
const AD_GROUP_RESOURCE_PATTERN = /^customers\/\d{10}\/adGroups\/\d+$/;
const AD_GROUP_CRITERION_RESOURCE_PATTERN =
  /^customers\/\d{10}\/adGroupCriteria\/\d+$/;
const SEARCH_TERM_VIEW_RESOURCE_PATTERN =
  /^customers\/\d{10}\/searchTermViews\/.+$/;
const LANDING_PAGE_VIEW_RESOURCE_PATTERN =
  /^customers\/\d{10}\/landingPageViews\/.+$/;
const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const DIGITS_PATTERN = /^\d+$/;
const DOUBLE_NUMBER_PATTERN = /^-?\d+(?:\.\d+)?$/;

const DEVICE_MAP: Record<string, GoogleAdsDevice> = {
  CONNECTED_TV: "CONNECTED_TV",
  DESKTOP: "DESKTOP",
  MOBILE: "MOBILE",
  OTHER: "OTHER",
  TABLET: "TABLET",
  UNKNOWN: "UNKNOWN",
  UNSPECIFIED: "UNSPECIFIED",
};

const MATCH_TYPE_MAP: Record<string, GoogleAdsKeywordMatchType> = {
  EXACT: "EXACT",
  PHRASE: "PHRASE",
  BROAD: "BROAD",
};

const recordSchema = z.record(z.string(), z.unknown());

function fail(): { ok: false } {
  return { ok: false };
}

function ok<T>(value: T): { ok: true; value: T } {
  return { ok: true, value };
}

function readObject(value: unknown): Record<string, unknown> | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "object" || Array.isArray(value)) return null;
  const parsed = recordSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

function readDateValue(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return fail();
  const date = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
    ? ok(value)
    : fail();
}

function readOptionalText(
  value: unknown,
  maxLength: number,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  if (typeof value !== "string" || value.length > maxLength) return fail();
  return value.trim().length === 0 ? ok(null) : ok(value);
}

function readRequiredText(
  value: unknown,
  maxLength: number,
): { ok: true; value: string } | { ok: false } {
  if (
    typeof value !== "string" ||
    value.length > maxLength ||
    value.trim().length === 0
  ) {
    return fail();
  }
  return ok(value);
}

function readResource(
  value: unknown,
  pattern: RegExp,
): { ok: true; value: string } | { ok: false } {
  if (
    typeof value !== "string" ||
    value.length > RESOURCE_MAX_LENGTH ||
    !pattern.test(value)
  ) {
    return fail();
  }
  return ok(value);
}

function readOptionalResource(
  value: unknown,
  pattern: RegExp,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  const read = readResource(value, pattern);
  return read.ok ? ok(read.value) : fail();
}

function readIdText(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0
      ? ok(String(value))
      : fail();
  }
  return typeof value === "string" && DIGITS_PATTERN.test(value)
    ? ok(value)
    : fail();
}

function readOptionalIdText(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  return readIdText(value);
}

/** impressions/clicks: overlarge int64 digit strings fail the row instead of
 *  round-tripping through a lossy float. */
function readCountMetric(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? ok(value) : fail();
  }
  if (typeof value === "string" && DIGITS_PATTERN.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? ok(parsed) : fail();
  }
  return fail();
}

/** costMicros: an overlarge int64 stays digits text so consumers can do
 *  explicit big-integer math across the account currency conversion. */
function readRetainedInt64Metric(
  value: unknown,
): { ok: true; value: number | string | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  if (typeof value === "number") {
    return Number.isSafeInteger(value) && value >= 0 ? ok(value) : fail();
  }
  if (typeof value === "string" && DIGITS_PATTERN.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? ok(parsed) : ok(value);
  }
  return fail();
}

function readDoubleMetric(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  if (typeof value === "number") {
    return Number.isFinite(value) ? ok(value) : fail();
  }
  return typeof value === "string" && DOUBLE_NUMBER_PATTERN.test(value)
    ? ok(Number(value))
    : fail();
}

function readMetrics(
  value: unknown,
): { ok: true; value: GoogleAdsDailyMetrics } | { ok: false } {
  if (value === undefined || value === null) {
    return ok({
      impressions: null,
      clicks: null,
      costMicros: null,
      conversions: null,
      conversionsValue: null,
    });
  }
  const source = readObject(value);
  if (!source) return fail();
  const impressions = readCountMetric(source.impressions);
  if (!impressions.ok) return fail();
  const clicks = readCountMetric(source.clicks);
  if (!clicks.ok) return fail();
  const costMicros = readRetainedInt64Metric(source.costMicros);
  if (!costMicros.ok) return fail();
  const conversions = readDoubleMetric(source.conversions);
  if (!conversions.ok) return fail();
  const conversionsValue = readDoubleMetric(source.conversionsValue);
  if (!conversionsValue.ok) return fail();
  return ok({
    impressions: impressions.value,
    clicks: clicks.value,
    costMicros: costMicros.value,
    conversions: conversions.value,
    conversionsValue: conversionsValue.value,
  });
}

function readDeviceValue(
  value: unknown,
): { ok: true; value: GoogleAdsDevice } | { ok: false } {
  if (typeof value !== "string") return fail();
  const device = DEVICE_MAP[value];
  return device === undefined ? fail() : ok(device);
}

function readOptionalMatchType(
  value: unknown,
): { ok: true; value: GoogleAdsKeywordMatchType | null } | { ok: false } {
  if (value === undefined || value === null) return ok(null);
  if (value === "UNKNOWN" || value === "UNSPECIFIED") return ok(null);
  if (typeof value !== "string") return fail();
  const matchType = MATCH_TYPE_MAP[value];
  return matchType === undefined ? fail() : ok(matchType);
}

function readSegmentDate(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  const segments = readObject(value);
  if (!segments) return fail();
  return readDateValue(segments.date);
}

function readCampaignResource(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  const campaign = readObject(value);
  if (!campaign) return fail();
  return readResource(campaign.resourceName, CAMPAIGN_RESOURCE_PATTERN);
}

function readAdGroupResource(
  value: unknown,
): { ok: true; value: string } | { ok: false } {
  const adGroup = readObject(value);
  if (!adGroup) return fail();
  return readResource(adGroup.resourceName, AD_GROUP_RESOURCE_PATTERN);
}

export function extractGoogleAdsDailyAccountRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyAccountRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const customer = readObject(row.customer);
  if (!customer) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const resourceName = readResource(
    customer.resourceName,
    CUSTOMER_RESOURCE_PATTERN,
  );
  if (!resourceName.ok) return fail();
  const displayName = readOptionalText(
    customer.descriptiveName,
    TEXT_MAX_LENGTH,
  );
  if (!displayName.ok) return fail();
  const currencyCode = readOptionalText(customer.currencyCode, TEXT_MAX_LENGTH);
  if (!currencyCode.ok) return fail();
  const timeZone = readOptionalText(customer.timeZone, TEXT_MAX_LENGTH);
  if (!timeZone.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    resourceName: resourceName.value,
    displayName: displayName.value,
    currencyCode: currencyCode.value,
    timeZone: timeZone.value,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailyCampaignRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyCampaignRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const campaign = readObject(row.campaign);
  if (!campaign) return fail();
  const campaignResourceId = readResource(
    campaign.resourceName,
    CAMPAIGN_RESOURCE_PATTERN,
  );
  if (!campaignResourceId.ok) return fail();
  const campaignId = readOptionalIdText(campaign.id);
  if (!campaignId.ok) return fail();
  const campaignName = readOptionalText(campaign.name, TEXT_MAX_LENGTH);
  if (!campaignName.ok) return fail();
  const campaignStatus = readOptionalText(campaign.status, TEXT_MAX_LENGTH);
  if (!campaignStatus.ok) return fail();
  const servingStatus = readOptionalText(
    campaign.servingStatus,
    TEXT_MAX_LENGTH,
  );
  if (!servingStatus.ok) return fail();
  const advertisingChannelType = readOptionalText(
    campaign.advertisingChannelType,
    TEXT_MAX_LENGTH,
  );
  if (!advertisingChannelType.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    campaignId: campaignId.value,
    campaignName: campaignName.value,
    campaignStatus: campaignStatus.value,
    servingStatus: servingStatus.value,
    advertisingChannelType: advertisingChannelType.value,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailyAdGroupRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyAdGroupRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const adGroup = readObject(row.adGroup);
  if (!adGroup) return fail();
  const adGroupResourceId = readResource(
    adGroup.resourceName,
    AD_GROUP_RESOURCE_PATTERN,
  );
  if (!adGroupResourceId.ok) return fail();
  const campaignResourceId = readCampaignResource(row.campaign);
  if (!campaignResourceId.ok) return fail();
  const adGroupId = readOptionalIdText(adGroup.id);
  if (!adGroupId.ok) return fail();
  const adGroupName = readOptionalText(adGroup.name, TEXT_MAX_LENGTH);
  if (!adGroupName.ok) return fail();
  const adGroupStatus = readOptionalText(adGroup.status, TEXT_MAX_LENGTH);
  if (!adGroupStatus.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    adGroupResourceId: adGroupResourceId.value,
    adGroupId: adGroupId.value,
    adGroupName: adGroupName.value,
    adGroupStatus: adGroupStatus.value,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailyKeywordRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyKeywordRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const criterion = readObject(row.adGroupCriterion);
  if (!criterion) return fail();
  const keywordResourceId = readResource(
    criterion.resourceName,
    AD_GROUP_CRITERION_RESOURCE_PATTERN,
  );
  if (!keywordResourceId.ok) return fail();
  const criterionId = readIdText(criterion.criterionId);
  if (!criterionId.ok) return fail();
  let keywordText: string | null = null;
  let keywordMatchType: GoogleAdsKeywordMatchType | null = null;
  const keyword = readObject(criterion.keyword);
  if (keyword) {
    const text = readOptionalText(keyword.text, TEXT_MAX_LENGTH);
    if (!text.ok) return fail();
    const matchType = readOptionalMatchType(keyword.matchType);
    if (!matchType.ok) return fail();
    keywordText = text.value;
    keywordMatchType = matchType.value;
  }
  const adGroupResourceId = readAdGroupResource(row.adGroup);
  if (!adGroupResourceId.ok) return fail();
  const campaignResourceId = readCampaignResource(row.campaign);
  if (!campaignResourceId.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    adGroupResourceId: adGroupResourceId.value,
    keywordResourceId: keywordResourceId.value,
    criterionId: criterionId.value,
    keywordText,
    keywordMatchType,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailySearchTermRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailySearchTermRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const view = readObject(row.searchTermView);
  if (!view) return fail();
  const searchText = readRequiredText(view.searchTerm, TEXT_MAX_LENGTH);
  if (!searchText.ok) return fail();
  const searchTermResourceId = readOptionalResource(
    view.resourceName,
    SEARCH_TERM_VIEW_RESOURCE_PATTERN,
  );
  if (!searchTermResourceId.ok) return fail();
  const adGroupResourceId = readAdGroupResource(row.adGroup);
  if (!adGroupResourceId.ok) return fail();
  const campaignResourceId = readCampaignResource(row.campaign);
  if (!campaignResourceId.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  // v26 search_term_view carries no matched-keyword attributes: they stay
  // null instead of being guessed from another resource.
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    adGroupResourceId: adGroupResourceId.value,
    searchTermResourceId: searchTermResourceId.value,
    searchText: searchText.value,
    keywordText: null,
    keywordMatchType: null,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailyDeviceRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyDeviceRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const segments = readObject(row.segments);
  if (!segments) return fail();
  const date = readDateValue(segments.date);
  if (!date.ok) return fail();
  const device = readDeviceValue(segments.device);
  if (!device.ok) return fail();
  const campaignResourceId = readCampaignResource(row.campaign);
  if (!campaignResourceId.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    device: device.value,
    metrics: metrics.value,
  });
}

export function extractGoogleAdsDailyLandingPageRow(
  rowSource: unknown,
): DailyRowParseResult<GoogleAdsDailyLandingPageRow> {
  const row = readObject(rowSource);
  if (!row) return fail();
  const date = readSegmentDate(row.segments);
  if (!date.ok) return fail();
  const view = readObject(row.landingPageView);
  if (!view) return fail();
  const landingPageResourceId = readResource(
    view.resourceName,
    LANDING_PAGE_VIEW_RESOURCE_PATTERN,
  );
  if (!landingPageResourceId.ok) return fail();
  const landingPageUrl = readRequiredText(
    view.unexpandedFinalUrl,
    URL_MAX_LENGTH,
  );
  if (!landingPageUrl.ok) return fail();
  const campaignResourceId = readCampaignResource(row.campaign);
  if (!campaignResourceId.ok) return fail();
  const metrics = readMetrics(row.metrics);
  if (!metrics.ok) return fail();
  return ok({
    date: date.value,
    campaignResourceId: campaignResourceId.value,
    landingPageResourceId: landingPageResourceId.value,
    landingPageUrl: landingPageUrl.value,
    metrics: metrics.value,
  });
}

/** One bounded Search page: absent/null `results` is an empty successful
 *  page; a present non-array is a malformed payload; malformed rows are
 *  counted, not dropped silently. */
export function parseGoogleAdsDailyPage<T>(
  payload: unknown,
  extractRow: (row: unknown) => DailyRowParseResult<T>,
): GoogleAdsDailyPageParse<T> {
  const body = readObject(payload);
  if (!body) return fail();
  const results = body.results;
  if (results !== undefined && results !== null && !Array.isArray(results)) {
    return fail();
  }
  const rows: T[] = [];
  let malformedRows = 0;
  for (const entry of results ?? []) {
    const parsed = extractRow(entry);
    if (!parsed.ok) {
      malformedRows += 1;
      continue;
    }
    rows.push(parsed.value);
  }
  const token = body.nextPageToken;
  if (
    token !== undefined &&
    token !== null &&
    (typeof token !== "string" || token.length === 0)
  ) {
    return fail();
  }
  return ok({
    rows,
    malformedRows,
    nextPageToken: typeof token === "string" ? token : null,
  });
}
