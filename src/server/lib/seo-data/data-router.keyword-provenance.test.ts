/* eslint-disable max-lines-per-function -- keyword provenance suite */
import { describe, it, expect, beforeEach, vi } from "vitest";

import { ProviderUnavailableError, ProviderUnsupportedError } from "./errors";
import { resetCostCounters, resetBudgetConfigCache } from "./cost-tracker";
import { resetProviderConfigCache } from "./config";
import { clearSingleFlight } from "./single-flight";
import type { SEODataProvider, SEODataRequest } from "./types";

const connectionRepo = vi.hoisted(() => ({
  getByProjectId: vi.fn(async () => null),
}));

const cached = vi.hoisted(() => ({
  getCached: vi.fn<(key: string) => Promise<unknown>>(async () => null),
  setCached: vi.fn<(key: string, data: unknown, ttl: number) => Promise<void>>(
    async () => {},
  ),
}));

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository",
  () => ({
    GoogleAdsConnectionRepository: connectionRepo,
  }),
);

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) =>
      `${prefix}:${JSON.stringify(params)}`,
  ),
  getCached: (key: string) => cached.getCached(key),
  setCached: (key: string, data: unknown, ttl: number) =>
    cached.setCached(key, data, ttl),
  getStaleCached: vi.fn(async () => null),
  CACHE_TTL: { researchResult: 86400 },
}));

vi.mock("@/db", () => ({ db: {} }));

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { DataRouter } from "./data-router";
import { KEYWORD_CACHE_VERSION } from "./cache-service";

function makeProvider(
  name: string,
  supported: boolean,
  result: unknown,
  opts?: { throws?: unknown },
): SEODataProvider {
  return {
    name,
    supports: () => supported,
    get: async () => {
      if (opts?.throws) throw opts.throws;
      return result;
    },
  };
}

const FRESH_FETCHED_AT = "2026-10-23T12:00:00.000Z";

function makeKeywordRequest(
  overrides: Partial<SEODataRequest> = {},
): SEODataRequest {
  return {
    dataType: "keyword_ideas",
    keyword: "email marketing",
    locationCode: 2840,
    languageCode: "en",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
    billingCustomer: { organizationId: "org-1", projectId: "proj-1" } as never,
    constraints: { source: "ideas" },
    ...overrides,
  };
}

function googleAdsFailure(): Error {
  const error = new ProviderUnavailableError("google_ads", "quota exhausted");
  Object.defineProperty(error, "firstPartyError", {
    value: {
      provider: "google_ads",
      errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
      message: "quota exhausted",
      retryable: true,
    },
  });
  return error;
}

describe("DataRouter — keyword provider provenance", () => {
  let router: DataRouter;

  beforeEach(() => {
    vi.clearAllMocks();
    cached.getCached.mockResolvedValue(null);
    resetCostCounters();
    resetBudgetConfigCache();
    resetProviderConfigCache();
    clearSingleFlight();
    router = new DataRouter();
  });

  it("reports the winning first-party provider on fresh keyword data", async () => {
    router.register(
      makeProvider("google_ads", true, {
        ideas: [],
        keywords: [],
        missingKeywords: [],
        malformedKeywords: [],
        duplicateKeywords: [],
        truncated: false,
        partial: false,
        source: "google_ads",
        fetchedAt: FRESH_FETCHED_AT,
      }),
    );

    const response = await router.route(makeKeywordRequest());

    expect(response.fromCache).toBe(false);
    expect(response.provider).toBe("google_ads");
    expect(response.fetchedAt).toBe(FRESH_FETCHED_AT);
  });

  it("writes keyword cache entries as versioned provider envelopes", async () => {
    const googlePayload = {
      ideas: [],
      keywords: [],
      missingKeywords: [],
      malformedKeywords: [],
      duplicateKeywords: [],
      truncated: false,
      partial: false,
      source: "google_ads",
      fetchedAt: FRESH_FETCHED_AT,
    };
    router.register(makeProvider("google_ads", true, googlePayload));

    const response = await router.route(makeKeywordRequest());

    expect(cached.setCached).toHaveBeenCalledWith(
      expect.any(String),
      {
        seoCacheVersion: KEYWORD_CACHE_VERSION,
        provider: "google_ads",
        fetchedAt: FRESH_FETCHED_AT,
        data: googlePayload,
      },
      expect.any(Number),
    );
    void response;
  });

  it("attaches the first-party failure when DataForSEO serves as fallback", async () => {
    router.register(
      makeProvider("google_ads", true, null, { throws: googleAdsFailure() }),
    );
    router.register(
      makeProvider("dataforseo", true, { ideas: [{ keyword: "x" }] }),
    );

    const response = await router.route(makeKeywordRequest());

    expect(response.provider).toBe("dataforseo");
    expect(response.firstPartyError).toEqual({
      provider: "google_ads",
      errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
      message: "quota exhausted",
      retryable: true,
    });
  });

  it("does not attach firstPartyError when google_ads itself wins", async () => {
    router.register(
      makeProvider("google_ads", true, {
        ideas: [],
        keywords: [],
        missingKeywords: [],
        malformedKeywords: [],
        duplicateKeywords: [],
        truncated: false,
        partial: false,
        source: "google_ads",
        fetchedAt: FRESH_FETCHED_AT,
      }),
    );

    const response = await router.route(makeKeywordRequest());

    expect(response.firstPartyError).toBeUndefined();
  });

  it("surfaces cached provider provenance on keyword cache hits", async () => {
    cached.getCached.mockResolvedValue({
      seoCacheVersion: KEYWORD_CACHE_VERSION,
      provider: "dataforseo",
      fetchedAt: FRESH_FETCHED_AT,
      data: { ideas: [{ keyword: "cached" }] },
    });
    router.register(
      makeProvider("google_ads", true, null, {
        throws: new ProviderUnsupportedError("google_ads", "keyword_ideas"),
      }),
    );
    router.register(
      makeProvider("dataforseo", true, { ideas: [{ keyword: "fresh" }] }),
    );

    const response = await router.route(makeKeywordRequest());

    expect(response.fromCache).toBe(true);
    expect(response.provider).toBe("dataforseo");
    expect(response.fetchedAt).toBe(FRESH_FETCHED_AT);
  });

  it("keeps the generic provider literal for fresh non-keyword responses", async () => {
    router.register(makeProvider("internal", true, { items: ["a"] }));

    const response = await router.route({
      dataType: "serp",
      keyword: "test",
      locationCode: 2840,
      languageCode: "en",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
      billingCustomer: { organizationId: "org-1" } as never,
    });

    expect(response.fromCache).toBe(false);
    expect(response.provider).toBe("provider");
    expect(response.fetchedAt).toBeUndefined();
  });

  it("does not mask a total keyword failure as first-party provenance", async () => {
    router.register(
      makeProvider("google_ads", true, null, {
        throws: new ProviderUnavailableError("google_ads", "down"),
      }),
    );
    router.register(
      makeProvider("dataforseo", true, null, {
        throws: new ProviderUnavailableError("dataforseo", "down"),
      }),
    );

    await expect(router.route(makeKeywordRequest())).rejects.toThrow();
  });
});
