import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

import {
  classifyGoogleAdsError,
  GoogleAdsMalformedResponseError,
  GoogleAdsRequestError,
} from "./googleAdsClient";
import {
  bodyRecord,
  callAt,
  capture,
  createTestClient,
  headersOf,
  ideaRow,
  installFetchMock,
  jsonResponse,
  nonJsonResponse,
  BASE,
  CUSTOMER_ID,
  GEO_US,
  LANGUAGE_EN,
  MANAGER_ID,
} from "./googleAdsPlanner.testFixtures";

/* Phase 2 — Keyword Planner ideas boundary (v26).
 *
 * Contracts pinned to the official v26 reference:
 *  - POST /v26/customers/{customerId}:generateKeywordIdeas
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordIdeasRequest
 *  - KeywordPlanHistoricalMetrics (the metric block, int64 fields)
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordPlanHistoricalMetrics
 */

let fetchMock = installFetchMock();

describe("Google Ads v26 keyword ideas client", () => {
  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    fetchMock = installFetchMock();
  });

  it("generates keyword ideas over the v26 generateKeywordIdeas REST contract", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [ideaRow("running shoes")] }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes"],
      geoTargetConstants: [GEO_US],
      language: LANGUAGE_EN,
      currencyCode: "EUR",
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const { url, init } = callAt(fetchMock, 0);
    expect(url).toBe(`${BASE}/customers/${CUSTOMER_ID}:generateKeywordIdeas`);
    expect(init).toMatchObject({ method: "POST" });
    expect(headersOf(init)).toMatchObject({
      authorization: "Bearer test-token",
    });
    expect(headersOf(init)["developer-token"]).toBeUndefined();

    const body = bodyRecord(init);
    // Planner paging has its own contract: a bounded pageSize plus pageToken
    // and a totalSize. It is NOT the Search endpoint, whose pageSize is
    // rejected with PAGE_SIZE_NOT_SUPPORTED.
    expect(body.pageSize).toBe(100);
    expect(body).not.toHaveProperty("pageToken");
    expect(body.keywordSeed).toEqual({ keywords: ["running shoes"] });
    expect(body.geoTargetConstants).toEqual([GEO_US]);
    expect(body.language).toBe(LANGUAGE_EN);
    // averageCpcMicros is only returned when the request asks for it.
    expect(body.historicalMetricsOptions).toEqual({ includeAverageCpc: true });

    expect(result.ideas).toHaveLength(1);
    expect(result.source).toBe("google_ads");
    expect(result.currencyCode).toBe("EUR");
    expect(result.partial).toBe(false);
    expect(result.truncated).toBe(false);
    expect(result.malformedIdeas).toBe(0);
    expect(Number.isNaN(Date.parse(result.fetchedAt))).toBe(false);
  });

  it("keeps the non-USD account currency explicit and never defaults to USD", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [ideaRow("running shoes")] }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes"],
      currencyCode: "eur",
    });
    // The micros belong to the selected account's currency; the client
    // carries it through instead of assuming USD.
    expect(result.currencyCode).toBe("EUR");
    expect(result.ideas[0].averageCpcMicros).toBe(1_250_000);
  });

  it("omits the currency when the caller supplies none instead of assuming USD", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [ideaRow("running shoes")] }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes"],
    });
    expect(result.currencyCode).toBeNull();
  });

  it("sends a URL seed, a keyword seed and a combined keyword+URL seed", async () => {
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }))
      .mockResolvedValueOnce(jsonResponse({ results: [] }));
    const ads = createTestClient();
    await ads.generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      url: "https://example.com/cars",
    });
    await ads.generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["cars"],
    });
    await ads.generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["cars"],
      url: "https://example.com/cars",
    });

    expect(bodyRecord(callAt(fetchMock, 0).init).urlSeed).toEqual({
      url: "https://example.com/cars",
    });
    expect(bodyRecord(callAt(fetchMock, 0).init)).not.toHaveProperty(
      "keywordSeed",
    );
    expect(bodyRecord(callAt(fetchMock, 1).init).keywordSeed).toEqual({
      keywords: ["cars"],
    });
    expect(bodyRecord(callAt(fetchMock, 1).init)).not.toHaveProperty("urlSeed");
    expect(bodyRecord(callAt(fetchMock, 2).init).keywordAndUrlSeed).toEqual({
      keywords: ["cars"],
      url: "https://example.com/cars",
    });
  });

  it("rejects invalid seeds and limits before any token is minted or fetch is made", async () => {
    const ads = createTestClient();
    const invalid: Array<Record<string, unknown>> = [
      { keywords: [] },
      { keywords: Array.from({ length: 21 }, (_, i) => `kw ${i}`) },
      { keywords: ["ok"], url: "not a url at all" },
      {
        keywords: ["ok"],
        geoTargetConstants: Array.from(
          { length: 11 },
          (_, i) => `geoTargetConstants/${i}`,
        ),
      },
      { keywords: ["ok"], geoTargetConstants: ["not-a-geo-target"] },
      { keywords: ["ok"], language: "en" },
      { keywords: ["ok"], pageSize: 0 },
      { keywords: ["ok"], pageSize: 10_001 },
      { keywords: ["ok"], maxResults: 0 },
      { keywords: ["ok"], maxPages: 0 },
      { keywords: ["ok"], maxPages: 11 },
      { keywords: ["ok"], currencyCode: "EURO" },
    ];
    for (const input of invalid) {
      const thrown = await capture(
        ads.generateKeywordIdeas({
          customerId: CUSTOMER_ID,
          ...input,
        } as Parameters<typeof ads.generateKeywordIdeas>[0]),
      );
      expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    }
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("sends the login-customer-id header when the planner call runs through a manager", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ results: [] }));
    await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed"],
      loginCustomerId: MANAGER_ID,
    });
    expect(headersOf(callAt(fetchMock, 0).init)["login-customer-id"]).toBe(
      MANAGER_ID,
    );
  });

  it("rejects a malformed planner payload without leaking the raw body", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(() =>
          Promise.resolve(nonJsonResponse("SECRET-RAW-PAYLOAD")),
        ),
    );
    const thrown = await capture(
      createTestClient().generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsMalformedResponseError);
    expect(String(thrown)).not.toContain("SECRET");
    expect(classifyGoogleAdsError(thrown).message).not.toContain("SECRET");
  });
});
