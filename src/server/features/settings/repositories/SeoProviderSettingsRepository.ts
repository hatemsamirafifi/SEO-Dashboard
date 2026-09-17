import { and, eq, isNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { seoProviderSettings } from "@/db/schema";

export type SeoProviderSettingsRow = {
  provider: string;
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  priority?: number | null;
  /** AES-GCM encrypted ciphertext { login, password }, or null. */
  credentialsCiphertext: string | null;
  organizationId: string | null;
  projectId: string | null;
  updatedAt: string;
};

export type SeoProviderSettingsInput = {
  enabled?: boolean;
  circuitBreakerEnabled?: boolean;
  maxRetries?: number;
  priority?: number | null;
  /** Encrypted credentials ciphertext. Pass undefined to preserve existing. */
  credentialsCiphertext?: string | null;
};

const ROW_COLUMNS = {
  provider: seoProviderSettings.provider,
  enabled: seoProviderSettings.enabled,
  circuitBreakerEnabled: seoProviderSettings.circuitBreakerEnabled,
  maxRetries: seoProviderSettings.maxRetries,
  priority: seoProviderSettings.priority,
  credentialsCiphertext: seoProviderSettings.credentials,
  organizationId: seoProviderSettings.organizationId,
  projectId: seoProviderSettings.projectId,
  updatedAt: seoProviderSettings.updatedAt,
};

type RawRow = {
  provider: string;
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  priority: number | null;
  credentialsCiphertext: string | null;
  organizationId: string | null;
  projectId: string | null;
  updatedAt: string;
};

function toRow(raw: RawRow): SeoProviderSettingsRow {
  return {
    provider: raw.provider,
    enabled: Boolean(raw.enabled),
    circuitBreakerEnabled: Boolean(raw.circuitBreakerEnabled),
    maxRetries: raw.maxRetries,
    priority: raw.priority,
    credentialsCiphertext: raw.credentialsCiphertext,
    organizationId: raw.organizationId,
    projectId: raw.projectId,
    updatedAt: raw.updatedAt,
  };
}

export async function getOrganizationProviderSettingsRow(
  organizationId: string,
  provider = "dataforseo",
): Promise<SeoProviderSettingsRow | null> {
  const [row] = await db
    .select(ROW_COLUMNS)
    .from(seoProviderSettings)
    .where(
      and(
        eq(seoProviderSettings.organizationId, organizationId),
        eq(seoProviderSettings.provider, provider),
        isNull(seoProviderSettings.projectId),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

export async function getProjectProviderSettingsRow(
  projectId: string,
  provider = "dataforseo",
): Promise<SeoProviderSettingsRow | null> {
  const [row] = await db
    .select(ROW_COLUMNS)
    .from(seoProviderSettings)
    .where(
      and(
        eq(seoProviderSettings.projectId, projectId),
        eq(seoProviderSettings.provider, provider),
        isNull(seoProviderSettings.organizationId),
      ),
    )
    .limit(1);
  return row ? toRow(row) : null;
}

export async function upsertOrganizationProviderSettingsRow(
  organizationId: string,
  provider: string,
  input: SeoProviderSettingsInput,
): Promise<void> {
  const now = new Date().toISOString();
  const values = {
    organizationId,
    projectId: null,
    provider,
    enabled: input.enabled ?? true,
    circuitBreakerEnabled: input.circuitBreakerEnabled ?? true,
    maxRetries: input.maxRetries ?? 2,
    priority: input.priority ?? null,
    credentials: input.credentialsCiphertext ?? null,
    updatedAt: now,
  };

  const setUpdate: Record<string, unknown> = {
    updatedAt: now,
  };
  if (input.enabled !== undefined) {
    setUpdate.enabled = input.enabled;
  }
  if (input.circuitBreakerEnabled !== undefined) {
    setUpdate.circuitBreakerEnabled = input.circuitBreakerEnabled;
  }
  if (input.maxRetries !== undefined) {
    setUpdate.maxRetries = input.maxRetries;
  }
  if (input.priority !== undefined) {
    setUpdate.priority = input.priority;
  }
  if (input.credentialsCiphertext !== undefined) {
    setUpdate.credentials = input.credentialsCiphertext;
  }

  await db
    .insert(seoProviderSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [
        seoProviderSettings.provider,
        seoProviderSettings.organizationId,
      ],
      targetWhere: sql`${seoProviderSettings.projectId} is null`,
      set: setUpdate,
    });
}

export async function upsertProjectProviderSettingsRow(
  projectId: string,
  provider: string,
  input: SeoProviderSettingsInput,
): Promise<void> {
  const now = new Date().toISOString();
  const values = {
    projectId,
    organizationId: null,
    provider,
    enabled: input.enabled ?? true,
    circuitBreakerEnabled: input.circuitBreakerEnabled ?? true,
    maxRetries: input.maxRetries ?? 2,
    priority: input.priority ?? null,
    credentials: input.credentialsCiphertext ?? null,
    updatedAt: now,
  };

  const setUpdate: Record<string, unknown> = {
    updatedAt: now,
  };
  if (input.enabled !== undefined) {
    setUpdate.enabled = input.enabled;
  }
  if (input.circuitBreakerEnabled !== undefined) {
    setUpdate.circuitBreakerEnabled = input.circuitBreakerEnabled;
  }
  if (input.maxRetries !== undefined) {
    setUpdate.maxRetries = input.maxRetries;
  }
  if (input.priority !== undefined) {
    setUpdate.priority = input.priority;
  }
  if (input.credentialsCiphertext !== undefined) {
    setUpdate.credentials = input.credentialsCiphertext;
  }

  await db
    .insert(seoProviderSettings)
    .values(values)
    .onConflictDoUpdate({
      target: [seoProviderSettings.provider, seoProviderSettings.projectId],
      targetWhere: sql`${seoProviderSettings.organizationId} is null`,
      set: setUpdate,
    });
}

export async function deleteOrganizationProviderSettings(
  organizationId: string,
  provider = "dataforseo",
): Promise<void> {
  await db
    .delete(seoProviderSettings)
    .where(
      and(
        eq(seoProviderSettings.organizationId, organizationId),
        eq(seoProviderSettings.provider, provider),
        isNull(seoProviderSettings.projectId),
      ),
    );
}

export async function deleteProjectProviderSettings(
  projectId: string,
  provider = "dataforseo",
): Promise<void> {
  await db
    .delete(seoProviderSettings)
    .where(
      and(
        eq(seoProviderSettings.projectId, projectId),
        eq(seoProviderSettings.provider, provider),
        isNull(seoProviderSettings.organizationId),
      ),
    );
}

export const SeoProviderSettingsRepository = {
  getOrganizationProviderSettingsRow,
  getProjectProviderSettingsRow,
  upsertOrganizationProviderSettingsRow,
  upsertProjectProviderSettingsRow,
  deleteOrganizationProviderSettings,
  deleteProjectProviderSettings,
} as const;
