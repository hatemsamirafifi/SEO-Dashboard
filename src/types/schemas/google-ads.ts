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
