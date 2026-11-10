import { describe, it, expect, vi, beforeEach } from "vitest";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type * as SeoDataConfig from "@/server/lib/seo-data/config";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(async () => "test-cache-key"),
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => {}),
}));

const mockFlags = vi.hoisted(() => ({
  routerEnabled: true,
  serankingEnabled: false,
  dataforseoEnabled: false,
  gscEnabled: false,
  googleAdsEnabled: false,
  bingWebmasterEnabled: false,
  localCrawlerEnabled: true,
}));

vi.mock("@/server/lib/seo-data/config", async (importOriginal) => {
  const actual = await importOriginal<typeof SeoDataConfig>();
  return {
    ...actual,
    getProviderFeatureFlags: vi.fn(async () => mockFlags),
  };
});

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (key: string) => {
    if (key === "DATAFORSEO_ENABLED") return "false";
    return undefined;
  }),
  isHostedServerAuthMode: vi.fn(async () => false),
}));

vi.mock("@/server/features/settings/repositories/SeoProviderSettingsRepository", () => ({
  SeoProviderSettingsRepository: {
    getProjectProviderSettingsRow: vi.fn(async () => ({
      provider: "dataforseo",
      enabled: true, // DB row has enabled=true, but DATAFORSEO_ENABLED=false kill switch must override
      circuitBreakerEnabled: true,
      maxRetries: 2,
      credentialsCiphertext: "mock-cipher",
      priority: 1,
    })),
    getOrganizationProviderSettingsRow: vi.fn(async () => null),
  },
}));

vi.mock("@/server/features/settings/dataforseoCrypto", () => ({
  decryptDataforseoCredentials: vi.fn(async () => ({
    login: "test-login",
    password: "test-password",
  })),
}));

import { createDataforseoClient } from "./client";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";

describe("DATAFORSEO_ENABLED=false system-wide kill switch enforcement", () => {
  const customer: BillingCustomerContext = {
    organizationId: "org-1",
    projectId: "proj-1",
    userId: "user-1",
    userEmail: "test@example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resolveEffectiveDataforseoConfig overrides DB rows and returns enabled=false", async () => {
    const config = await resolveEffectiveDataforseoConfig({
      organizationId: "org-1",
      projectId: "proj-1",
    });
    expect(config.enabled).toBe(false);
  });

  it("createDataforseoClient throws ProviderUnavailableError on API calls", async () => {
    const client = createDataforseoClient(customer);
    await expect(
      client.keywords.ideas({
        keyword: "seo",
        locationCode: 2840,
        languageCode: "en",
        limit: 10,
      }),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("getBrandLookup fails with ProviderUnavailableError instead of returning misleading success", async () => {
    await expect(
      getBrandLookup(
        {
          projectId: "proj-1",
          query: "example.com",
          locationCode: 2840,
          languageCode: "en",
          competitors: [],
        },
        customer,
      ),
    ).rejects.toThrow(ProviderUnavailableError);
  });

  it("explorePrompt fails with ProviderUnavailableError instead of returning misleading success", async () => {
    await expect(
      explorePrompt(
        {
          projectId: "proj-1",
          prompt: "What is SEO?",
          models: ["chat_gpt"],
          webSearch: false,
        },
        customer,
      ),
    ).rejects.toThrow(ProviderUnavailableError);
  });
});
