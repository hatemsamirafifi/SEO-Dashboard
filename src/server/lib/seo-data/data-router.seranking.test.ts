/* eslint-disable typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

const mocks = vi.hoisted(() => ({
  r2Get: vi.fn<(...args: unknown[]) => Promise<unknown>>(async () => null),
  r2Put: vi.fn(async () => {}),
  recordFreeProviderCall: vi.fn(),
  recordCacheHit: vi.fn(),
  recordCacheMiss: vi.fn(),
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) =>
      `${prefix}:${JSON.stringify(params)}`,
  ),
  getCached: (...args: unknown[]) => mocks.r2Get(...(args as [])),
  setCached: (...args: unknown[]) => mocks.r2Put(...(args as [])),
  CACHE_TTL: { researchResult: 86400 },
}));

vi.mock("./cost-tracker", () => ({
  assertDataforseoBudgetAvailable: vi.fn(async () => {}),
  recordCacheHit: mocks.recordCacheHit,
  recordCacheMiss: mocks.recordCacheMiss,
  recordDataforseoCall: vi.fn(),
  recordFreeProviderCall: mocks.recordFreeProviderCall,
  logRequest: vi.fn(),
}));

import { DataRouter } from "./data-router";
import { RateLimitError } from "./errors";
import type { SEODataProvider, SEODataRequest } from "./types";
import { resetProviderConfigCache } from "./config";
import { KEYWORD_CACHE_VERSION } from "./cache-service";
import { SeRankingValidationError } from "@/server/lib/seranking/errors";

describe("DataRouter with SE Ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERANKING_ENABLED = "true";
    process.env.DATAFORSEO_ENABLED = "true";
    resetProviderConfigCache();
  });

  it.each([
    "keyword_ideas",
    "keyword_metrics",
    "serp",
    "competitive_metrics",
  ] as const)(
    "never dispatches DataForSEO for an excluded %s request, including without the router",
    async (dataType) => {
      const provider = {
        name: "dataforseo",
        supports: () => true,
        get: vi.fn(async () => []),
      };
      const router = new DataRouter();
      router.register(provider);
      const request: SEODataRequest = {
        dataType,
        keyword: "ملاعب",
        locationCode: 2818,
        languageCode: "ar",
        excludeDataforseo: true,
        billingCustomer: {
          organizationId: "org-1",
          userId: "u-1",
          userEmail: "u@example.com",
        },
      };
      try {
        for (const enabled of ["true", "false"]) {
          vi.stubEnv("SEO_PROVIDER_ROUTER_ENABLED", enabled);
          vi.stubEnv("SERANKING_ENABLED", "false");
          resetProviderConfigCache();
          await expect(router.route(request)).rejects.toThrow(
            "No provider available",
          );
        }
        expect(provider.get).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllEnvs();
        resetProviderConfigCache();
      }
    },
  );

  it("tries SE Ranking before DataForSEO for domain_overview and does NOT record SE Ranking as free provider", async () => {
    const router = new DataRouter();

    const serankingProvider: SEODataProvider = {
      name: "seranking",
      supports: () => true,
      get: vi.fn(async () => [
        { metrics: { organic: { etv: 1000, count: 500 } } },
      ]),
    };

    const dfsProvider: SEODataProvider = {
      name: "dataforseo",
      supports: () => true,
      get: vi.fn(async () => [
        { metrics: { organic: { etv: 2000, count: 800 } } },
      ]),
    };

    router.register(serankingProvider);
    router.register(dfsProvider);

    const request: SEODataRequest = {
      dataType: "domain_overview",
      domain: "example.com",
      billingCustomer: {
        organizationId: "org-1",
        userId: "u-1",
        userEmail: "u@example.com",
      },
    };

    const response = await router.route(request);

    expect(response.provider).toBe("provider");
    expect(serankingProvider.get).toHaveBeenCalledTimes(1);
    expect(dfsProvider.get).not.toHaveBeenCalled();
    // CRITICAL: SE Ranking must NOT be recorded as a free provider
    expect(mocks.recordFreeProviderCall).not.toHaveBeenCalledWith("seranking");
  });

  it("works when DataForSEO is completely disabled (DATAFORSEO_ENABLED=false)", async () => {
    process.env.DATAFORSEO_ENABLED = "false";
    resetProviderConfigCache();
    const router = new DataRouter();

    const serankingProvider: SEODataProvider = {
      name: "seranking",
      supports: () => true,
      get: vi.fn(async () => [
        {
          keyword: "test",
          searchVolume: 100,
          cpc: 1.0,
          competition: 0.5,
          competitionLevel: "MEDIUM",
          keywordDifficulty: 40,
          intent: "informational",
          monthlySearches: [],
        },
      ]),
    };

    const dfsProvider: SEODataProvider = {
      name: "dataforseo",
      supports: () => true,
      get: vi.fn(async () => []),
    };

    router.register(serankingProvider);
    router.register(dfsProvider);

    const request: SEODataRequest = {
      dataType: "keyword_metrics",
      keywords: ["test"],
      billingCustomer: {
        organizationId: "org-1",
        userId: "u-1",
        userEmail: "u@example.com",
      },
    };

    const response = await router.route(request);

    expect(serankingProvider.get).toHaveBeenCalledTimes(1);
    expect(dfsProvider.get).not.toHaveBeenCalled();
    expect(response.data).toEqual([
      expect.objectContaining({
        keyword: "test",
        searchVolume: 100,
      }),
    ]);
  });

  it("reports only actually attempted providers (skips unsupported google_ads) and reports empty attemptedProviders on cache hit", async () => {
    process.env.DATAFORSEO_ENABLED = "false";
    process.env.GOOGLE_ADS_ENABLED = "true";
    resetProviderConfigCache();
    const router = new DataRouter();

    const googleAdsProvider: SEODataProvider = {
      name: "google_ads",
      supports: () => false, // does not support suggestions/related
      get: vi.fn(async () => []),
    };

    const serankingProvider: SEODataProvider = {
      name: "seranking",
      supports: () => true,
      get: vi.fn(async () => []),
    };

    router.register(googleAdsProvider);
    router.register(serankingProvider);

    const request: SEODataRequest = {
      dataType: "keyword_ideas",
      keyword: "إنشاء ملاعب صناعية",
      locationCode: 2818,
      languageCode: "ar",
      constraints: { source: "suggestions", limit: 10 },
      billingCustomer: {
        organizationId: "org-1",
        userId: "u-1",
        userEmail: "u@example.com",
      },
    };

    const missResponse = await router.route(request);
    expect(missResponse.fromCache).toBe(false);
    expect(missResponse.provider).toBe("seranking");
    expect(missResponse.attemptedProviders).toEqual(["seranking"]);
    expect(googleAdsProvider.get).not.toHaveBeenCalled();

    // Subsequent cache hit should report no attempted providers
    mocks.r2Get.mockResolvedValueOnce({
      seoCacheVersion: KEYWORD_CACHE_VERSION,
      provider: "seranking",
      fetchedAt: new Date().toISOString(),
      data: [],
    });
    const hitResponse = await router.route(request);
    expect(hitResponse.fromCache).toBe(true);
    expect(hitResponse.provider).toBe("seranking");
    expect(hitResponse.attemptedProviders).toEqual([]);
  });

  it("does not cache transient 429 failures or malformed validation errors as empty results", async () => {
    process.env.DATAFORSEO_ENABLED = "false";
    resetProviderConfigCache();
    const router = new DataRouter();

    const rateLimitedProvider: SEODataProvider = {
      name: "seranking",
      supports: () => true,
      get: vi.fn(async () => {
        throw new RateLimitError("seranking", "HTTP 429");
      }),
    };
    router.register(rateLimitedProvider);

    const request: SEODataRequest = {
      dataType: "keyword_ideas",
      keyword: "إنشاء ملاعب صناعية",
      locationCode: 2818,
      languageCode: "ar",
      constraints: { source: "suggestions", limit: 10 },
      billingCustomer: {
        organizationId: "org-1",
        userId: "u-1",
        userEmail: "u@example.com",
      },
    };

    await expect(router.route(request)).rejects.toThrow(/HTTP 429/);
    expect(mocks.r2Put).not.toHaveBeenCalled();

    const malformedProvider: SEODataProvider = {
      name: "seranking",
      supports: () => true,
      get: vi.fn(async () => {
        throw new SeRankingValidationError(
          "Unexpected response shape",
          undefined,
          200,
          0,
        );
      }),
    };
    router.register(malformedProvider);

    await expect(router.route(request)).rejects.toBeInstanceOf(
      SeRankingValidationError,
    );
    expect(mocks.r2Put).not.toHaveBeenCalled();
  });
});
