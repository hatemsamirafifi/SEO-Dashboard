import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { AppError } from "@/server/lib/errors";
import { SeoProviderSettingsRepository } from "@/server/features/settings/repositories/SeoProviderSettingsRepository";
import {
  decryptSerpApiKey,
  encryptSerpApiKey,
  maskSerpApiKey,
} from "@/server/features/settings/serpProviderCrypto";
import {
  closeProviderCircuit,
  fingerprintProviderCredential,
  getProviderCircuitView,
  type ProviderCircuitView,
} from "@/server/features/serp/circuitBreaker";
import { clampProviderRetries } from "@/server/features/serp/retryPolicy";

export type AdditionalSerpProviderId = "serper" | "zenserp";
export type SerpCredentialSource =
  | "project"
  | "organization"
  | "environment"
  | "none";

export const DEFAULT_SERP_PRIORITIES = {
  dataforseo: 1,
  serper: 2,
  zenserp: 3,
} as const;

const ENV_NAMES = {
  serper: {
    key: "SERPER_API_KEY",
    enabled: "SERPER_ENABLED",
    circuitBreaker: "SERPER_CIRCUIT_BREAKER_ENABLED",
    retries: "SERPER_MAX_RETRIES",
  },
  zenserp: {
    key: "ZENSERP_API_KEY",
    enabled: "ZENSERP_ENABLED",
    circuitBreaker: "ZENSERP_CIRCUIT_BREAKER_ENABLED",
    retries: "ZENSERP_MAX_RETRIES",
  },
} as const;

export type EffectiveSerpProviderConfig = {
  provider: AdditionalSerpProviderId;
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  configured: boolean;
  apiKey?: string;
  source: SerpCredentialSource;
  priority: number;
};

export type SerpProviderSettingsView = Omit<
  EffectiveSerpProviderConfig,
  "apiKey"
> & {
  apiKeyMasked: string | null;
  scope: "organization" | "project";
  override: {
    configured: boolean;
    enabled: boolean;
    circuitBreakerEnabled: boolean;
    maxRetries: number;
    priority: number;
    apiKeyMasked: string | null;
  } | null;
  circuit: ProviderCircuitView;
};

export { type SerpProviderConnectionTestResult } from "@/server/features/settings/services/SerpProviderConnectionTest";

export { testSerpProviderConnection } from "@/server/features/settings/services/SerpProviderConnectionTest";

function envEnabled(value: string | null | undefined): boolean {
  return value === "true" || value === "1";
}

// Circuit breaker defaults to ON; only an explicit "false"/"0" turns it off.
function envCircuitBreakerEnabled(value: string | null | undefined): boolean {
  return !["false", "0"].includes(value ?? "");
}

export async function resolveEffectiveSerpProviderConfig(input: {
  provider: AdditionalSerpProviderId;
  organizationId?: string | null;
  projectId?: string | null;
}): Promise<EffectiveSerpProviderConfig> {
  const { provider } = input;
  const defaults = DEFAULT_SERP_PRIORITIES[provider];
  const projectRow = input.projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        input.projectId,
        provider,
      )
    : null;
  const orgRow = input.organizationId
    ? await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        input.organizationId,
        provider,
      )
    : null;
  const settingsRow = projectRow ?? orgRow;

  for (const [source, row] of [
    ["project", projectRow],
    ["organization", orgRow],
  ] as const) {
    if (!row) continue;
    const apiKey = await decryptSerpApiKey(provider, row.credentialsCiphertext);
    if (apiKey) {
      return {
        provider,
        enabled: settingsRow?.enabled ?? row.enabled,
        circuitBreakerEnabled: row.circuitBreakerEnabled,
        maxRetries: clampProviderRetries(row.maxRetries),
        configured: true,
        apiKey,
        source,
        priority: settingsRow?.priority ?? row.priority ?? defaults,
      };
    }
  }

  const apiKey = await getOptionalEnvValue(ENV_NAMES[provider].key);
  const enabled = envEnabled(
    await getOptionalEnvValue(ENV_NAMES[provider].enabled),
  );
  const circuitBreakerEnabled = envCircuitBreakerEnabled(
    await getOptionalEnvValue(ENV_NAMES[provider].circuitBreaker),
  );
  const envRetriesRaw = await getOptionalEnvValue(ENV_NAMES[provider].retries);
  const envRetries = clampProviderRetries(
    envRetriesRaw === null || envRetriesRaw === undefined
      ? 2
      : Number(envRetriesRaw),
  );
  if (apiKey?.trim()) {
    return {
      provider,
      enabled: settingsRow?.enabled ?? enabled,
      circuitBreakerEnabled:
        settingsRow?.circuitBreakerEnabled ?? circuitBreakerEnabled,
      maxRetries: clampProviderRetries(settingsRow?.maxRetries ?? envRetries),
      configured: true,
      apiKey: apiKey.trim(),
      source: "environment",
      priority: settingsRow?.priority ?? defaults,
    };
  }
  return {
    provider,
    enabled: settingsRow?.enabled ?? false,
    circuitBreakerEnabled:
      settingsRow?.circuitBreakerEnabled ?? circuitBreakerEnabled,
    maxRetries: clampProviderRetries(settingsRow?.maxRetries ?? envRetries),
    configured: false,
    source: "none",
    priority: settingsRow?.priority ?? defaults,
  };
}

export async function getSerpProviderSettingsView(input: {
  provider: AdditionalSerpProviderId;
  organizationId: string;
  projectId?: string | null;
}): Promise<SerpProviderSettingsView> {
  const effective = await resolveEffectiveSerpProviderConfig(input);
  const row = input.projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        input.projectId,
        input.provider,
      )
    : await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        input.organizationId,
        input.provider,
      );
  const overrideKey = row
    ? await decryptSerpApiKey(input.provider, row.credentialsCiphertext)
    : null;
  const { apiKey: _apiKey, ...safeEffective } = effective;
  const credentialFingerprint = await fingerprintProviderCredential(
    input.provider,
    [effective.apiKey],
  );
  return {
    ...safeEffective,
    apiKeyMasked: maskSerpApiKey(effective.apiKey),
    scope: input.projectId ? "project" : "organization",
    override: row
      ? {
          configured: Boolean(overrideKey),
          enabled: row.enabled,
          circuitBreakerEnabled: row.circuitBreakerEnabled,
          maxRetries: clampProviderRetries(row.maxRetries),
          priority: row.priority ?? DEFAULT_SERP_PRIORITIES[input.provider],
          apiKeyMasked: maskSerpApiKey(overrideKey),
        }
      : null,
    circuit: getProviderCircuitView({
      provider: input.provider,
      organizationId: input.organizationId,
      projectId: effective.source === "project" ? input.projectId : null,
      credentialFingerprint,
    }),
  };
}

export async function saveSerpProviderSettings(input: {
  provider: AdditionalSerpProviderId;
  organizationId: string;
  projectId?: string | null;
  patch: {
    apiKey?: string;
    enabled?: boolean;
    circuitBreakerEnabled?: boolean;
    maxRetries?: number;
    priority?: number;
  };
}): Promise<SerpProviderSettingsView> {
  const row = input.projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        input.projectId,
        input.provider,
      )
    : await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        input.organizationId,
        input.provider,
      );
  let ciphertext = row?.credentialsCiphertext ?? null;
  if (input.patch.apiKey?.trim()) {
    ciphertext = await encryptSerpApiKey(
      input.provider,
      input.patch.apiKey.trim(),
    );
    if (!ciphertext) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Credential encryption is not configured on this deployment. Set AI_CREDENTIALS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.",
      );
    }
  }
  const update = {
    enabled: input.patch.enabled ?? row?.enabled ?? true,
    circuitBreakerEnabled:
      input.patch.circuitBreakerEnabled ?? row?.circuitBreakerEnabled ?? true,
    maxRetries: clampProviderRetries(
      input.patch.maxRetries ?? row?.maxRetries ?? 2,
    ),
    priority:
      input.patch.priority ??
      row?.priority ??
      DEFAULT_SERP_PRIORITIES[input.provider],
    credentialsCiphertext: ciphertext,
  };
  if (input.projectId) {
    await SeoProviderSettingsRepository.upsertProjectProviderSettingsRow(
      input.projectId,
      input.provider,
      update,
    );
  } else {
    await SeoProviderSettingsRepository.upsertOrganizationProviderSettingsRow(
      input.organizationId,
      input.provider,
      update,
    );
  }

  // Changing the circuit-breaker setting must clear stale runtime memory so a
  // disabled breaker leaves no OPEN circuit behind and a re-enabled one starts
  // CLOSED. Mirrors the identity used by getSerpProviderSettingsView.
  if (input.patch.circuitBreakerEnabled !== undefined) {
    const effective = await resolveEffectiveSerpProviderConfig(input);
    const projectId = effective.source === "project" ? input.projectId : null;
    closeProviderCircuit({
      provider: input.provider,
      organizationId: input.organizationId,
      projectId,
      credentialFingerprint: await fingerprintProviderCredential(
        input.provider,
        [effective.apiKey],
      ),
    });
  }

  return getSerpProviderSettingsView(input);
}

export async function removeSerpProviderSettings(input: {
  provider: AdditionalSerpProviderId;
  organizationId: string;
  projectId?: string | null;
}): Promise<SerpProviderSettingsView> {
  if (input.projectId) {
    await SeoProviderSettingsRepository.deleteProjectProviderSettings(
      input.projectId,
      input.provider,
    );
  } else {
    await SeoProviderSettingsRepository.deleteOrganizationProviderSettings(
      input.organizationId,
      input.provider,
    );
  }
  return getSerpProviderSettingsView(input);
}
