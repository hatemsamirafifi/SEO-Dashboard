/* eslint-disable typescript-eslint/unbound-method */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));

const mocks = vi.hoisted(() => ({
  r2Get: vi.fn(async () => null),
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
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => {}),
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
import type { SEODataProvider, SEODataRequest } from "./types";
import { resetProviderConfigCache } from "./config";

describe("DataRouter with SE Ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERANKING_ENABLED = "true";
    process.env.DATAFORSEO_ENABLED = "true";
    resetProviderConfigCache();
  });

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
});
