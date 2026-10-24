import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

import {
  classifyGoogleAdsError,
  GoogleAdsRequestError,
} from "./googleAdsClient";
import {
  adsErrorResponse,
  bodyRecord,
  capture,
  createTestClient,
  historicalRow,
  installFetchMock,
  jsonResponse,
  BASE,
  CUSTOMER_ID,
  GEO_US,
  LANGUAGE_EN,
} from "./googleAdsPlanner.testFixtures";

/* Phase 2 — Keyword Planner historical metrics and error classification.
 *
 * Contracts pinned to the official v26 reference:
 *  - POST /v26/customers/{customerId}:generateKeywordHistoricalMetrics
 *    https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordHistoricalMetricsRequest
 *  - Access levels (Explorer access excludes KeywordPlanIdeaService)
 *    https://developers.google.com/google-ads/api/docs/api-policy/access-levels
 */

let fetchMock = installFetchMock();

describe("Google Ads v26 historical metrics client", () => {
  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    fetchMock = installFetchMock();
  });

  it("requests historical metrics with the keyword array and average CPC enabled", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          historicalRow("running shoes", {}, ["running shoes", "run shoes"]),
        ],
      }),
    );
    const result = await createTestClient().generateKeywordHistoricalMetrics({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes", "run shoes"],
      geoTargetConstants: [GEO_US],
      language: LANGUAGE_EN,
      currencyCode: "GBP",
    });

    const { url, init } = callAtFetch();
    expect(url).toBe(
      `${BASE}/customers/${CUSTOMER_ID}:generateKeywordHistoricalMetrics`,
    );
    expect(init).toMatchObject({ method: "POST" });
    const body = bodyRecord(init);
    expect(body.keywords).toEqual(["running shoes", "run shoes"]);
    expect(body.historicalMetricsOptions).toEqual({ includeAverageCpc: true });
    expect(body.geoTargetConstants).toEqual([GEO_US]);
    expect(body.language).toBe(LANGUAGE_EN);
    // The historical-metrics contract has no paging at all: no pageSize and
    // no pageToken are ever sent.
    expect(body).not.toHaveProperty("pageSize");
    expect(body).not.toHaveProperty("pageToken");

    expect(result.keywords).toHaveLength(1);
    expect(result.keywords[0].keyword).toBe("running shoes");
    expect(result.keywords[0].averageCpcMicros).toBe(1_250_000);
    expect(result.currencyCode).toBe("GBP");
    expect(result.source).toBe("google_ads");
    expect(result.partial).toBe(false);
    expect(result.truncated).toBe(false);
  });

  it("keeps grouped close variants as one historical result with membership", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          historicalRow("car", {}, ["car", "cars"]),
          historicalRow("truck", {}, ["truck", "trucks"]),
        ],
      }),
    );
    const result = await createTestClient().generateKeywordHistoricalMetrics({
      customerId: CUSTOMER_ID,
      keywords: ["car", "cars", "truck", "trucks"],
    });
    // Two groups, four requested keywords: the grouped metrics are never
    // presented as four independent keywords.
    expect(result.keywords).toHaveLength(2);
    expect(result.keywords[0]).toMatchObject({
      keyword: "car",
      closeVariants: ["car", "cars"],
    });
    expect(result.keywords[1]).toMatchObject({
      keyword: "truck",
      closeVariants: ["truck", "trucks"],
    });
    expect(result.missingKeywords).toEqual([]);
  });

  it("reports requested keywords Google returned no row for as missing, not as zero", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({ results: [historicalRow("car", {}, ["car"])] }),
    );
    const result = await createTestClient().generateKeywordHistoricalMetrics({
      customerId: CUSTOMER_ID,
      keywords: ["car", "quantum widget"],
    });
    expect(result.keywords).toHaveLength(1);
    expect(result.missingKeywords).toEqual(["quantum widget"]);
    expect(result.partial).toBe(true);
  });

  it("rejects more than 10,000 historical keywords before any fetch", async () => {
    const keywords = Array.from({ length: 10_001 }, (_, i) => `kw ${i}`);
    const thrown = await capture(
      createTestClient().generateKeywordHistoricalMetrics({
        customerId: CUSTOMER_ID,
        keywords,
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(auth.getAccessToken).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects an empty historical keyword list before any fetch", async () => {
    const thrown = await capture(
      createTestClient().generateKeywordHistoricalMetrics({
        customerId: CUSTOMER_ID,
        keywords: [],
      }),
    );
    expect(thrown).toBeInstanceOf(GoogleAdsRequestError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("classifies a documented Cloud service-access denial separately from an expired OAuth token", async () => {
    fetchMock
      .mockResolvedValueOnce(
        adsErrorResponse(403, { authorizationError: "SERVICE_ACCESS_DENIED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(401, { authenticationError: "OAUTH_TOKEN_EXPIRED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(429, { quotaError: "RESOURCE_TEMPORARILY_EXHAUSTED" }),
      )
      .mockResolvedValueOnce(
        adsErrorResponse(429, { quotaError: "RESOURCE_EXHAUSTED" }),
      );
    const ads = createTestClient();

    // Explorer access excludes KeywordPlanIdeaService: the Cloud project is
    // not cleared for the service, which is not an OAuth problem.
    const denied = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    const deniedClass = classifyGoogleAdsError(denied);
    expect(deniedClass.errorClass).toBe("API_ACCESS_RESTRICTED");
    expect(deniedClass.retryable).toBe(false);
    expect(deniedClass.message).not.toContain("Raw upstream");

    const expired = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    const expiredClass = classifyGoogleAdsError(expired);
    expect(expiredClass.errorClass).toBe("OAUTH_TOKEN_INVALID");
    expect(expiredClass.retryable).toBe(false);
    expect(expiredClass.errorClass).not.toBe(deniedClass.errorClass);

    const temporary = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    expect(classifyGoogleAdsError(temporary)).toMatchObject({
      errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
      retryable: true,
    });

    const exhausted = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    expect(classifyGoogleAdsError(exhausted)).toMatchObject({
      errorClass: "QUOTA_EXHAUSTED",
      retryable: false,
    });
  });

  it("classifies the documented Cloud access denials apart from OAuth failures", async () => {
    const cloudDenials: Array<Record<string, string>> = [
      { authorizationError: "PROJECT_DISABLED" },
      { authorizationError: "CLOUD_PROJECT_NOT_UNDER_ORGANIZATION" },
      { authorizationError: "INCOMPLETE_SIGNUP" },
      { authorizationError: "MISSING_TOS" },
      { authenticationError: "ORGANIZATION_NOT_APPROVED" },
      { authenticationError: "ORGANIZATION_NOT_RECOGNIZED" },
    ];
    const ads = createTestClient();
    for (const errorCode of cloudDenials) {
      fetchMock.mockResolvedValueOnce(adsErrorResponse(403, errorCode));
      const thrown = await capture(
        ads.generateKeywordIdeas({
          customerId: CUSTOMER_ID,
          keywords: ["seed"],
        }),
      );
      const classified = classifyGoogleAdsError(thrown);
      expect(classified.errorClass).toBe("API_ACCESS_RESTRICTED");
      expect(classified.retryable).toBe(false);
      expect(classified.errorClass).not.toBe("OAUTH_TOKEN_INVALID");
    }
  });

  it("separates a short-term quota burst from a persistent quota exhaustion", async () => {
    const ads = createTestClient();
    fetchMock.mockResolvedValueOnce(
      adsErrorResponse(429, {
        quotaError: "EXCESSIVE_SHORT_TERM_QUERY_RESOURCE_CONSUMPTION",
      }),
    );
    const burst = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    expect(classifyGoogleAdsError(burst)).toMatchObject({
      errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
      retryable: true,
    });

    fetchMock.mockResolvedValueOnce(
      adsErrorResponse(429, {
        quotaError: "EXCESSIVE_LONG_TERM_QUERY_RESOURCE_CONSUMPTION",
      }),
    );
    const persistent = await capture(
      ads.generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    expect(classifyGoogleAdsError(persistent)).toMatchObject({
      errorClass: "QUOTA_EXHAUSTED",
      retryable: false,
    });
  });

  it("does not claim a known expired or revoked cause for a generic token-mint failure", async () => {
    auth.getAccessToken.mockRejectedValueOnce(new Error("upstream detail"));
    const thrown = await capture(
      createTestClient().generateKeywordIdeas({
        customerId: CUSTOMER_ID,
        keywords: ["seed"],
      }),
    );
    const classified = classifyGoogleAdsError(thrown);
    expect(classified.errorClass).toBe("OAUTH_TOKEN_FAILURE");
    expect(classified.retryable).toBe(false);
    expect(classified.message).not.toContain("upstream detail");
    expect(classified.message).not.toMatch(/expired or revoked/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

/** Typed view of the single recorded fetch call. */
function callAtFetch(): { url: string; init: RequestInit | undefined } {
  const call = fetchMock.mock.calls[0];
  if (!call) throw new Error("expected a fetch call");
  const [input, init] = call;
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  return { url, init };
}
