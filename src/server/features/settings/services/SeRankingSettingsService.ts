import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import { SeoProviderSettingsRepository } from "@/server/features/settings/repositories/SeoProviderSettingsRepository";
import {
  decryptSeRankingApiKey,
  encryptSeRankingApiKey,
  maskSeRankingApiKey,
} from "@/server/features/settings/serankingCrypto";
import {
  closeProviderCircuit,
  fingerprintProviderCredential,
  getProviderCircuitView,
  openProviderCircuit,
  type ProviderCircuitIdentity,
  type ProviderCircuitView,
} from "@/server/features/serp/circuitBreaker";
import { clampProviderRetries } from "@/server/features/serp/retryPolicy";
import { SeRankingClient } from "@/server/lib/seranking/client";
import {
  SeRankingAuthError,
  SeRankingCreditExhaustedError,
  SeRankingError,
  SeRankingRateLimitError,
} from "@/server/lib/seranking/errors";

export type SeRankingConfigSource =
  | "project"
  | "organization"
  | "environment"
  | "none";

export type EffectiveSeRankingConfig = {
  provider: "seranking";
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  configured: boolean;
  apiKey?: string;
  baseUrl?: string;
  source: SeRankingConfigSource;
  priority: number;
};

export type SeRankingSettingsView = Omit<EffectiveSeRankingConfig, "apiKey"> & {
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

export type SeRankingConnectionTestResult = {
  ok: boolean;
  status: number;
  reason:
    | "CONNECTED"
    | "INVALID_CREDENTIALS"
    | "CREDITS_UNAVAILABLE"
    | "RATE_LIMITED"
    | "TRANSIENT_UPSTREAM"
    | "NOT_CONFIGURED"
    | "DISABLED";
  balance?: number | null;
  unitsLimit?: number | null;
  subscriptionStatus?: string | null;
};

export const DEFAULT_SERANKING_PRIORITY = 1;

export async function resolveEffectiveSeRankingConfig(params?: {
  organizationId?: string | null;
  projectId?: string | null;
}): Promise<EffectiveSeRankingConfig> {
  const projectId = params?.projectId ?? null;
  const organizationId = params?.organizationId ?? null;

  let projectRow = null;
  let orgRow = null;
  try {
    projectRow = projectId
      ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
          projectId,
          "seranking",
        )
      : null;
    orgRow = organizationId
      ? await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
          organizationId,
          "seranking",
        )
      : null;
  } catch {
    // DB may be unavailable in pure unit test environments; proceed to env fallback
  }

  const settingsRow = projectRow ?? orgRow;
  const envBaseUrl =
    (await getOptionalEnvValue("SERANKING_BASE_URL")) ??
    "https://api.seranking.com";

  // 1. Project-level override
  if (projectRow) {
    const apiKey = await decryptSeRankingApiKey(
      projectRow.credentialsCiphertext,
    );
    if (apiKey) {
      return {
        provider: "seranking",
        enabled: projectRow.enabled,
        circuitBreakerEnabled: projectRow.circuitBreakerEnabled,
        maxRetries: clampProviderRetries(projectRow.maxRetries),
        apiKey,
        baseUrl: envBaseUrl,
        source: "project",
        configured: true,
        priority: projectRow.priority ?? DEFAULT_SERANKING_PRIORITY,
      };
    }
  }

  // 2. Organization-level
  if (orgRow) {
    const apiKey = await decryptSeRankingApiKey(orgRow.credentialsCiphertext);
    if (apiKey) {
      return {
        provider: "seranking",
        enabled: settingsRow?.enabled ?? orgRow.enabled,
        circuitBreakerEnabled:
          settingsRow?.circuitBreakerEnabled ?? orgRow.circuitBreakerEnabled,
        maxRetries: clampProviderRetries(
          settingsRow?.maxRetries ?? orgRow.maxRetries,
        ),
        apiKey,
        baseUrl: envBaseUrl,
        source: "organization",
        configured: true,
        priority:
          settingsRow?.priority ??
          orgRow.priority ??
          DEFAULT_SERANKING_PRIORITY,
      };
    }
  }

  // 3. Environment-level
  const envKey = await getOptionalEnvValue("SERANKING_API_KEY");
  const envEnabledStr = await getOptionalEnvValue("SERANKING_ENABLED");
  const envEnabled = envEnabledStr === "true" || envEnabledStr === "1";

  if (envKey && envKey.trim().length > 0) {
    return {
      provider: "seranking",
      enabled: settingsRow ? settingsRow.enabled : envEnabled,
      circuitBreakerEnabled: settingsRow
        ? settingsRow.circuitBreakerEnabled
        : true,
      maxRetries: clampProviderRetries(
        settingsRow ? settingsRow.maxRetries : 2,
      ),
      apiKey: envKey.trim(),
      baseUrl: envBaseUrl,
      source: "environment",
      configured: true,
      priority: settingsRow?.priority ?? DEFAULT_SERANKING_PRIORITY,
    };
  }

  // 4. None
  return {
    provider: "seranking",
    enabled: settingsRow ? settingsRow.enabled : false,
    circuitBreakerEnabled: settingsRow
      ? settingsRow.circuitBreakerEnabled
      : true,
    maxRetries: clampProviderRetries(settingsRow ? settingsRow.maxRetries : 2),
    baseUrl: envBaseUrl,
    source: "none",
    configured: false,
    priority: settingsRow?.priority ?? DEFAULT_SERANKING_PRIORITY,
  };
}

export async function getSeRankingSettingsView(input: {
  organizationId?: string | null;
  projectId?: string | null;
}): Promise<SeRankingSettingsView> {
  const effective = await resolveEffectiveSeRankingConfig(input);
  const scope = input.projectId ? "project" : "organization";

  const projectRow = input.projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        input.projectId,
        "seranking",
      )
    : null;

  let override: SeRankingSettingsView["override"] = null;
  if (projectRow) {
    const projectApiKey = await decryptSeRankingApiKey(
      projectRow.credentialsCiphertext,
    );
    override = {
      configured: Boolean(projectApiKey),
      enabled: projectRow.enabled,
      circuitBreakerEnabled: projectRow.circuitBreakerEnabled,
      maxRetries: clampProviderRetries(projectRow.maxRetries),
      priority: projectRow.priority ?? DEFAULT_SERANKING_PRIORITY,
      apiKeyMasked: maskSeRankingApiKey(projectApiKey),
    };
  }

  const identity: ProviderCircuitIdentity = {
    provider: "seranking",
    organizationId: input.organizationId ?? null,
    projectId: input.projectId ?? null,
    credentialFingerprint: await fingerprintProviderCredential("seranking", [
      effective.apiKey,
    ]),
  };

  return {
    provider: "seranking",
    configured: effective.configured,
    enabled: effective.enabled,
    circuitBreakerEnabled: effective.circuitBreakerEnabled,
    maxRetries: effective.maxRetries,
    priority: effective.priority,
    source: effective.source,
    baseUrl: effective.baseUrl,
    apiKeyMasked: maskSeRankingApiKey(effective.apiKey),
    scope,
    override,
    circuit: getProviderCircuitView(identity),
  };
}

export async function saveSeRankingSettings(input: {
  organizationId: string;
  projectId?: string | null;
  patch: {
    apiKey?: string;
    enabled?: boolean;
    circuitBreakerEnabled?: boolean;
    maxRetries?: number;
    priority?: number;
  };
}): Promise<SeRankingSettingsView> {
  const existing = input.projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        input.projectId,
        "seranking",
      )
    : await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        input.organizationId,
        "seranking",
      );

  let credentialsCiphertext = existing?.credentialsCiphertext ?? null;
  if (input.patch.apiKey !== undefined) {
    if (input.patch.apiKey.trim().length > 0) {
      credentialsCiphertext = await encryptSeRankingApiKey(
        input.patch.apiKey.trim(),
      );
    } else {
      credentialsCiphertext = null;
    }
  }

  const enabled = input.patch.enabled ?? existing?.enabled ?? true;
  const circuitBreakerEnabled =
    input.patch.circuitBreakerEnabled ??
    existing?.circuitBreakerEnabled ??
    true;
  const maxRetries = clampProviderRetries(
    input.patch.maxRetries ?? existing?.maxRetries ?? 2,
  );
  const priority =
    input.patch.priority ?? existing?.priority ?? DEFAULT_SERANKING_PRIORITY;

  if (input.projectId) {
    await SeoProviderSettingsRepository.upsertProjectProviderSettingsRow(
      input.projectId,
      "seranking",
      {
        enabled,
        circuitBreakerEnabled,
        maxRetries,
        priority,
        credentialsCiphertext,
      },
    );
  } else {
    await SeoProviderSettingsRepository.upsertOrganizationProviderSettingsRow(
      input.organizationId,
      "seranking",
      {
        enabled,
        circuitBreakerEnabled,
        maxRetries,
        priority,
        credentialsCiphertext,
      },
    );
  }

  return getSeRankingSettingsView(input);
}

export async function removeSeRankingSettings(input: {
  organizationId: string;
  projectId?: string | null;
}): Promise<SeRankingSettingsView> {
  if (input.projectId) {
    await SeoProviderSettingsRepository.deleteProjectProviderSettings(
      input.projectId,
      "seranking",
    );
  } else {
    await SeoProviderSettingsRepository.deleteOrganizationProviderSettings(
      input.organizationId,
      "seranking",
    );
  }
  return getSeRankingSettingsView(input);
}

export async function testSeRankingConnection(params: {
  organizationId?: string | null;
  projectId?: string | null;
  apiKey?: string;
}): Promise<SeRankingConnectionTestResult> {
  let keyToUse = params.apiKey?.trim();
  let config: EffectiveSeRankingConfig | null = null;
  if (!keyToUse) {
    config = await resolveEffectiveSeRankingConfig(params);
    if (!config.configured || !config.apiKey) {
      console.warn("[seranking-connection-test] Diagnostics: test skipped", {
        organizationId: params.organizationId ?? null,
        projectId: params.projectId ?? null,
        classification: "NOT_CONFIGURED",
        upstreamStatus: 400,
      });
      return {
        ok: false,
        status: 400,
        reason: "NOT_CONFIGURED",
      };
    }
    if (!config.enabled) {
      console.warn("[seranking-connection-test] Diagnostics: test skipped", {
        organizationId: params.organizationId ?? null,
        projectId: params.projectId ?? null,
        classification: "DISABLED",
        upstreamStatus: 400,
      });
      return {
        ok: false,
        status: 400,
        reason: "DISABLED",
      };
    }
    keyToUse = config.apiKey;
  }

  const baseUrl =
    config?.baseUrl ??
    (await getOptionalEnvValue("SERANKING_BASE_URL")) ??
    "https://api.seranking.com";
  const destination = `${baseUrl.replace(/\/+$/, "")}/v1/account/subscription`;

  const client = new SeRankingClient({
    apiKey: keyToUse,
    baseUrl,
    timeoutMs: 15000,
    maxRetries: 0,
  });

  const identity: ProviderCircuitIdentity = {
    provider: "seranking",
    organizationId: params.organizationId ?? null,
    projectId: params.projectId ?? null,
    credentialFingerprint: await fingerprintProviderCredential("seranking", [
      keyToUse,
    ]),
  };

  try {
    const sub = await client.getSubscription();

    console.info("[seranking-connection-test] Diagnostics", {
      destination,
      upstreamStatus: 200,
      classification: "CONNECTED",
      subscriptionStatus: sub.status,
      unitsLeft: sub.units_left,
      unitsLimit: sub.units_limit,
    });

    if (sub.units_left != null && sub.units_left <= 0) {
      return {
        ok: false,
        status: 200,
        reason: "CREDITS_UNAVAILABLE",
        balance: sub.units_left,
        unitsLimit: sub.units_limit,
        subscriptionStatus: sub.status,
      };
    }
    closeProviderCircuit(identity);
    return {
      ok: true,
      status: 200,
      reason: "CONNECTED",
      balance: sub.units_left,
      unitsLimit: sub.units_limit,
      subscriptionStatus: sub.status,
    };
  } catch (error) {
    let classification: SeRankingConnectionTestResult["reason"] =
      "TRANSIENT_UPSTREAM";
    let status = 500;

    if (error instanceof SeRankingAuthError) {
      classification = "INVALID_CREDENTIALS";
      status = 401;
      openProviderCircuit(identity, "INVALID_CREDENTIALS");
    } else if (error instanceof SeRankingRateLimitError) {
      classification = "RATE_LIMITED";
      status = 429;
      openProviderCircuit(identity, "RATE_LIMITED");
    } else if (error instanceof SeRankingCreditExhaustedError) {
      classification = "CREDITS_UNAVAILABLE";
      status = 402;
      openProviderCircuit(identity, "CREDITS_UNAVAILABLE");
    } else if (error instanceof SeRankingError && error.statusCode) {
      status = error.statusCode;
    }

    console.warn("[seranking-connection-test] Diagnostics", {
      destination,
      upstreamStatus:
        error instanceof SeRankingError && error.statusCode
          ? error.statusCode
          : status,
      classification,
      errorName: error instanceof Error ? error.name : typeof error,
      errorMessage: error instanceof Error ? error.message : String(error),
      ...(error instanceof z.ZodError ? { zodIssues: error.issues } : {}),
    });

    return { ok: false, status, reason: classification };
  }
}
