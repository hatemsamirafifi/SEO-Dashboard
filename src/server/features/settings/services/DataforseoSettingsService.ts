/* eslint-disable max-lines */
import { z } from "zod";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  decryptDataforseoCredentials,
  encryptDataforseoCredentials,
  maskDataforseoLogin,
  parseLegacyDataforseoApiKey,
  resolveDataforseoEncryptionKey,
  type DataforseoCredentials,
} from "@/server/features/settings/dataforseoCrypto";
import {
  SeoProviderSettingsRepository,
  type SeoProviderSettingsRow,
} from "@/server/features/settings/repositories/SeoProviderSettingsRepository";
import { AppError } from "@/server/lib/errors";
import {
  closeProviderCircuit,
  fingerprintProviderCredential,
  getProviderCircuitState,
  getProviderCircuitView,
  openProviderCircuit,
  type ProviderCircuitIdentity,
  type ProviderCircuitView,
} from "@/server/features/serp/circuitBreaker";
import { clampProviderRetries } from "@/server/features/serp/retryPolicy";

export type DataForSeoConfigSource =
  | "project"
  | "organization"
  | "environment"
  | "none";

export type DataForSeoConfig = {
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  login?: string;
  password?: string;
  source: DataForSeoConfigSource;
  configured: boolean;
  priority: number;
};

export type DataforseoSettingsView = {
  provider: "dataforseo";
  configured: boolean;
  enabled: boolean;
  circuitBreakerEnabled: boolean;
  maxRetries: number;
  priority: number;
  source: DataForSeoConfigSource;
  loginMasked: string | null;
  passwordConfigured: boolean;
  scope: "organization" | "project";
  override: {
    configured: boolean;
    enabled: boolean;
    circuitBreakerEnabled: boolean;
    maxRetries: number;
    priority: number;
    loginMasked: string | null;
    passwordConfigured: boolean;
  } | null;
  circuit: ProviderCircuitView;
};

export type SaveDataforseoSettingsInput = {
  organizationId: string;
  projectId?: string | null;
  patch: {
    login?: string;
    password?: string;
    enabled?: boolean;
    circuitBreakerEnabled?: boolean;
    maxRetries?: number;
    priority?: number;
  };
};

export type DataforseoConnectionTestResult = {
  ok: boolean;
  status: number;
  reason:
    | "CONNECTED"
    | "DATAFORSEO_ACCESS_PAUSED"
    | "DATAFORSEO_ACCOUNT_PAUSED"
    | "INVALID_CREDENTIALS"
    | "CREDITS_UNAVAILABLE"
    | "RATE_LIMITED"
    | "TRANSIENT_UPSTREAM"
    | "NOT_CONFIGURED"
    | "DISABLED";
  balance?: number | null;
  billingStatus:
    | "credits_available"
    | "low_balance"
    | "credits_unavailable"
    | "unknown";
};

export type DataforseoEndpointHealth = {
  endpoint: string;
  status: string;
};

export type DataforseoApiHealth = {
  api: string;
  status: string;
  endpoints?: DataforseoEndpointHealth[] | null;
};

export type DataforseoApiStatusResult = {
  ok: boolean;
  status: number;
  reason:
    | "CONNECTED"
    | "INVALID_CREDENTIALS"
    | "RATE_LIMITED"
    | "TRANSIENT_UPSTREAM"
    | "NOT_CONFIGURED"
    | "DISABLED";
  endpoints: DataforseoApiHealth[];
  checkedAt: string;
};

const DATAFORSEO_API_BASE = "https://api.dataforseo.com";
const TEST_CONNECTION_TIMEOUT_MS = 15_000;

function inheritedPriority(
  projectRow: SeoProviderSettingsRow | null,
  orgRow: SeoProviderSettingsRow | null,
): number {
  return projectRow?.priority ?? orgRow?.priority ?? 1;
}

function inheritedCircuitBreakerEnabled(
  projectRow: SeoProviderSettingsRow | null,
  orgRow: SeoProviderSettingsRow | null,
  envDefault: boolean,
): boolean {
  const settingsRow = projectRow ?? orgRow;
  return settingsRow?.circuitBreakerEnabled ?? envDefault;
}

function inheritedMaxRetries(
  projectRow: SeoProviderSettingsRow | null,
  orgRow: SeoProviderSettingsRow | null,
  envDefault: number,
): number {
  const settingsRow = projectRow ?? orgRow;
  return clampProviderRetries(settingsRow?.maxRetries ?? envDefault);
}

function recordFailedProbe(
  identity: ProviderCircuitIdentity,
  reason: DataforseoConnectionTestResult["reason"],
) {
  const deterministic = [
    "DATAFORSEO_ACCESS_PAUSED",
    "DATAFORSEO_ACCOUNT_PAUSED",
    "INVALID_CREDENTIALS",
    "CREDITS_UNAVAILABLE",
  ].includes(reason);
  if (deterministic || getProviderCircuitState(identity)) {
    openProviderCircuit(identity, reason);
  }
}

/**
 * Resolve effective DataForSEO configuration according to repository precedence:
 * Project override -> Organization row -> Environment fallback -> None.
 * Credentials remain server-side only.
 */
export async function resolveEffectiveDataforseoConfig(params?: {
  organizationId?: string | null;
  projectId?: string | null;
}): Promise<DataForSeoConfig> {
  const projectId = params?.projectId ?? null;
  const organizationId = params?.organizationId ?? null;
  const projectRow = projectId
    ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        projectId,
        "dataforseo",
      )
    : null;
  const orgRow = organizationId
    ? await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        organizationId,
        "dataforseo",
      )
    : null;
  const settingsRow = projectRow ?? orgRow;

  // 1. Project-level override
  if (projectRow) {
    const creds = await decryptDataforseoCredentials(
      projectRow.credentialsCiphertext,
    );
    if (creds) {
      return {
        enabled: projectRow.enabled,
        circuitBreakerEnabled: projectRow.circuitBreakerEnabled,
        maxRetries: clampProviderRetries(projectRow.maxRetries),
        login: creds.login,
        password: creds.password,
        source: "project",
        configured: true,
        priority: projectRow.priority ?? 1,
      };
    }
    // If row exists with enabled toggle but no credentials, inherit credentials below
  }

  // 2. Organization-level configuration
  if (orgRow) {
    const creds = await decryptDataforseoCredentials(
      orgRow.credentialsCiphertext,
    );
    if (creds) {
      return {
        enabled: settingsRow?.enabled ?? orgRow.enabled,
        circuitBreakerEnabled:
          settingsRow?.circuitBreakerEnabled ?? orgRow.circuitBreakerEnabled,
        maxRetries: clampProviderRetries(
          settingsRow?.maxRetries ?? orgRow.maxRetries,
        ),
        login: creds.login,
        password: creds.password,
        source: "organization",
        configured: true,
        priority: settingsRow?.priority ?? orgRow.priority ?? 1,
      };
    }
  }

  // 3. Environment configuration fallback
  const envLogin = await getOptionalEnvValue("DATAFORSEO_LOGIN");
  const envPassword = await getOptionalEnvValue("DATAFORSEO_PASSWORD");
  const envEnabledRaw = await getOptionalEnvValue("DATAFORSEO_ENABLED");
  const envEnabled = !["false", "0"].includes(envEnabledRaw ?? "");
  const envCircuitBreakerRaw = await getOptionalEnvValue(
    "DATAFORSEO_CIRCUIT_BREAKER_ENABLED",
  );
  const envCircuitBreakerEnabled = !["false", "0"].includes(
    envCircuitBreakerRaw ?? "",
  );
  const envRetriesRaw = await getOptionalEnvValue("DATAFORSEO_MAX_RETRIES");
  const envRetries = clampProviderRetries(
    envRetriesRaw === null || envRetriesRaw === undefined
      ? 2
      : Number(envRetriesRaw),
  );

  if (envLogin && envPassword) {
    return {
      enabled: settingsRow?.enabled ?? envEnabled,
      circuitBreakerEnabled: inheritedCircuitBreakerEnabled(
        projectRow,
        orgRow,
        envCircuitBreakerEnabled,
      ),
      maxRetries: inheritedMaxRetries(projectRow, orgRow, envRetries),
      login: envLogin.trim(),
      password: envPassword.trim(),
      source: "environment",
      configured: true,
      priority: inheritedPriority(projectRow, orgRow),
    };
  }

  const envApiKey = await getOptionalEnvValue("DATAFORSEO_API_KEY");
  if (envApiKey) {
    const parsed = parseLegacyDataforseoApiKey(envApiKey);
    if (parsed) {
      return {
        enabled: settingsRow?.enabled ?? envEnabled,
        circuitBreakerEnabled: inheritedCircuitBreakerEnabled(
          projectRow,
          orgRow,
          envCircuitBreakerEnabled,
        ),
        maxRetries: inheritedMaxRetries(projectRow, orgRow, envRetries),
        login: parsed.login,
        password: parsed.password,
        source: "environment",
        configured: true,
        priority: inheritedPriority(projectRow, orgRow),
      };
    }
  }

  // 4. Not configured
  return {
    enabled: settingsRow?.enabled ?? false,
    circuitBreakerEnabled: inheritedCircuitBreakerEnabled(
      projectRow,
      orgRow,
      envCircuitBreakerEnabled,
    ),
    maxRetries: inheritedMaxRetries(projectRow, orgRow, envRetries),
    source: "none",
    configured: false,
    priority: inheritedPriority(projectRow, orgRow),
  };
}

/**
 * Return safe masked metadata for UI rendering.
 * NEVER returns plaintext password or auth secrets.
 */
export async function getDataforseoSettingsView(input: {
  organizationId: string;
  projectId?: string | null;
}): Promise<DataforseoSettingsView> {
  const { organizationId, projectId } = input;
  const effective = await resolveEffectiveDataforseoConfig({
    organizationId,
    projectId,
  });

  let override: DataforseoSettingsView["override"] = null;
  let targetRow: SeoProviderSettingsRow | null = null;

  if (projectId) {
    targetRow =
      await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
        projectId,
        "dataforseo",
      );
  } else {
    targetRow =
      await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
        organizationId,
        "dataforseo",
      );
  }

  if (targetRow) {
    const creds = await decryptDataforseoCredentials(
      targetRow.credentialsCiphertext,
    );
    override = {
      configured: Boolean(creds),
      enabled: targetRow.enabled,
      circuitBreakerEnabled: targetRow.circuitBreakerEnabled,
      maxRetries: clampProviderRetries(targetRow.maxRetries),
      priority: targetRow.priority ?? 1,
      loginMasked: creds ? maskDataforseoLogin(creds.login) : null,
      passwordConfigured: Boolean(creds?.password),
    };
  }

  const credentialFingerprint = await fingerprintProviderCredential(
    "dataforseo",
    [effective.login, effective.password],
  );

  return {
    provider: "dataforseo",
    configured: effective.configured,
    enabled: effective.enabled,
    circuitBreakerEnabled: effective.circuitBreakerEnabled,
    maxRetries: effective.maxRetries,
    priority: effective.priority,
    source: effective.source,
    loginMasked: maskDataforseoLogin(effective.login),
    passwordConfigured: Boolean(effective.password),
    scope: projectId ? "project" : "organization",
    override,
    circuit: getProviderCircuitView({
      provider: "dataforseo",
      organizationId,
      projectId: effective.source === "project" ? projectId : null,
      credentialFingerprint,
    }),
  };
}

/**
 * Save DataForSEO credentials and usage setting with AES-GCM encryption at rest.
 * Preserves existing password if empty on update.
 */
export async function saveDataforseoSettings(
  input: SaveDataforseoSettingsInput,
): Promise<DataforseoSettingsView> {
  const { organizationId, projectId, patch } = input;
  const isProject = Boolean(projectId);

  const existingRow =
    isProject && projectId
      ? await SeoProviderSettingsRepository.getProjectProviderSettingsRow(
          projectId,
          "dataforseo",
        )
      : await SeoProviderSettingsRepository.getOrganizationProviderSettingsRow(
          organizationId,
          "dataforseo",
        );

  const existingCreds = existingRow
    ? await decryptDataforseoCredentials(existingRow.credentialsCiphertext)
    : null;

  const newLogin =
    patch.login !== undefined && patch.login.trim().length > 0
      ? patch.login.trim()
      : existingCreds?.login;

  const newPassword =
    patch.password !== undefined && patch.password.trim().length > 0
      ? patch.password.trim()
      : existingCreds?.password;

  let credentialsCiphertext: string | null | undefined = undefined;

  if (newLogin && newPassword) {
    const keyAvailable = await resolveDataforseoEncryptionKey();
    if (!keyAvailable) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Credential encryption is not configured on this deployment. Set AI_CREDENTIALS_ENCRYPTION_KEY or BETTER_AUTH_SECRET.",
      );
    }
    const encrypted = await encryptDataforseoCredentials({
      login: newLogin,
      password: newPassword,
    });
    if (!encrypted) {
      throw new AppError(
        "INTERNAL_ERROR",
        "Failed to encrypt DataForSEO credentials.",
      );
    }
    credentialsCiphertext = encrypted;
  } else if (!newLogin && !newPassword) {
    // Only toggling enabled or leaving credentials untouched
    credentialsCiphertext = existingRow?.credentialsCiphertext ?? null;
  } else {
    // One field provided but not the other on first setup
    throw new AppError(
      "VALIDATION_ERROR",
      "Both API Login and API Password are required to configure DataForSEO.",
    );
  }

  const enabled =
    patch.enabled !== undefined
      ? patch.enabled
      : (existingRow?.enabled ?? true);
  const circuitBreakerEnabled =
    patch.circuitBreakerEnabled ?? existingRow?.circuitBreakerEnabled ?? true;
  const maxRetries = clampProviderRetries(
    patch.maxRetries ?? existingRow?.maxRetries ?? 2,
  );
  const priority = patch.priority ?? existingRow?.priority ?? 1;

  if (isProject && projectId) {
    await SeoProviderSettingsRepository.upsertProjectProviderSettingsRow(
      projectId,
      "dataforseo",
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
      organizationId,
      "dataforseo",
      {
        enabled,
        circuitBreakerEnabled,
        maxRetries,
        priority,
        credentialsCiphertext,
      },
    );
  }

  // Changing the circuit-breaker setting must clear stale runtime memory: a
  // disabled breaker should never leave an old OPEN circuit behind (bypass on
  // disable), and a re-enabled breaker must start from a clean CLOSED state.
  // The identity mirrors the one used by getDataforseoSettingsView.
  if (patch.circuitBreakerEnabled !== undefined) {
    const effective = await resolveEffectiveDataforseoConfig({
      organizationId,
      projectId,
    });
    closeProviderCircuit({
      provider: "dataforseo",
      organizationId,
      projectId: effective.source === "project" ? projectId : null,
      credentialFingerprint: await fingerprintProviderCredential("dataforseo", [
        effective.login,
        effective.password,
      ]),
    });
  }

  console.info("audit", {
    provider: "dataforseo",
    action: "credentials_updated",
    scope: isProject ? "project" : "organization",
    organizationId,
    projectId: projectId ?? null,
    enabled,
    circuitBreakerEnabled,
  });

  return getDataforseoSettingsView({ organizationId, projectId });
}

/**
 * Remove scoped DataForSEO configuration override.
 * Revealing lower-precedence (e.g. environment) configuration if present.
 */
export async function removeDataforseoSettings(input: {
  organizationId: string;
  projectId?: string | null;
}): Promise<DataforseoSettingsView> {
  const { organizationId, projectId } = input;
  if (projectId) {
    await SeoProviderSettingsRepository.deleteProjectProviderSettings(
      projectId,
      "dataforseo",
    );
  } else {
    await SeoProviderSettingsRepository.deleteOrganizationProviderSettings(
      organizationId,
      "dataforseo",
    );
  }

  console.info("audit", {
    provider: "dataforseo",
    action: "credentials_removed",
    scope: projectId ? "project" : "organization",
    organizationId,
    projectId: projectId ?? null,
  });

  return getDataforseoSettingsView({ organizationId, projectId });
}

async function resolveProbeCredentials(input: {
  organizationId: string;
  projectId?: string | null;
  login?: string;
  password?: string;
}): Promise<{
  credentials: DataforseoCredentials | null;
  projectScoped: boolean;
}> {
  const login = input.login?.trim();
  const password = input.password?.trim();
  if (login && password) {
    return {
      credentials: { login, password },
      projectScoped: Boolean(input.projectId),
    };
  }

  const effective = await resolveEffectiveDataforseoConfig({
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
  if (login && effective.password) {
    return {
      credentials: { login, password: effective.password },
      projectScoped: Boolean(input.projectId),
    };
  }
  if (effective.login && effective.password) {
    return {
      credentials: {
        login: effective.login,
        password: effective.password,
      },
      projectScoped: effective.source === "project",
    };
  }
  return { credentials: null, projectScoped: false };
}

/**
 * Test DataForSEO connection using the free, non-billable GET /v3/appendix/user_data endpoint.
 *
 * MANDATORY SAFETY RULES:
 * - Does NOT enter `meterDataforseoCall()`
 * - Does NOT consume SEO credits or trigger billable calls
 * - Does NOT write SEO cache
 * - Does NOT trigger budget guard or SAM tool recovery
 */
export async function testDataforseoConnection(input: {
  organizationId: string;
  projectId?: string | null;
  login?: string;
  password?: string;
  fetchFn?: typeof fetch;
}): Promise<DataforseoConnectionTestResult> {
  const customFetch = input.fetchFn ?? fetch;
  const { credentials: credsToTest, projectScoped } =
    await resolveProbeCredentials(input);

  if (!credsToTest) {
    return {
      ok: false,
      status: 400,
      reason: "NOT_CONFIGURED",
      billingStatus: "unknown",
    };
  }

  const circuitIdentity: ProviderCircuitIdentity = {
    provider: "dataforseo",
    organizationId: input.organizationId,
    projectId: projectScoped ? input.projectId : null,
    credentialFingerprint: await fingerprintProviderCredential("dataforseo", [
      credsToTest.login,
      credsToTest.password,
    ]),
  };

  const failed = (
    result: DataforseoConnectionTestResult,
  ): DataforseoConnectionTestResult => {
    recordFailedProbe(circuitIdentity, result.reason);
    return result;
  };

  const basicAuth = Buffer.from(
    `${credsToTest.login}:${credsToTest.password}`,
  ).toString("base64");

  const startedAt = Date.now();
  try {
    const response = await customFetch(
      `${DATAFORSEO_API_BASE}/v3/appendix/user_data`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      },
    );

    const durationMs = Date.now() - startedAt;

    if (response.status === 401) {
      return failed({
        ok: false,
        status: 401,
        reason: "INVALID_CREDENTIALS",
        billingStatus: "unknown",
      });
    }

    if (response.status === 402) {
      return failed({
        ok: false,
        status: 402,
        reason: "CREDITS_UNAVAILABLE",
        billingStatus: "credits_unavailable",
      });
    }

    if (response.status === 429) {
      return failed({
        ok: false,
        status: 429,
        reason: "RATE_LIMITED",
        billingStatus: "unknown",
      });
    }

    if (response.status >= 500) {
      return failed({
        ok: false,
        status: response.status,
        reason: "TRANSIENT_UPSTREAM",
        billingStatus: "unknown",
      });
    }

    if (!response.ok) {
      return failed({
        ok: false,
        status: response.status,
        reason: "TRANSIENT_UPSTREAM",
        billingStatus: "unknown",
      });
    }

    // Success response parsing
    const appendixUserDataSchema = z.object({
      status_code: z.number().optional(),
      tasks: z
        .array(
          z.object({
            status_code: z.number().optional(),
            result: z
              .array(
                z.object({
                  money: z
                    .object({
                      balance: z.number().optional(),
                      total: z.number().optional(),
                    })
                    .optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    });
    const parsedPayload = appendixUserDataSchema.safeParse(
      await response.json(),
    );
    const payload = parsedPayload.success ? parsedPayload.data : {};

    if (payload.status_code === 40100) {
      return failed({
        ok: false,
        status: 401,
        reason: "INVALID_CREDENTIALS",
        billingStatus: "unknown",
      });
    }

    const task = payload.tasks?.[0];

    if (payload.status_code === 40201 || task?.status_code === 40201) {
      return failed({
        ok: false,
        status: 402,
        reason: "DATAFORSEO_ACCESS_PAUSED",
        billingStatus: "unknown",
      });
    }

    if (
      payload.status_code === 40200 ||
      payload.status_code === 40210 ||
      task?.status_code === 40200 ||
      task?.status_code === 40210
    ) {
      return failed({
        ok: false,
        status: 402,
        reason: "CREDITS_UNAVAILABLE",
        billingStatus: "credits_unavailable",
      });
    }
    const money = task?.result?.[0]?.money;
    const balance = typeof money?.balance === "number" ? money.balance : null;

    let billingStatus: DataforseoConnectionTestResult["billingStatus"] =
      "unknown";
    if (balance !== null) {
      if (balance > 1) {
        billingStatus = "credits_available";
      } else if (balance > 0) {
        billingStatus = "low_balance";
      } else {
        billingStatus = "credits_unavailable";
      }
    }

    console.info("audit", {
      provider: "dataforseo",
      operation: "connection_test",
      status: 200,
      durationMs,
    });

    closeProviderCircuit(circuitIdentity);

    return {
      ok: true,
      status: 200,
      reason: "CONNECTED",
      balance,
      billingStatus,
    };
  } catch {
    return failed({
      ok: false,
      status: 503,
      reason: "TRANSIENT_UPSTREAM",
      billingStatus: "unknown",
    });
  }
}

/**
 * Check DataForSEO per-API endpoint status using the free, non-billable GET /v3/appendix/status endpoint.
 *
 * MANDATORY SAFETY RULES:
 * - Does NOT enter `meterDataforseoCall()`
 * - Does NOT consume SEO credits or trigger billable calls
 * - Does NOT write SEO cache
 * - Does NOT trigger budget guard or SAM tool recovery
 */
export async function checkDataforseoApiStatus(input: {
  organizationId: string;
  projectId?: string | null;
  login?: string;
  password?: string;
  fetchFn?: typeof fetch;
}): Promise<DataforseoApiStatusResult> {
  const customFetch = input.fetchFn ?? fetch;

  // 1. Resolve credentials: unsaved inputs if provided, else effective config
  let credsToTest: DataforseoCredentials | null = null;
  if (input.login?.trim() && input.password?.trim()) {
    credsToTest = {
      login: input.login.trim(),
      password: input.password.trim(),
    };
  } else if (input.login?.trim() && !input.password?.trim()) {
    const effective = await resolveEffectiveDataforseoConfig({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (effective.password) {
      credsToTest = {
        login: input.login.trim(),
        password: effective.password,
      };
    }
  } else {
    const effective = await resolveEffectiveDataforseoConfig({
      organizationId: input.organizationId,
      projectId: input.projectId,
    });
    if (effective.login && effective.password) {
      credsToTest = {
        login: effective.login,
        password: effective.password,
      };
    }
  }

  const nowIso = new Date().toISOString();

  if (!credsToTest) {
    return {
      ok: false,
      status: 400,
      reason: "NOT_CONFIGURED",
      endpoints: [],
      checkedAt: nowIso,
    };
  }

  const basicAuth = Buffer.from(
    `${credsToTest.login}:${credsToTest.password}`,
  ).toString("base64");

  const startedAt = Date.now();
  try {
    const response = await customFetch(
      `${DATAFORSEO_API_BASE}/v3/appendix/status`,
      {
        method: "GET",
        headers: {
          Authorization: `Basic ${basicAuth}`,
          Accept: "application/json",
        },
        signal: AbortSignal.timeout(TEST_CONNECTION_TIMEOUT_MS),
      },
    );

    const durationMs = Date.now() - startedAt;

    if (response.status === 401) {
      return {
        ok: false,
        status: 401,
        reason: "INVALID_CREDENTIALS",
        endpoints: [],
        checkedAt: nowIso,
      };
    }

    if (response.status === 429) {
      return {
        ok: false,
        status: 429,
        reason: "RATE_LIMITED",
        endpoints: [],
        checkedAt: nowIso,
      };
    }

    if (!response.ok) {
      return {
        ok: false,
        status: response.status,
        reason: "TRANSIENT_UPSTREAM",
        endpoints: [],
        checkedAt: nowIso,
      };
    }

    const appendixStatusSchema = z.object({
      status_code: z.number().optional(),
      tasks: z
        .array(
          z.object({
            status_code: z.number().optional(),
            result: z
              .array(
                z.object({
                  api: z.string(),
                  status: z.string(),
                  endpoints: z
                    .array(
                      z.object({
                        endpoint: z.string(),
                        status: z.string(),
                      }),
                    )
                    .nullable()
                    .optional(),
                }),
              )
              .optional(),
          }),
        )
        .optional(),
    });

    const parsedPayload = appendixStatusSchema.safeParse(await response.json());
    const payload = parsedPayload.success ? parsedPayload.data : {};

    if (payload.status_code === 40100) {
      return {
        ok: false,
        status: 401,
        reason: "INVALID_CREDENTIALS",
        endpoints: [],
        checkedAt: nowIso,
      };
    }

    const task = payload.tasks?.[0];
    const rawEndpoints = task?.result ?? [];

    const endpoints: DataforseoApiHealth[] = rawEndpoints.map((item) => ({
      api: item.api,
      status: item.status,
      endpoints: item.endpoints ?? null,
    }));

    console.info("audit", {
      provider: "dataforseo",
      operation: "api_status_check",
      status: 200,
      durationMs,
      endpointCount: endpoints.length,
    });

    return {
      ok: true,
      status: 200,
      reason: "CONNECTED",
      endpoints,
      checkedAt: nowIso,
    };
  } catch {
    return {
      ok: false,
      status: 503,
      reason: "TRANSIENT_UPSTREAM",
      endpoints: [],
      checkedAt: nowIso,
    };
  }
}
