import { z } from "zod";

export const ga4ProjectSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
export const setGa4PropertySchema = ga4ProjectSchema
  .extend({
    accountId: z.string().min(1),
    propertyId: z.string().min(1),
  })
  .strict();
export const startGa4LinkSchema = z
  .object({ projectId: z.string().min(1), callbackURL: z.string().min(1) })
  .strict();

const ga4DateSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const triggerGa4SyncSchema = ga4ProjectSchema
  .extend({
    syncType: z.enum(["initial", "incremental", "manual"]).default("manual"),
    startDate: ga4DateSchema.optional(),
    endDate: ga4DateSchema.optional(),
  })
  .strict();
export const ga4SyncStatusSchema = ga4ProjectSchema;
export const ga4PeriodUsersSchema = ga4ProjectSchema
  .extend({ startDate: ga4DateSchema, endDate: ga4DateSchema })
  .strict()
  .refine((value) => value.startDate <= value.endDate, {
    message: "startDate must not be after endDate",
  });

/** Analytics page ranges (final-plan §9.6 toolbar: 7/28/30/90d). A deliberate
 *  subset distinct from the GSC ranges — day counts are compiler-checked at
 *  the ANALYTICS_RANGE_DAYS call site. */
export const ANALYTICS_RANGES = [
  "last_7_days",
  "last_28_days",
  "last_30_days",
  "last_90_days",
] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const ANALYTICS_RANGE_DAYS: Record<AnalyticsRange, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_30_days: 30,
  last_90_days: 90,
};

/** GA4 `deviceCategory` dimension values (lowercase, as the Data API
 *  returns them). */
export const GA4_ANALYTICS_DEVICES = ["desktop", "mobile", "tablet"] as const;

// Shared analytics-page filters. Channel filters acquisition/landing reads;
// device/country are accepted and echoed for forward-compat (geo/tech grains
// are deferred per §22) — the service documents them as not yet applied.
const analyticsFilterShape = {
  projectId: z.string().min(1),
  range: z.enum(ANALYTICS_RANGES).default("last_28_days"),
  channel: z.string().min(1).max(100).optional(),
  device: z.enum(GA4_ANALYTICS_DEVICES).optional(),
  country: z.string().min(1).max(100).optional(),
};

export const analyticsOverviewSchema = z.object(analyticsFilterShape).strict();
export const analyticsAcquisitionSchema = z
  .object(analyticsFilterShape)
  .strict();
export const analyticsLandingPagesSchema = z
  .object({
    ...analyticsFilterShape,
    // Router search params arrive as strings; coerce matches the
    // domain/backlinks precedent for numeric page params.
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
