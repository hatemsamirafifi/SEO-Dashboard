import { db } from "@/db";
import {
  organizationBranding,
  projectClientProfiles,
} from "@/db/schema";
import { eq } from "drizzle-orm";

export type OrganizationBrandingRow =
  typeof organizationBranding.$inferSelect;
export type ClientProfileRow = typeof projectClientProfiles.$inferSelect;

async function getOrganizationBranding(
  organizationId: string,
): Promise<OrganizationBrandingRow | null> {
  const rows = await db
    .select()
    .from(organizationBranding)
    .where(eq(organizationBranding.organizationId, organizationId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertOrganizationBranding(values: {
  organizationId: string;
  agencyName: string;
  agencyLogoR2Key: string | null;
  accentColor: string | null;
  footerText: string | null;
}): Promise<OrganizationBrandingRow> {
  const timestamp = new Date().toISOString();
  await db
    .insert(organizationBranding)
    .values({ ...values, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: organizationBranding.organizationId,
      set: {
        agencyName: values.agencyName,
        agencyLogoR2Key: values.agencyLogoR2Key,
        accentColor: values.accentColor,
        footerText: values.footerText,
        updatedAt: timestamp,
      },
    });
  const row = await getOrganizationBranding(values.organizationId);
  if (!row) throw new Error("Failed to upsert organization branding");
  return row;
}

async function getClientProfile(
  projectId: string,
): Promise<ClientProfileRow | null> {
  const rows = await db
    .select()
    .from(projectClientProfiles)
    .where(eq(projectClientProfiles.projectId, projectId))
    .limit(1);
  return rows[0] ?? null;
}

async function upsertClientProfile(values: {
  projectId: string;
  clientName: string;
  clientLogoR2Key: string | null;
  reportTitleOverride: string | null;
  notes: string | null;
}): Promise<ClientProfileRow> {
  const timestamp = new Date().toISOString();
  await db
    .insert(projectClientProfiles)
    .values({ ...values, createdAt: timestamp, updatedAt: timestamp })
    .onConflictDoUpdate({
      target: projectClientProfiles.projectId,
      set: {
        clientName: values.clientName,
        clientLogoR2Key: values.clientLogoR2Key,
        reportTitleOverride: values.reportTitleOverride,
        notes: values.notes,
        updatedAt: timestamp,
      },
    });
  const row = await getClientProfile(values.projectId);
  if (!row) throw new Error("Failed to upsert client profile");
  return row;
}

export const BrandingRepository = {
  getOrganizationBranding,
  upsertOrganizationBranding,
  getClientProfile,
  upsertClientProfile,
};
