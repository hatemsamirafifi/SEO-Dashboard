import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  row: null as null | {
    provider: string;
    enabled: boolean;
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
      getOrganizationProviderSettingsRow: vi.fn(async () => state.row),
      getProjectProviderSettingsRow: vi.fn(async () => null),
      upsertOrganizationProviderSettingsRow: vi.fn(
        async (
          organizationId: string,
          provider: string,
          input: {
            enabled: boolean;
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
import { resetProviderCircuitsForTests } from "@/server/features/serp/circuitBreaker";

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
});
