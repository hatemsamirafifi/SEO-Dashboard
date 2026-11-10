/* eslint-disable max-lines */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  SeRankingClient,
  SeRankingAuthError,
  SeRankingRateLimitError,
  SeRankingCreditExhaustedError,
  SeRankingUpstreamError,
  estimateCreditCost,
  assertBalanceSufficient,
  locationCodeToSeRankingSource,
  countryCodeToSeRankingSource,
  getExportKeywords,
  getSimilarKeywords,
  getDomainOverview,
  getDomainKeywords,
  getBacklinksSummary,
  getReferringDomains,
  getBacklinks,
  getBacklinkPages,
  getLongTailKeywords,
  getBacklinksHistory,
  getDomainAuthorityHistory,
} from "./index";

describe("SeRankingClient", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("throws error when API key is missing or blank", () => {
    expect(() => new SeRankingClient({ apiKey: "" })).toThrow("SE Ranking API key is required");
    expect(() => new SeRankingClient({ apiKey: "   " })).toThrow("SE Ranking API key is required");
  });

  it("sends Authorization: Token header and returns subscription", async () => {
    const mockResponse = {
      status: "active",
      units_limit: 50000,
      units_left: 45000,
      start_date: "2026-01-01",
      expiration_date: "2026-12-31",
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockResponse),
    });

    const client = new SeRankingClient({ apiKey: "test-api-key-123" });
    const sub = await client.getSubscription();

    expect(sub.status).toBe("active");
    expect(sub.units_left).toBe(45000);
    expect(sub.units_limit).toBe(50000);

    expect(globalThis.fetch).toHaveBeenCalledWith(
      "https://api.seranking.com/v1/account/subscription",
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Token test-api-key-123",
          Accept: "application/json",
        }),
      }),
    );
  });

  it("parses exact upstream SE Ranking response with nested subscription_info", async () => {
    const mockResponse = {
      subscription_info: {
        status: "active",
        start_date: "2026-01-18 14:20:02",
        expiration_date: "2026-02-18 14:20:02",
        units_limit: 100000,
        units_left: 100000,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockResponse),
    });

    const client = new SeRankingClient({ apiKey: "test-api-key-123" });
    const sub = await client.getSubscription();

    expect(sub.status).toBe("active");
    expect(sub.units_left).toBe(100000);
    expect(sub.units_limit).toBe(100000);
    expect(sub.start_date).toBe("2026-01-18 14:20:02");
    expect(sub.expiration_date).toBe("2026-02-18 14:20:02");
  });

  it("handles HTTP 401/403 and throws SeRankingAuthError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 401,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ message: "Invalid API key" }),
    });

    const client = new SeRankingClient({ apiKey: "bad-key", maxRetries: 0 });
    await expect(client.getSubscription()).rejects.toThrow(SeRankingAuthError);
  });

  it("handles HTTP 429 and throws SeRankingRateLimitError after retries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ message: "Too many requests" }),
    });

    const client = new SeRankingClient({ apiKey: "key", maxRetries: 1 });
    await expect(client.getSubscription()).rejects.toThrow(SeRankingRateLimitError);
    // 1 initial + 1 retry = 2 attempts
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("handles insufficient funds / credit exhaustion", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 402,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ message: "Insufficient units" }),
    });

    const client = new SeRankingClient({ apiKey: "key", maxRetries: 0 });
    await expect(client.request("/some/path")).rejects.toThrow(SeRankingCreditExhaustedError);
  });

  it("handles HTTP 500 upstream server error after retries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ message: "Internal server error" }),
    });

    const client = new SeRankingClient({ apiKey: "key", maxRetries: 1 });
    await expect(client.request("/some/path")).rejects.toThrow(SeRankingUpstreamError);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it("handles request timeout", async () => {
    globalThis.fetch = vi.fn().mockImplementation((_url, { signal }) => {
      return new Promise((_, reject) => {
        signal.addEventListener("abort", () => {
          const err = new Error("The operation was aborted");
          err.name = "AbortError";
          reject(err);
        });
      });
    });

    const client = new SeRankingClient({ apiKey: "key", timeoutMs: 20, maxRetries: 0 });
    await expect(client.request("/slow/path")).rejects.toThrow(/timed out/);
  });

  it("deduplicates concurrent GET requests", async () => {
    let callCount = 0;
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return {
        ok: true,
        headers: new Headers({ "content-type": "application/json" }),
        json: () => Promise.resolve({ result: "ok" }),
      };
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const [res1, res2] = await Promise.all([
      client.request<{ result: string }>("/dedup/path"),
      client.request<{ result: string }>("/dedup/path"),
    ]);

    expect(res1.result).toBe("ok");
    expect(res2.result).toBe("ok");
    expect(callCount).toBe(1);
  });
});

describe("SE Ranking Keyword Operations", () => {
  it("fetches bulk keyword export metrics", async () => {
    const mockItems = [
      {
        keyword: "seo tools",
        volume: 12000,
        cpc: 4.5,
        competition: 0.8,
        difficulty: 65,
        intent: "commercial",
        history_trend: [{ date: "2026-01", volume: 11000 }],
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockItems),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const items = await getExportKeywords(client, {
      keywords: ["seo tools"],
      source: "us",
    });

    expect(items).toHaveLength(1);
    expect(items[0].keyword).toBe("seo tools");
    expect(items[0].volume).toBe(12000);
    expect(items[0].difficulty).toBe(65);
    expect(items[0].intent).toBe("commercial");
  });

  it("fetches similar keywords", async () => {
    const mockItems = [
      {
        keyword: "best seo software",
        volume: 3500,
        cpc: 3.2,
        competition: 0.6,
        difficulty: 45,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve({ items: mockItems }),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const items = await getSimilarKeywords(client, {
      keyword: "seo software",
      source: "us",
      limit: 10,
    });

    expect(items).toHaveLength(1);
    expect(items[0].keyword).toBe("best seo software");
    expect(items[0].volume).toBe(3500);
  });
});

describe("SE Ranking Domain Operations", () => {
  it("fetches domain overview", async () => {
    const mockOverview = {
      organic: {
        keywords_count: 5400,
        traffic_sum: 25000,
        price_sum: 15000,
      },
      adv: {
        keywords_count: 20,
        traffic_sum: 100,
      },
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockOverview),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const overview = await getDomainOverview(client, {
      domain: "example.com",
      source: "us",
    });

    expect(overview.organic?.keywords_count).toBe(5400);
    expect(overview.organic?.traffic_sum).toBe(25000);
  });

  it("fetches domain keywords", async () => {
    const mockData = {
      total: 100,
      items: [
        {
          keyword: "example keyword",
          position: 3,
          prev_position: 5,
          volume: 2400,
          cpc: 1.5,
          url: "https://example.com/page",
          traffic: 800,
          difficulty: 30,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getDomainKeywords(client, {
      domain: "example.com",
      source: "us",
    });

    expect(result.totalCount).toBe(100);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].keyword).toBe("example keyword");
    expect(result.items[0].position).toBe(3);
  });
});

describe("SE Ranking Backlinks Operations", () => {
  it("fetches backlinks summary", async () => {
    const mockSummary = {
      target: "example.com",
      total_backlinks: 50000,
      referring_domains: 1200,
      dofollow: 40000,
      nofollow: 10000,
      domain_inlink_rank: 55.4,
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockSummary),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const summary = await getBacklinksSummary(client, {
      target: "example.com",
    });

    expect(summary.total_backlinks).toBe(50000);
    expect(summary.referring_domains).toBe(1200);
    expect(summary.domain_inlink_rank).toBe(55.4);
  });

  it("fetches referring domains", async () => {
    const mockData = {
      total: 50,
      items: [
        {
          domain: "referrer.com",
          backlinks: 15,
          inlink_rank: 42,
          dofollow: 12,
          nofollow: 3,
          first_seen: "2025-01-01",
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getReferringDomains(client, {
      target: "example.com",
    });

    expect(result.totalCount).toBe(50);
    expect(result.items).toHaveLength(1);
    expect(result.items[0].domain).toBe("referrer.com");
  });

  it("fetches backlinks calling /v1/backlinks/all", async () => {
    const mockData = {
      total: 1,
      items: [
        {
          source_url: "https://example.com/source",
          target_url: "https://mytarget.com/page",
          anchor: "Click here",
          dofollow: true,
          inlink_rank: 55,
          first_seen: "2026-01-01",
          last_seen: "2026-02-01",
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getBacklinks(client, { target: "mytarget.com" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].source_url).toBe("https://example.com/source");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/backlinks/all"),
      expect.any(Object),
    );
  });

  it("fetches indexed pages calling /v1/backlinks/indexed-pages", async () => {
    const mockData = {
      total: 1,
      items: [
        {
          url: "https://mytarget.com/page-1",
          backlinks: 25,
          referring_domains: 5,
          inlink_rank: 30,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getBacklinkPages(client, { target: "mytarget.com" });

    expect(result.items).toHaveLength(1);
    expect(result.items[0].url).toBe("https://mytarget.com/page-1");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/backlinks/indexed-pages"),
      expect.any(Object),
    );
  });

  it("fetches long-tail keywords calling /v1/keywords/longtail", async () => {
    const mockData = [
      {
        keyword: "best seo agency in new york",
        volume: 2400,
        cpc: 8.5,
        competition: 0.8,
        difficulty: 45,
        intent: "commercial",
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getLongTailKeywords(client, { keyword: "seo agency" });

    expect(result).toHaveLength(1);
    expect(result[0].keyword).toBe("best seo agency in new york");
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/keywords/longtail"),
      expect.any(Object),
    );
  });

  it("fetches historical backlinks calling /v1/backlinks/history/cumulative", async () => {
    const mockData = [
      {
        date: "2026-01-15",
        count: 1450,
        referring_domains: 320,
        new: 12,
        lost: 3,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getBacklinksHistory(client, {
      target: "example.com",
      dateFrom: "2026-01-01",
      dateTo: "2026-01-31",
    });

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-01-15");
    expect(result[0].count).toBe(1450);
    expect(result[0].new).toBe(12);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/backlinks/history/cumulative"),
      expect.any(Object),
    );
  });

  it("fetches domain authority history calling /v1/backlinks/authority/domain/history", async () => {
    const mockData = [
      {
        date: "2026-01-15",
        inlink_rank: 48,
        trust_score: 55,
      },
    ];

    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      headers: new Headers({ "content-type": "application/json" }),
      json: () => Promise.resolve(mockData),
    });

    const client = new SeRankingClient({ apiKey: "key" });
    const result = await getDomainAuthorityHistory(client, {
      target: "example.com",
      granularity: "by_month",
    });

    expect(result).toHaveLength(1);
    expect(result[0].date).toBe("2026-01-15");
    expect(result[0].inlink_rank).toBe(48);
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("/v1/backlinks/authority/domain/history"),
      expect.any(Object),
    );
  });
});

describe("Region and Credit Utilities", () => {
  it("maps location codes and country codes to SE Ranking database source", () => {
    expect(locationCodeToSeRankingSource(2840)).toBe("us");
    expect(locationCodeToSeRankingSource(2826)).toBe("uk");
    expect(countryCodeToSeRankingSource("US")).toBe("us");
    expect(countryCodeToSeRankingSource("GB")).toBe("uk");
    expect(countryCodeToSeRankingSource("DE")).toBe("de");
  });

  it("estimates credit cost accurately", () => {
    expect(estimateCreditCost("account_subscription")).toBe(0);
    expect(estimateCreditCost("keyword_metrics", 50)).toBe(50);
    expect(estimateCreditCost("keyword_ideas", 10)).toBe(100);
    expect(estimateCreditCost("domain_overview")).toBe(100);
    expect(estimateCreditCost("backlinks_summary")).toBe(100);
  });

  it("validates sufficient balance", () => {
    expect(() =>
      assertBalanceSufficient(
        { status: "active", units_limit: 10000, units_left: 500 },
        100,
      ),
    ).not.toThrow();

    expect(() =>
      assertBalanceSufficient(
        { status: "disabled", units_limit: 10000, units_left: 500 },
        100,
      ),
    ).toThrow(SeRankingCreditExhaustedError);

    expect(() =>
      assertBalanceSufficient(
        { status: "active", units_limit: 10000, units_left: 50 },
        100,
      ),
    ).toThrow(SeRankingCreditExhaustedError);
  });
});
