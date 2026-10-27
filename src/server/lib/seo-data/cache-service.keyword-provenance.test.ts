/* eslint-disable max-lines-per-function -- keyword envelope suite needs full coverage */
// oxlint-disable typescript/no-unsafe-type-assertion — test-only suite: connection fixtures, fetcher stubs and billing-context mocks are intentionally loose
import { describe, it, expect, beforeEach, vi } from "vitest";
import { z } from "zod";

import { SeoCacheService, KEYWORD_CACHE_VERSION } from "./cache-service";
import { resetProviderConfigCache } from "./config";
import type { SEODataRequest } from "./types";
import type { GoogleAdsConnectionRepository } from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";

// Isolate the connection lookup: the planner identity enters cache keys
// through GoogleAdsConnectionRepository, mocked here so the @/db graph
// and the real googleAdsClient never load.
const connectionRepo = vi.hoisted(() => ({
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion — the mock must accept arbitrary connection rows and `null` misses alike
  getByProjectId: vi.fn<
    (projectId: string, organizationId: string) => Promise<unknown>
  >(async () => null),
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
    async (prefix: string, params: Record<string, unknown>) => {
      const raw = JSON.stringify(
        Object.entries(params).toSorted(([a], [b]) => a.localeCompare(b)),
      );
      return `${prefix}:${raw}`;
    },
  ),
  getCached: (key: string) => cached.getCached(key),
  setCached: (key: string, data: unknown, ttl: number) =>
    cached.setCached(key, data, ttl),
  getStaleCached: vi.fn(async () => null),
  CACHE_TTL: { researchResult: 86400 },
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

const CONNECTED_CONNECTION = {
  id: "conn-1",
  projectId: "proj-1",
  customerId: "4897513260",
  loginCustomerId: "3216549870",
  currencyCode: "USD",
  status: "active",
  connectedByUserId: "user-1",
  grantAccountId: "grant-1",
  connectedAt: new Date("2026-10-01T00:00:00.000Z"),
} as unknown as Awaited<
  ReturnType<typeof GoogleAdsConnectionRepository.getByProjectId>
>;

function keywordIdeasRequest(
  overrides: Partial<SEODataRequest> = {},
): SEODataRequest {
  return {
    dataType: "keyword_ideas",
    keyword: "email marketing",
    locationCode: 2840,
    languageCode: "en",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
    billingCustomer: { organizationId: "org-1", projectId: "proj-1" } as never,
    constraints: { source: "ideas", limit: 10 },
    ...overrides,
  };
}

function keywordMetricsRequest(
  overrides: Partial<SEODataRequest> = {},
): SEODataRequest {
  return {
    dataType: "keyword_metrics",
    keyword: "email marketing",
    locationCode: 2840,
    languageCode: "en",
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
    billingCustomer: { organizationId: "org-1", projectId: "proj-1" } as never,
    constraints: { projectId: "proj-1" },
    ...overrides,
  };
}

const payloadSchema = z.object({ keywords: z.array(z.string()) });

function envelopeFor(
  data: { keywords: string[] },
  fetchedAt: string = new Date().toISOString(),
): unknown {
  return {
    seoCacheVersion: KEYWORD_CACHE_VERSION,
    provider: "google_ads",
    fetchedAt,
    data,
  };
}

describe("SeoCacheService — keyword planner cache keys", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderConfigCache();
  });

  it("embeds the connected planner identity into keyword keys", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
    const keyA = await SeoCacheService.buildKey(keywordIdeasRequest());
    const keyB = await SeoCacheService.buildKey(keywordIdeasRequest());

    expect(keyA).toBe(keyB);
    expect(keyA).toContain("4897513260");
    expect(connectionRepo.getByProjectId).toHaveBeenCalledWith(
      "proj-1",
      "org-1",
    );
  });

  it("keeps connected and unconnected keyword keys disjoint", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
    const connectedKey = await SeoCacheService.buildKey(keywordIdeasRequest());

    connectionRepo.getByProjectId.mockResolvedValue(null);
    const unconnectedKey = await SeoCacheService.buildKey(
      keywordIdeasRequest(),
    );

    expect(connectedKey).not.toBe(unconnectedKey);
  });

  it("keeps unconnected keyword keys stable across calls and projects", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(null);
    const keyA = await SeoCacheService.buildKey(keywordIdeasRequest());
    const keyB = await SeoCacheService.buildKey(
      keywordIdeasRequest({
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
        billingCustomer: {
          organizationId: "org-1",
          projectId: "proj-2",
        } as never,
      }),
    );

    expect(keyA).toBe(keyB);
  });

  it("drops the project scope from keyword_ideas keys within an organization", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
    const projA = await SeoCacheService.buildKey(
      keywordIdeasRequest({ constraints: { source: "ideas", limit: 10 } }),
    );
    const projB = await SeoCacheService.buildKey(
      keywordIdeasRequest({
        constraints: { source: "ideas", limit: 10, projectId: "proj-2" },
      }),
    );

    expect(projA).toBe(projB);
  });

  it("keeps the project scope in keyword_metrics keys (refresh flows)", async () => {
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
    const projA = await SeoCacheService.buildKey(keywordMetricsRequest());
    const projB = await SeoCacheService.buildKey(
      keywordMetricsRequest({
        constraints: { projectId: "proj-2" },
      }),
    );

    expect(projA).not.toBe(projB);
  });

  it("does not consult planner identity for non-keyword data types", async () => {
    await SeoCacheService.buildKey({
      dataType: "serp",
      keyword: "test keyword",
      locationCode: 2840,
      languageCode: "en",
      device: "desktop",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only BillingCustomerContext mock
      billingCustomer: { organizationId: "org-1" } as never,
    });

    expect(connectionRepo.getByProjectId).not.toHaveBeenCalled();
  });
});

describe("SeoCacheService — keyword payload envelope writes", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderConfigCache();
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
  });

  it("wraps keyword writes in the versioned provider envelope", async () => {
    const payload = { keywords: ["email marketing"] };
    const fetchedAt = new Date().toISOString();
    const request = keywordIdeasRequest();
    const key = await SeoCacheService.buildKey(request);

    await SeoCacheService.set(request, key, payload, {
      provider: "google_ads",
      fetchedAt,
    });

    expect(cached.setCached).toHaveBeenCalledWith(
      key,
      {
        seoCacheVersion: KEYWORD_CACHE_VERSION,
        provider: "google_ads",
        fetchedAt,
        data: payload,
      },
      expect.any(Number),
    );
  });

  it("leaves non-keyword writes as plain payloads", async () => {
    const request = {
      ...keywordIdeasRequest(),
      dataType: "serp" as const,
    };
    const key = await SeoCacheService.buildKey(request);
    await SeoCacheService.set(request, key, { items: ["a"] });

    expect(cached.setCached).toHaveBeenCalledWith(
      key,
      { items: ["a"] },
      expect.any(Number),
    );
  });
});

describe("SeoCacheService — keyword envelope reads and freshness", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetProviderConfigCache();
    connectionRepo.getByProjectId.mockResolvedValue(CONNECTED_CONNECTION);
  });

  it("unwraps a valid envelope on hit and surfaces provenance", async () => {
    const fetchedAt = new Date().toISOString();
    cached.getCached.mockResolvedValue(
      envelopeFor({ keywords: ["email marketing"] }, fetchedAt),
    );
    const fetcher = vi.fn(async () => ({ keywords: ["fresh"] }) as never);

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      fetcher,
    );

    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual({ keywords: ["email marketing"] });
    expect(result.cacheProvider).toBe("google_ads");
    expect(result.fetchedAt).toBe(fetchedAt);
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("treats legacy raw payloads as a miss and refetches", async () => {
    cached.getCached.mockResolvedValue({ keywords: ["legacy"] });
    const fetcher = vi.fn(async () => ({ keywords: [] }) as never);

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      fetcher,
    );

    expect(result.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("forces a miss with maxAgeSeconds 0 (explicit refresh)", async () => {
    cached.getCached.mockResolvedValue(
      envelopeFor({ keywords: ["email marketing"] }),
    );
    const fetcher = vi.fn(async () => ({ keywords: [] }) as never);

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      fetcher,
      0,
    );

    expect(result.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("expires envelopes older than maxAgeSeconds", async () => {
    const staleFetchedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    cached.getCached.mockResolvedValue(
      envelopeFor({ keywords: ["email marketing"] }, staleFetchedAt),
    );
    const fetcher = vi.fn(async () => ({ keywords: [] }) as never);

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      fetcher,
      60,
    );

    expect(result.fromCache).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("keeps envelopes fresher than maxAgeSeconds", async () => {
    cached.getCached.mockResolvedValue(
      envelopeFor({ keywords: ["email marketing"] }),
    );
    const fetcher = vi.fn(async () => ({ keywords: [] }) as never);

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      fetcher,
      30 * 24 * 60 * 60,
    );

    expect(result.fromCache).toBe(true);
  });

  it("does not evaluate maxAgeSeconds when caller omits it (TTL policy governs)", async () => {
    const oldFetchedAt = new Date(Date.now() - 10 * 60 * 1000).toISOString();
    cached.getCached.mockResolvedValue(
      envelopeFor({ keywords: ["email marketing"] }, oldFetchedAt),
    );

    const result = await SeoCacheService.getOrFetch(
      keywordIdeasRequest(),
      payloadSchema,
      async () => ({ keywords: [] }) as never,
    );

    expect(result.fromCache).toBe(true);
  });

  it("keeps non-keyword envelope-free round trips", async () => {
    const request = { ...keywordIdeasRequest(), dataType: "serp" as const };
    cached.getCached.mockResolvedValue({ items: ["cached"] });

    const result = await SeoCacheService.getOrFetch(
      request,
      z.object({ items: z.array(z.string()) }),
      async () => ({ items: [] }) as never,
    );

    expect(result.fromCache).toBe(true);
    expect(result.data).toEqual({ items: ["cached"] });
    expect(result.cacheProvider).toBeUndefined();
    expect(result.fetchedAt).toBeUndefined();
  });
});
