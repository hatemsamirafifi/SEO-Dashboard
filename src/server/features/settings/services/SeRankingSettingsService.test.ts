import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  orgRow: null as null | {
    provider: string;
    enabled: boolean;
    circuitBreakerEnabled: boolean;
    maxRetries: number;
    priority: number | null;
    credentialsCiphertext: string | null;
    organizationId: string | null;
    projectId: string | null;
    updatedAt: string;
  },
  projectRow: null as null | {
    provider: string;
    enabled: boolean;
    circuitBreakerEnabled: boolean;
    maxRetries: number;
    priority: number | null;
    credentialsCiphertext: string | null;
    organizationId: string | null;
    projectId: string | null;
    updatedAt: string;
  },
  env: new Map<string, string>(),
  fetchResponse: {
    status: 200,
    ok: true,
    data: {
      status: "active",
      units_limit: 100000,
      units_left: 75000,
    },
  },
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) => state.env.get(name)),
}));

vi.mock(
  "@/server/features/settings/repositories/SeoProviderSettingsRepository",
  () => ({
    SeoProviderSettingsRepository: {
      getOrganizationProviderSettingsRow: vi.fn(
        async (_orgId: string, provider: string) =>
          state.orgRow?.provider === provider ? state.orgRow : null,
      ),
      getProjectProviderSettingsRow: vi.fn(
        async (_projId: string, provider: string) =>
          state.projectRow?.provider === provider ? state.projectRow : null,
      ),
      upsertOrganizationProviderSettingsRow: vi.fn(
        async (
          organizationId: string,
          provider: string,
          input: {
            enabled: boolean;
            circuitBreakerEnabled: boolean;
            maxRetries: number;
            priority: number;
            credentialsCiphertext: string | null;
          },
        ) => {
          state.orgRow = {
            provider,
            organizationId,
            projectId: null,
            updatedAt: new Date().toISOString(),
            ...input,
          };
        },
      ),
      upsertProjectProviderSettingsRow: vi.fn(
        async (
          projectId: string,
          provider: string,
          input: {
            enabled: boolean;
            circuitBreakerEnabled: boolean;
            maxRetries: number;
            priority: number;
            credentialsCiphertext: string | null;
          },
        ) => {
          state.projectRow = {
            provider,
            organizationId: null,
            projectId,
            updatedAt: new Date().toISOString(),
            ...input,
          };
        },
      ),
      deleteOrganizationProviderSettings: vi.fn(async () => {
        state.orgRow = null;
      }),
      deleteProjectProviderSettings: vi.fn(async () => {
        state.projectRow = null;
      }),
    },
  }),
);

vi.mock("@/server/features/settings/serankingCrypto", () => ({
  encryptSeRankingApiKey: vi.fn(async (key: string) => `encrypted:${key}`),
  decryptSeRankingApiKey: vi.fn(async (cipher: string) =>
    cipher.startsWith("encrypted:") ? cipher.slice("encrypted:".length) : null,
  ),
  maskSeRankingApiKey: vi.fn((key?: string | null) =>
    key && key.length > 4 ? `••••••••••••${key.slice(-4)}` : (key ? "••••••••" : null),
  ),
}));

// Mock global fetch for subscription checks
const originalFetch = globalThis.fetch;
beforeEach(() => {
  state.orgRow = null;
  state.projectRow = null;
  state.env.clear();
  state.fetchResponse = {
    status: 200,
    ok: true,
    data: {
      status: "active",
      units_limit: 100000,
      units_left: 75000,
    },
  };
  globalThis.fetch = vi.fn(async () => ({
    status: state.fetchResponse.status,
    ok: state.fetchResponse.ok,
    json: async () => state.fetchResponse.data,
    headers: new Headers({ "content-type": "application/json" }),
  })) as unknown as typeof fetch;
});

afterAll(() => {
  globalThis.fetch = originalFetch;
});

import {
  resolveEffectiveSeRankingConfig,
  getSeRankingSettingsView,
  saveSeRankingSettings,
  removeSeRankingSettings,
  testSeRankingConnection,
} from "./SeRankingSettingsService";

describe("SeRankingSettingsService", () => {
  it("resolves unconfigured state when no settings or env vars exist", async () => {
    const config = await resolveEffectiveSeRankingConfig();
    expect(config.configured).toBe(false);
    expect(config.source).toBe("none");
    expect(config.apiKey).toBeUndefined();
  });

  it("resolves environment credentials when SERANKING_API_KEY is set", async () => {
    state.env.set("SERANKING_API_KEY", "env-api-token-1234");
    const config = await resolveEffectiveSeRankingConfig();
    expect(config.configured).toBe(true);
    expect(config.source).toBe("environment");
    expect(config.apiKey).toBe("env-api-token-1234");
  });

  it("persists and reads organization settings with masked API key", async () => {
    await saveSeRankingSettings({
      organizationId: "org-1",
      patch: {
        apiKey: "org-secret-token-9999",
        enabled: true,
        priority: 1,
      },
    });

    const view = await getSeRankingSettingsView({ organizationId: "org-1" });
    expect(view.configured).toBe(true);
    expect(view.source).toBe("organization");
    expect(view.apiKeyMasked).toBe("••••••••••••9999");
    expect(view.priority).toBe(1);
    expect(view.enabled).toBe(true);
  });

  it("project settings override organization settings", async () => {
    await saveSeRankingSettings({
      organizationId: "org-1",
      patch: {
        apiKey: "org-token-1111",
        enabled: true,
        priority: 1,
      },
    });

    await saveSeRankingSettings({
      organizationId: "org-1",
      projectId: "proj-1",
      patch: {
        apiKey: "proj-token-2222",
        enabled: true,
        priority: 2,
      },
    });

    const config = await resolveEffectiveSeRankingConfig({
      organizationId: "org-1",
      projectId: "proj-1",
    });

    expect(config.source).toBe("project");
    expect(config.apiKey).toBe("proj-token-2222");
    expect(config.priority).toBe(2);

    const view = await getSeRankingSettingsView({
      organizationId: "org-1",
      projectId: "proj-1",
    });
    expect(view.override).not.toBeNull();
    expect(view.override?.apiKeyMasked).toBe("••••••••••••2222");
  });

  it("removes project override and falls back to organization settings", async () => {
    await saveSeRankingSettings({
      organizationId: "org-1",
      patch: {
        apiKey: "org-token-1111",
        enabled: true,
      },
    });

    await saveSeRankingSettings({
      organizationId: "org-1",
      projectId: "proj-1",
      patch: {
        apiKey: "proj-token-2222",
        enabled: false,
      },
    });

    await removeSeRankingSettings({
      organizationId: "org-1",
      projectId: "proj-1",
    });

    const config = await resolveEffectiveSeRankingConfig({
      organizationId: "org-1",
      projectId: "proj-1",
    });
    expect(config.source).toBe("organization");
    expect(config.apiKey).toBe("org-token-1111");
    expect(config.enabled).toBe(true);
  });

  it("tests connection successfully via subscription endpoint", async () => {
    const result = await testSeRankingConnection({
      apiKey: "test-token-1234",
    });

    expect(result.ok).toBe(true);
    expect(result.reason).toBe("CONNECTED");
    expect(result.balance).toBe(75000);
    expect(result.unitsLimit).toBe(100000);
    expect(result.subscriptionStatus).toBe("active");
  });

  it("tests connection successfully with real upstream nested subscription_info response", async () => {
    state.fetchResponse = {
      status: 200,
      ok: true,
      data: {
        subscription_info: {
          status: "active",
          start_date: "2026-01-18 14:20:02",
          expiration_date: "2026-02-18 14:20:02",
          units_limit: 100000,
          units_left: 100000,
        },
      } as unknown as {
        status: string;
        units_limit: number;
        units_left: number;
      },
    };

    const result = await testSeRankingConnection({
      apiKey: "test-token-real-sub",
    });

    expect(result.ok).toBe(true);
    expect(result.status).toBe(200);
    expect(result.reason).toBe("CONNECTED");
    expect(result.balance).toBe(100000);
    expect(result.unitsLimit).toBe(100000);
    expect(result.subscriptionStatus).toBe("active");
  });

  it("reports invalid credentials when API returns 401", async () => {
    state.fetchResponse = {
      status: 401,
      ok: false,
      data: { message: "Unauthorized token" } as unknown as {
        status: string;
        units_limit: number;
        units_left: number;
      },
    };

    const result = await testSeRankingConnection({
      apiKey: "invalid-token",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("INVALID_CREDENTIALS");
  });

  it("reports credits exhausted when subscription balance is 0 or 402", async () => {
    state.fetchResponse = {
      status: 200,
      ok: true,
      data: {
        status: "active",
        units_limit: 100000,
        units_left: 0,
      },
    };

    const result = await testSeRankingConnection({
      apiKey: "token-no-credits",
    });

    expect(result.ok).toBe(false);
    expect(result.reason).toBe("CREDITS_UNAVAILABLE");
  });
});
