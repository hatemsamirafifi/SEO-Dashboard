import { env } from "cloudflare:workers";
import { AppError } from "@/server/lib/errors";
import {
  brandingSnapshotSchema,
  type BrandingSnapshot,
} from "@/shared/reports";
import {
  BrandingRepository,
  type ClientProfileRow,
  type OrganizationBrandingRow,
} from "../repositories/BrandingRepository";
import {
  brandLogoKey,
  logoDimensions,
  parseLogoDataUrl,
} from "./brandLogo";

const ACCENT_COLOR_PATTERN = /^#[0-9a-fA-F]{6}$/;

function validateAccentColor(value: string | null): string | null {
  if (value === null) return null;
  if (!ACCENT_COLOR_PATTERN.test(value)) {
    throw new AppError(
      "VALIDATION_ERROR",
      "Accent color must be a hex value like #1a2b3c",
    );
  }
  return value;
}

function validateName(value: string, field: string, max: number): string {
  const trimmed = value.trim();
  if (!trimmed || trimmed.length > max) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${field} must be 1–${max} characters`,
    );
  }
  return trimmed;
}

function validateOptionalText(
  value: string | null | undefined,
  field: string,
  max: number,
): string | null {
  if (value === undefined || value === null) return null;
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new AppError(
      "VALIDATION_ERROR",
      `${field} must be at most ${max} characters`,
    );
  }
  return trimmed ? trimmed : null;
}

type R2Bucket = {
  put(
    key: string,
    value: Uint8Array,
    options?: { httpMetadata?: { contentType?: string } },
  ): Promise<unknown>;
  delete(key: string): Promise<unknown>;
};

function r2(): R2Bucket {
  const bucket = (env as unknown as { R2?: R2Bucket }).R2;
  if (!bucket) throw new AppError("INTERNAL_ERROR", "Object storage unavailable");
  return bucket;
}

/**
 * Stores a validated logo and returns its content-addressed key, deleting the
 * replaced object. `logoDataUrl === undefined` keeps the existing logo;
 * `removeLogo` clears it.
 */
async function storeLogo(input: {
  scope: string;
  logoDataUrl: string | undefined;
  removeLogo: boolean;
  currentKey: string | null;
}): Promise<string | null> {
  if (input.logoDataUrl === undefined) {
    if (!input.removeLogo) return input.currentKey;
    if (input.currentKey) {
      await Promise.resolve(r2().delete(input.currentKey)).catch(
        (error: unknown) => {
          console.error("reports: stale logo delete failed", error);
        },
      );
    }
    return null;
  }
  const parsed = parseLogoDataUrl(input.logoDataUrl);
  logoDimensions(parsed);
  const key = await brandLogoKey(input.scope, parsed.bytes, parsed.mime);
  await r2().put(key, parsed.bytes, {
    httpMetadata: { contentType: parsed.mime },
  });
  if (input.currentKey && input.currentKey !== key) {
    await Promise.resolve(r2().delete(input.currentKey)).catch(
      (error: unknown) => {
        console.error("reports: replaced logo delete failed", error);
      },
    );
  }
  return key;
}

export async function getOrganizationBranding(input: {
  organizationId: string;
}): Promise<OrganizationBrandingRow | null> {
  return BrandingRepository.getOrganizationBranding(input.organizationId);
}

export async function setOrganizationBranding(input: {
  organizationId: string;
  agencyName: string;
  accentColor?: string | null;
  footerText?: string | null;
  logoDataUrl?: string;
  removeLogo?: boolean;
}): Promise<OrganizationBrandingRow> {
  const current = await BrandingRepository.getOrganizationBranding(
    input.organizationId,
  );
  const logoR2Key = await storeLogo({
    scope: input.organizationId,
    logoDataUrl: input.logoDataUrl,
    removeLogo: input.removeLogo ?? false,
    currentKey: current?.agencyLogoR2Key ?? null,
  });
  return BrandingRepository.upsertOrganizationBranding({
    organizationId: input.organizationId,
    agencyName: validateName(input.agencyName, "Agency name", 120),
    agencyLogoR2Key: logoR2Key,
    accentColor: validateAccentColor(input.accentColor ?? null),
    footerText: validateOptionalText(input.footerText, "Footer text", 500),
  });
}

export async function getClientProfile(input: {
  projectId: string;
}): Promise<ClientProfileRow | null> {
  return BrandingRepository.getClientProfile(input.projectId);
}

export async function setClientProfile(input: {
  projectId: string;
  clientName: string;
  reportTitleOverride?: string | null;
  notes?: string | null;
  logoDataUrl?: string;
  removeLogo?: boolean;
}): Promise<ClientProfileRow> {
  const current = await BrandingRepository.getClientProfile(input.projectId);
  const logoR2Key = await storeLogo({
    scope: input.projectId,
    logoDataUrl: input.logoDataUrl,
    removeLogo: input.removeLogo ?? false,
    currentKey: current?.clientLogoR2Key ?? null,
  });
  return BrandingRepository.upsertClientProfile({
    projectId: input.projectId,
    clientName: validateName(input.clientName, "Client name", 120),
    clientLogoR2Key: logoR2Key,
    reportTitleOverride: validateOptionalText(
      input.reportTitleOverride,
      "Report title override",
      120,
    ),
    notes: validateOptionalText(input.notes, "Notes", 2000),
  });
}

/** Resolves the live agency+client combination for the generation freeze. */
export async function resolveBrandingSnapshot(input: {
  organizationId: string;
  projectId: string;
}): Promise<BrandingSnapshot> {
  const [agency, client] = await Promise.all([
    BrandingRepository.getOrganizationBranding(input.organizationId),
    BrandingRepository.getClientProfile(input.projectId),
  ]);
  return brandingSnapshotSchema.parse({
    agency:
      agency && agency.agencyName.trim()
        ? {
            name: agency.agencyName,
            logoR2Key: agency.agencyLogoR2Key,
            accentColor: agency.accentColor,
            footerText: agency.footerText,
          }
        : null,
    client:
      client && client.clientName.trim()
        ? {
            name: client.clientName,
            logoR2Key: client.clientLogoR2Key,
            titleOverride: client.reportTitleOverride,
          }
        : null,
  });
}

export const BrandingService = {
  getOrganizationBranding,
  setOrganizationBranding,
  getClientProfile,
  setClientProfile,
  resolveBrandingSnapshot,
};
