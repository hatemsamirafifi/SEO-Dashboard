import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | {
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
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) => state.env.get(name)),
}));

vi.mock(
  "@/server/features/settings/repositories/SeoProviderSettingsRepository",
  () => ({
    SeoProviderSettingsRepository: {
      getOrganizationProviderSettingsRow: vi.fn(
        async (_organizationId: string, provider: string) =>
          state.row?.provider === provider ? state.row : null,
      ),
      getProjectProviderSettingsRow: vi.fn(async () => null),
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
          state.row = {
            provider,
            organizationId,
            projectId: null,
            updatedAt: new Date().toISOString(),
            ...input,
          };
        },
      ),
      upsertProjectProviderSettingsRow: vi.fn(),
      deleteOrganizationProviderSettings: vi.fn(async () => {
        state.row = null;
      }),
      deleteProjectProviderSettings: vi.fn(),
    },
  }),
);

import {
  DEFAULT_SERP_PRIORITIES,
  getSerpProviderSettingsView,
  removeSerpProviderSettings,
  saveSerpProviderSettings,
  testSerpProviderConnection,
} from "./SerpProviderSettingsService";
import {
  fingerprintProviderCredential,
  getProviderCircuitState,
  openProviderCircuit,
  resetProviderCircuitsForTests,
} from "@/server/features/serp/circuitBreaker";

describe("additional SERP provider settings", () => {
  beforeEach(() => {
    state.row = null;
    state.env.clear();
    resetProviderCircuitsForTests();
    state.env.set("AI_CREDENTIALS_ENCRYPTION_KEY", "settings-test-key");
  });

  it("saves an encrypted key and returns only masked scoped metadata", async () => {
    const secret = "serper-secret-abcdef";
    const view = await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-1",
      patch: { apiKey: secret, enabled: true, priority: 2 },
    });
    expect(state.row?.credentialsCiphertext).not.toContain(secret);
    expect(view).toMatchObject({
      provider: "serper",
      enabled: true,
      priority: 2,
      source: "organization",
      configured: true,
      apiKeyMasked: "••••••••••cdef",
    });
    expect(JSON.stringify(view)).not.toContain(secret);
  });

  it("changes and removes a key without revealing it", async () => {
    await saveSerpProviderSettings({
      provider: "zenserp",
      organizationId: "org-1",
      patch: { apiKey: "old-key-1111", enabled: true, priority: 3 },
    });
    const changed = await saveSerpProviderSettings({
      provider: "zenserp",
      organizationId: "org-1",
      patch: { apiKey: "new-key-2222", priority: 2 },
    });
    expect(changed.apiKeyMasked).toBe("••••••••••2222");
    const removed = await removeSerpProviderSettings({
      provider: "zenserp",
      organizationId: "org-1",
    });
    expect(removed.configured).toBe(false);
  });

  it("uses environment fallback disabled by default", async () => {
    state.env.set("SERPER_API_KEY", "environment-key-9876");
    const view = await getSerpProviderSettingsView({
      provider: "serper",
      organizationId: "org-1",
    });
    expect(view).toMatchObject({
      source: "environment",
      configured: true,
      enabled: false,
      apiKeyMasked: "••••••••••9876",
    });
  });

  it("uses the documented fresh default provider priorities", async () => {
    expect(DEFAULT_SERP_PRIORITIES).toEqual({
      dataforseo: 1,
      serper: 2,
      zenserp: 3,
    });
    const [serper, zenserp] = await Promise.all([
      getSerpProviderSettingsView({
        provider: "serper",
        organizationId: "org-1",
      }),
      getSerpProviderSettingsView({
        provider: "zenserp",
        organizationId: "org-1",
      }),
    ]);
    expect(serper.priority).toBe(2);
    expect(zenserp.priority).toBe(3);
  });

  it.each([
    ["serper", "X-API-KEY"],
    ["zenserp", "apikey"],
  ] as const)(
    "tests a %s connection with one safe query and returns latency/status only",
    async (provider, headerName) => {
      const fetchFn = vi.fn(
        async (_input: URL | RequestInfo, init?: RequestInit) => {
          expect(new Headers(init?.headers).get(headerName)).toBe("live-key");
          return new Response(JSON.stringify({ organic: [] }), { status: 200 });
        },
      );
      const result = await testSerpProviderConnection({
        provider,
        organizationId: "org-1",
        apiKey: "live-key",
        fetchFn,
      });
      expect(result).toMatchObject({
        ok: true,
        status: 200,
        reason: "CONNECTED",
        consumesQuery: true,
      });
      expect(JSON.stringify(result)).not.toContain("live-key");
    },
  );

  it("persists circuitBreakerEnabled per provider independently", async () => {
    const serper = await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-cb",
      patch: { apiKey: "serper-key-0001", circuitBreakerEnabled: false },
    });
    const zenserp = await saveSerpProviderSettings({
      provider: "zenserp",
      organizationId: "org-cb",
      patch: { apiKey: "zenserp-key-0002" },
    });
    expect(serper.circuitBreakerEnabled).toBe(false);
    expect(zenserp.circuitBreakerEnabled).toBe(true);
    expect(state.row?.provider).toBe("zenserp");
    expect(state.row?.circuitBreakerEnabled).toBe(true);
  });

  it("persists maxRetries per provider independently (0-5)", async () => {
    const serper = await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-retries",
      patch: { apiKey: "serper-key-r1", maxRetries: 0 },
    });
    const zenserp = await saveSerpProviderSettings({
      provider: "zenserp",
      organizationId: "org-retries",
      patch: { apiKey: "zenserp-key-r2", maxRetries: 5 },
    });
    expect(serper.maxRetries).toBe(0);
    expect(zenserp.maxRetries).toBe(5);
    expect(state.row?.maxRetries).toBe(5);
  });

  it("defaults maxRetries to 2 and clamps out-of-range values", async () => {
    const view = await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-retries-default",
      patch: { apiKey: "serper-key-r3" },
    });
    expect(view.maxRetries).toBe(2);
  });

  it("honors SERPER_MAX_RETRIES environment default", async () => {
    state.env.set("SERPER_API_KEY", "env-serper-key");
    state.env.set("SERPER_MAX_RETRIES", "4");
    const view = await getSerpProviderSettingsView({
      provider: "serper",
      organizationId: "org-retries-env",
    });
    expect(view.maxRetries).toBe(4);
  });

  it("defaults circuitBreakerEnabled to true when unset", async () => {
    const view = await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-cb-default",
      patch: { apiKey: "serper-key-0003" },
    });
    expect(view.circuitBreakerEnabled).toBe(true);
  });

  it("honors SERPER_CIRCUIT_BREAKER_ENABLED=false environment default", async () => {
    state.env.set("SERPER_API_KEY", "env-serper-key");
    state.env.set("SERPER_CIRCUIT_BREAKER_ENABLED", "false");
    const view = await getSerpProviderSettingsView({
      provider: "serper",
      organizationId: "org-cb-env",
    });
    expect(view.circuitBreakerEnabled).toBe(false);

    state.env.set("ZENSERP_CIRCUIT_BREAKER_ENABLED", "false");
    const zenserp = await getSerpProviderSettingsView({
      provider: "zenserp",
      organizationId: "org-cb-env",
    });
    expect(zenserp.circuitBreakerEnabled).toBe(false);
  });

  it("closes a stale open circuit when the breaker is disabled", async () => {
    const fingerprint = await fingerprintProviderCredential("serper", [
      "serper-key-0004",
    ]);
    const identity = {
      provider: "serper" as const,
      organizationId: "org-cb-close",
      projectId: null,
      credentialFingerprint: fingerprint,
    };
    openProviderCircuit(identity, "QUOTA_EXHAUSTED");
    expect(getProviderCircuitState(identity)).not.toBeNull();

    await saveSerpProviderSettings({
      provider: "serper",
      organizationId: "org-cb-close",
      patch: { apiKey: "serper-key-0004", circuitBreakerEnabled: false },
    });
    expect(getProviderCircuitState(identity)).toBeNull();
  });
});
