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
  getProviderCircuitState,
  getProviderCircuitView,
  openProviderCircuit,
  type ProviderCircuitIdentity,
  type ProviderCircuitView,
} from "@/server/features/serp/circuitBreaker";

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
  serper: { key: "SERPER_API_KEY", enabled: "SERPER_ENABLED" },
  zenserp: { key: "ZENSERP_API_KEY", enabled: "ZENSERP_ENABLED" },
} as const;

export type EffectiveSerpProviderConfig = {
  provider: AdditionalSerpProviderId;
  enabled: boolean;
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
    priority: number;
    apiKeyMasked: string | null;
  } | null;
  circuit: ProviderCircuitView;
};

export type SerpProviderConnectionTestResult = {
  ok: boolean;
  status: number;
  reason:
    | "CONNECTED"
    | "INVALID_CREDENTIALS"
    | "QUOTA_EXHAUSTED"
    | "RATE_LIMITED"
    | "UNAVAILABLE"
    | "NOT_CONFIGURED";
  durationMs: number;
  consumesQuery: true;
};

function envEnabled(value: string | null | undefined): boolean {
  return value === "true" || value === "1";
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
  if (apiKey?.trim()) {
    return {
      provider,
      enabled: settingsRow?.enabled ?? enabled,
      configured: true,
      apiKey: apiKey.trim(),
      source: "environment",
      priority: settingsRow?.priority ?? defaults,
    };
  }
  return {
    provider,
    enabled: settingsRow?.enabled ?? false,
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
  patch: { apiKey?: string; enabled?: boolean; priority?: number };
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

function classifyStatus(
  status: number,
  body: string,
): SerpProviderConnectionTestResult["reason"] {
  if (status === 401 || status === 403) return "INVALID_CREDENTIALS";
  if (status === 429 && /credit|quota|exhaust/i.test(body))
    return "QUOTA_EXHAUSTED";
  if (status === 429) return "RATE_LIMITED";
  return "UNAVAILABLE";
}

export async function testSerpProviderConnection(input: {
  provider: AdditionalSerpProviderId;
  organizationId: string;
  projectId?: string | null;
  apiKey?: string;
  fetchFn?: typeof fetch;
}): Promise<SerpProviderConnectionTestResult> {
  const effective = await resolveEffectiveSerpProviderConfig(input);
  const apiKey = input.apiKey?.trim() || effective.apiKey;
  if (!apiKey) {
    return {
      ok: false,
      status: 400,
      reason: "NOT_CONFIGURED",
      durationMs: 0,
      consumesQuery: true,
    };
  }
  const circuitIdentity: ProviderCircuitIdentity = {
    provider: input.provider,
    organizationId: input.organizationId,
    projectId:
      input.projectId &&
      (input.apiKey?.trim() || effective.source === "project")
        ? input.projectId
        : null,
    credentialFingerprint: await fingerprintProviderCredential(input.provider, [
      apiKey,
    ]),
  };
  const failed = (
    result: SerpProviderConnectionTestResult,
  ): SerpProviderConnectionTestResult => {
    const deterministic = ["INVALID_CREDENTIALS", "QUOTA_EXHAUSTED"].includes(
      result.reason,
    );
    if (deterministic || getProviderCircuitState(circuitIdentity)) {
      openProviderCircuit(circuitIdentity, result.reason);
    }
    return result;
  };
  const startedAt = Date.now();
  try {
    const response =
      input.provider === "serper"
        ? await (input.fetchFn ?? fetch)("https://google.serper.dev/search", {
            method: "POST",
            headers: {
              "X-API-KEY": apiKey,
              "Content-Type": "application/json",
            },
            body: JSON.stringify({ q: "OpenSEO", num: 1, gl: "us", hl: "en" }),
            signal: AbortSignal.timeout(15_000),
          })
        : await (input.fetchFn ?? fetch)(
            "https://app.zenserp.com/api/v2/search?q=OpenSEO&engine=google&num=1&gl=us&hl=en",
            {
              headers: { apikey: apiKey, Accept: "application/json" },
              signal: AbortSignal.timeout(15_000),
            },
          );
    const body = await response.text();
    const durationMs = Date.now() - startedAt;
    if (!response.ok) {
      return failed({
        ok: false,
        status: response.status,
        reason: classifyStatus(response.status, body),
        durationMs,
        consumesQuery: true,
      });
    }
    try {
      JSON.parse(body);
    } catch {
      return failed({
        ok: false,
        status: response.status,
        reason: "UNAVAILABLE",
        durationMs,
        consumesQuery: true,
      });
    }
    closeProviderCircuit(circuitIdentity);
    return {
      ok: true,
      status: response.status,
      reason: "CONNECTED",
      durationMs,
      consumesQuery: true,
    };
  } catch {
    return failed({
      ok: false,
      status: 503,
      reason: "UNAVAILABLE",
      durationMs: Date.now() - startedAt,
      consumesQuery: true,
    });
  }
}
