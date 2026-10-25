import { z } from "zod";
import { normalizeGoogleAdsCustomerId } from "@/shared/google-ads";

/** Google Ads customer ids are exactly ten digits. The shared normalizer
 *  accepts hyphens and spaces as separators; every other character makes the
 *  whole value invalid and is never silently dropped. */
export const googleAdsCustomerIdSchema = z
  .string()
  .trim()
  .min(1)
  .max(32)
  .transform((value, ctx) => {
    const normalized = normalizeGoogleAdsCustomerId(value);
    if (!normalized) {
      ctx.addIssue({
        code: "custom",
        message: "Google Ads customer IDs must be ten digits.",
      });
      return z.NEVER;
    }
    return normalized;
  });

/** Every project-scoped action carries the project id in its payload: the
 *  shared middleware reads it to authorize the project inside the caller's
 *  organization before the handler runs. Organization and user ids are never
 *  accepted from the client — they come from the authenticated context. */
export const googleAdsProjectSchema = z
  .object({ projectId: z.string().min(1).max(200) })
  .strict();

/** The Google OAuth `sub` of a granted account (never an Ads customer id and
 *  never a better-auth account row id). */
const googleAdsGrantAccountIdSchema = z.string().min(1).max(200);

/** Direct account discovery. Every Ads grant the caller owns is probed unless
 *  one grant is named explicitly. */
export const googleAdsDiscoverySchema = googleAdsProjectSchema
  .extend({ grantAccountId: googleAdsGrantAccountIdSchema.optional() })
  .strict();

/** Explicit manager expansion: one accessible manager root under one grant. */
export const googleAdsManagerChildrenSchema = googleAdsProjectSchema
  .extend({
    grantAccountId: googleAdsGrantAccountIdSchema,
    managerId: googleAdsCustomerIdSchema,
  })
  .strict();

/** Customer selection: the serving account, optionally reached through an
 *  accessible manager (the login customer). */
export const googleAdsSelectCustomerSchema = googleAdsProjectSchema
  .extend({
    grantAccountId: googleAdsGrantAccountIdSchema,
    customerId: googleAdsCustomerIdSchema,
    loginCustomerId: googleAdsCustomerIdSchema.optional(),
  })
  .strict();

export const googleAdsConnectionTestSchema = googleAdsProjectSchema;

export const googleAdsDisconnectSchema = googleAdsProjectSchema;

/** The OAuth return path is built on the server from the trusted project id,
 *  so a client can never redirect the callback to another project or origin. */
export const googleAdsLinkSchema = googleAdsProjectSchema;

// ---------------------------------------------------------------------------
// Stored analytics + durable sync (master-plan phases 3 & 7)
// ---------------------------------------------------------------------------

const googleAdsDateSchema = z.string().refine(
  (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const date = new Date(`${value}T00:00:00.000Z`);
    return (
      !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
    );
  },
  { message: "Expected a calendar date (YYYY-MM-DD)" },
);

function monthsSpan(start: string, end: string): number {
  const [startYear, startMonth] = start.split("-").map(Number);
  const [endYear, endMonth] = end.split("-").map(Number);
  return endYear * 12 + endMonth - (startYear * 12 + startMonth) + 1;
}

/** Optional server-side read window. Windows are validated like the storage
 *  asserts: real calendar dates, start <= end, and the 37-month reporting
 *  cap Google Ads itself enforces. */
const googleAdsWindowObjectSchema = googleAdsProjectSchema
  .extend({
    startDate: googleAdsDateSchema.optional(),
    endDate: googleAdsDateSchema.optional(),
  })
  .strict();

function refineWindow<
  T extends z.ZodType<z.output<typeof googleAdsWindowObjectSchema>>,
>(schema: T) {
  return schema.superRefine((value, ctx) => {
    if ((value.startDate === undefined) !== (value.endDate === undefined)) {
      ctx.addIssue({
        code: "custom",
        path: ["startDate"],
        message: "startDate and endDate must be provided together",
      });
      return;
    }
    const { startDate, endDate } = value;
    if (startDate !== undefined && endDate !== undefined) {
      if (startDate > endDate) {
        ctx.addIssue({
          code: "custom",
          path: ["startDate"],
          message: "startDate must not be after endDate",
        });
      }
      if (monthsSpan(startDate, endDate) > 37) {
        ctx.addIssue({
          code: "custom",
          path: ["endDate"],
          message: "Windows are capped at 37 months",
        });
      }
    }
  });
}

export const googleAdsAnalyticsWindowSchema = refineWindow(
  googleAdsWindowObjectSchema,
);

/** Manual sync trigger: an explicit window is optional (both or none) and,
 *  when given, must be ordered and stay inside the reporting cap. */
export const googleAdsSyncTriggerSchema = googleAdsAnalyticsWindowSchema;

const googleAdsBreakdownShape = z.object({
  /** Exact search-term text filter (totals for exactly one term). */
  searchText: z.string().trim().min(1).max(255).optional(),
  /** Case-insensitive LIKE %…% filter for search-term text. */
  searchTextLike: z.string().trim().min(1).max(255).optional(),
  /** Restrict device / landing-page grains to one campaign. */
  campaignResourceId: z.string().trim().min(1).max(512).optional(),
});

export const googleAdsCampaignBreakdownSchema = refineWindow(
  googleAdsWindowObjectSchema,
);
export const googleAdsAdGroupBreakdownSchema = refineWindow(
  googleAdsWindowObjectSchema,
);
export const googleAdsKeywordBreakdownSchema = refineWindow(
  googleAdsWindowObjectSchema,
);
export const googleAdsSearchTermBreakdownSchema = refineFieldOptions(
  refineWindow(
    googleAdsWindowObjectSchema.extend(googleAdsBreakdownShape.shape).strict(),
  ),
  (value, ctx) => {
    if (value.searchText !== undefined && value.searchTextLike !== undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["searchText"],
        message: "At most one of searchText or searchTextLike may be provided",
      });
    }
  },
);
export const googleAdsDeviceBreakdownSchema = refineWindow(
  googleAdsWindowObjectSchema.extend(googleAdsBreakdownShape.shape).strict(),
);
export const googleAdsLandingPageBreakdownSchema = refineWindow(
  googleAdsWindowObjectSchema.extend(googleAdsBreakdownShape.shape).strict(),
);

function refineFieldOptions<
  T extends z.ZodType<{
    searchText?: string;
    searchTextLike?: string;
    campaignResourceId?: string;
  }>,
>(schema: T, refine: (value: z.output<T>, ctx: z.RefinementCtx) => void) {
  return schema.superRefine(refine);
}
