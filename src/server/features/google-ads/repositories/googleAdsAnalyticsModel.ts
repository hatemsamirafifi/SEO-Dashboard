import { z } from "zod";

// Shared contracts for Google Ads stored analytics (master plan phase 3).
// The sync worker and the stored analytics service both talk through the
// GoogleAdsAnalyticsRepository, which validates every untrusted/dynamic
// boundary with these schemas. Types stay narrow because callers pass
// already-typed rows; these schemas are the runtime guard at the boundary.

/** Daily fact grains. Every grain is stored separately and MUST never be
 *  summed together with another grain. */
export const GOOGLE_ADS_GRAINS = [
  "account",
  "campaign",
  "ad_group",
  "keyword",
  "search_term",
  "device",
  "landing_page",
] as const;
export type GoogleAdsGrain = (typeof GOOGLE_ADS_GRAINS)[number];

/** Unit-coverage statuses. Only success_* counts as complete coverage.
 *  'partial' is a fetch the worker knows was incomplete — it never becomes
 *  known zero and is immediately retryable. */
export const GOOGLE_ADS_UNIT_STATUSES = [
  "pending",
  "success_with_data",
  "success_zero_rows",
  "partial",
  "failed",
] as const;
export type GoogleAdsUnitStatus = (typeof GOOGLE_ADS_UNIT_STATUSES)[number];

export const GOOGLE_ADS_SUCCESS_UNIT_STATUSES: readonly GoogleAdsUnitStatus[] =
  ["success_with_data", "success_zero_rows"];

/** Conversion date basis. Standard Ads conversions report by INTERACTION
 *  date (unlike GA4 event date); 'conversion_date' is the byConversionDate
 *  variant. Storage records what the source reported; downstream evidence
 *  must include the basis. */
export const GOOGLE_ADS_METRIC_DATE_BASES = [
  "interaction_date",
  "conversion_date",
] as const;
export type GoogleAdsMetricDateBasis =
  (typeof GOOGLE_ADS_METRIC_DATE_BASES)[number];

/** Bounded account-level sync error classes (phase 7). Never upstream
 *  response bodies. */
export const GOOGLE_ADS_SYNC_ERROR_CLASSES = [
  "TRANSIENT",
  "PERMISSION",
  "AUTH",
  "QUOTA_TRANSIENT",
  "QUOTA_EXHAUSTED",
  "CONNECTION_CHANGED",
  "DISCONNECTED",
  "INVALID_WINDOW",
  "INTERNAL",
  "FENCED",
  "LEASE_EXPIRED",
  "ABANDONED",
] as const;
export type GoogleAdsSyncErrorClass =
  (typeof GOOGLE_ADS_SYNC_ERROR_CLASSES)[number];

/** Ads Device enum strings accepted at the storage boundary. */
export const GOOGLE_ADS_DEVICES = [
  "CONNECTED_TV",
  "DESKTOP",
  "MOBILE",
  "OTHER",
  "TABLET",
  "UNKNOWN",
  "UNSPECIFIED",
] as const;

/** Daily base metrics. Null/undefined means "not reported by the source
 *  query" — never a fabricated zero. costMicros is a bounded safe integer of
 *  the account currency's micros; conversions MAY be fractional; the
 *  conversion value is the plain currency value (NOT micros). */
export type GoogleAdsMetrics = {
  impressions?: number | null;
  clicks?: number | null;
  costMicros?: number | null;
  conversions?: number | null;
  conversionsValue?: number | null;
};

/** A metric total summed over compatible rows; `hasMissingComponents` is
 *  true when any summed row did not report the metric, so the total must not
 *  be presented as a complete numeric total. */
export type GoogleAdsMetricTotal = {
  total: number | null;
  hasMissingComponents: boolean;
};

const ISO_DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const ISO_INSTANT_MAX_LENGTH = 64;
const RESOURCE_ID_MAX_LENGTH = 512;
const TEXT_DIMENSION_MAX_LENGTH = 255;
const URL_MAX_LENGTH = 2048;
/** Bounded rows per publish attempt (per chunk via runBatch anyway). */
const MAX_ROWS_PER_UNIT = 5000;

export function isGoogleAdsIsoDate(value: unknown): value is string {
  if (typeof value !== "string" || !ISO_DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime())) return false;
  return parsed.toISOString().slice(0, 10) === value;
}

export function isGoogleAdsIsoInstant(value: unknown): value is string {
  if (typeof value !== "string" || value.length > ISO_INSTANT_MAX_LENGTH) {
    return false;
  }
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime());
}

const isoDateSchema = z
  .string()
  .refine(isGoogleAdsIsoDate, { message: "Expected a YYYY-MM-DD date" });

const nonEmptyText = z.string().trim().min(1);
const boundedText = nonEmptyText.max(RESOURCE_ID_MAX_LENGTH);

/** A bounded positive-or-zero metric value; null/undefined both mean "not
 *  reported" and stay null in storage. Overflow (> MAX_SAFE_INTEGER) is
 *  rejected instead of silently losing precision. */
const nullableBoundedMetric = z
  .number()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER)
  .nullish();

const nullableMetricSchema = z
  .object({
    impressions: nullableBoundedMetric,
    clicks: nullableBoundedMetric,
    costMicros: nullableBoundedMetric,
    conversions: nullableBoundedMetric,
    conversionsValue: nullableBoundedMetric,
  })
  .nullish();

/** One staged fact row: dimension fields for its grain plus the metrics. */
export type GoogleAdsStagedFactRow = {
  metrics?: GoogleAdsMetrics | null;
  campaignResourceId?: string;
  adGroupResourceId?: string;
  keywordResourceId?: string;
  searchText?: string;
  keywordText?: string | null;
  keywordMatchType?: string | null;
  device?: string;
  landingPageUrl?: string;
};

function buildRowSchema(dims: Record<string, z.ZodTypeAny>) {
  return z
    .object({
      ...dims,
      metrics: nullableMetricSchema,
    })
    .strict();
}

const grainRowSchemas: Record<
  GoogleAdsGrain,
  z.ZodType<GoogleAdsStagedFactRow>
> = {
  account: buildRowSchema({}),
  campaign: buildRowSchema({ campaignResourceId: boundedText }),
  ad_group: buildRowSchema({
    campaignResourceId: boundedText,
    adGroupResourceId: boundedText,
  }),
  keyword: buildRowSchema({
    campaignResourceId: boundedText,
    adGroupResourceId: boundedText,
    keywordResourceId: boundedText,
  }),
  search_term: buildRowSchema({
    campaignResourceId: boundedText,
    adGroupResourceId: boundedText,
    searchText: nonEmptyText.max(TEXT_DIMENSION_MAX_LENGTH),
    keywordText: nonEmptyText
      .max(TEXT_DIMENSION_MAX_LENGTH)
      .nullish()
      .or(z.literal(null)),
    keywordMatchType: nonEmptyText
      .max(TEXT_DIMENSION_MAX_LENGTH)
      .nullish()
      .or(z.literal(null)),
  }),
  device: buildRowSchema({
    campaignResourceId: boundedText,
    device: z.enum(GOOGLE_ADS_DEVICES),
  }),
  landing_page: buildRowSchema({
    campaignResourceId: boundedText,
    landingPageUrl: nonEmptyText.max(URL_MAX_LENGTH),
  }),
};

/** Validates staged fact rows for a grain. Rejects unknown fields, overlong
 *  dimension values, negative or overflowing metrics, and empty search term
 *  text (the transport maps query-anonymized search term rows to a distinct
 *  non-empty marker when it wants to keep them). */
export function parseStagedFactRows(
  grain: GoogleAdsGrain,
  rows: readonly unknown[],
): GoogleAdsStagedFactRow[] {
  return z.array(grainRowSchemas[grain]).max(MAX_ROWS_PER_UNIT).parse(rows);
}

export const googleAdsUnitScopeSchema = z
  .object({
    organizationId: nonEmptyText,
    projectId: nonEmptyText,
    customerId: z
      .string()
      .regex(/^\d{10}$/, { message: "Expected a ten digit Ads customer id" }),
  })
  .strict();
export type GoogleAdsUnitScope = z.infer<typeof googleAdsUnitScopeSchema>;

export const googleAdsPublishFenceSchema = z
  .object({
    // Immutable id of the google_ads_connections row that authorized this
    // write. A deleted and re-created connection with otherwise identical
    // grant/updatedAt values must still NOT satisfy this fence.
    connectionId: nonEmptyText,
    grantAccountId: nonEmptyText,
    connectionUpdatedAt: z.string().refine(isGoogleAdsIsoInstant),
  })
  .strict();
export type GoogleAdsPublishFence = z.infer<typeof googleAdsPublishFenceSchema>;

export const googleAdsFactsWindowSchema = z
  .object({
    startDate: isoDateSchema,
    endDate: isoDateSchema,
  })
  .refine((v) => v.startDate <= v.endDate, {
    message: "Window start date must not be after the end date",
  });
export type GoogleAdsFactsWindow = z.infer<typeof googleAdsFactsWindowSchema>;
