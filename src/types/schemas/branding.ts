import { z } from "zod";

// Agency branding (org-scoped) and client profiles (project-scoped).
// Logo uploads travel as base64 data URLs validated server-side
// (MIME/size/dimensions); the transport cap fails fast on abuse.
const logoDataUrlSchema = z.string().max(1_000_000);

export const setOrganizationBrandingSchema = z
  .object({
    agencyName: z.string().min(1).max(120),
    accentColor: z.string().max(7).nullable().optional(),
    footerText: z.string().max(500).nullable().optional(),
    logoDataUrl: logoDataUrlSchema.optional(),
    removeLogo: z.boolean().optional(),
  })
  .strict();

export const setClientProfileSchema = z
  .object({
    projectId: z.string().min(1),
    clientName: z.string().min(1).max(120),
    reportTitleOverride: z.string().max(120).nullable().optional(),
    notes: z.string().max(2000).nullable().optional(),
    logoDataUrl: logoDataUrlSchema.optional(),
    removeLogo: z.boolean().optional(),
  })
  .strict();

export const getClientProfileSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
