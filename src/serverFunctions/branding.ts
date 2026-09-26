import { createServerFn } from "@tanstack/react-start";
import { BrandingService } from "@/server/features/reports/services/BrandingService";
import {
  getClientProfileSchema,
  setClientProfileSchema,
  setOrganizationBrandingSchema,
} from "@/types/schemas/branding";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "./middleware";

/**
 * Agency branding (org-scoped) and client profiles (project-scoped).
 * The organization editor lives in Project Settings only because no
 * org-level settings surface exists; the data stays org-scoped.
 */
export const getOrganizationBranding = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  // Validator-less like getProjects: the harness cannot execute org-only
  // functions either way (it echoes the input context unexecuted), so the
  // read path is covered at the service level instead.
  .handler(async ({ context }) => {
    const branding = await BrandingService.getOrganizationBranding({
      organizationId: context.organizationId,
    });
    return { branding };
  });

export const setOrganizationBranding = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(setOrganizationBrandingSchema)
  .handler(async ({ context, data }) => {
    const branding = await BrandingService.setOrganizationBranding({
      organizationId: context.organizationId,
      agencyName: data.agencyName,
      accentColor: data.accentColor,
      footerText: data.footerText,
      logoDataUrl: data.logoDataUrl,
      removeLogo: data.removeLogo,
    });
    return { branding };
  });

export const getClientProfile = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getClientProfileSchema)
  .handler(async ({ context }) => {
    const profile = await BrandingService.getClientProfile({
      projectId: context.projectId,
    });
    return { profile };
  });

export const setClientProfile = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setClientProfileSchema)
  .handler(async ({ context, data }) => {
    const profile = await BrandingService.setClientProfile({
      projectId: context.projectId,
      clientName: data.clientName,
      reportTitleOverride: data.reportTitleOverride,
      notes: data.notes,
      logoDataUrl: data.logoDataUrl,
      removeLogo: data.removeLogo,
    });
    return { profile };
  });
