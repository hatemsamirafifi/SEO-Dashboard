import { beforeEach, describe, expect, it, vi } from "vitest";

const auth = vi.hoisted(() => ({ getAccessToken: vi.fn() }));
vi.mock("@/lib/auth", () => ({
  getAuth: () => ({ api: { getAccessToken: auth.getAccessToken } }),
}));

import {
  bodyRecord,
  callAt,
  createTestClient,
  ideaRow,
  installFetchMock,
  jsonResponse,
  CUSTOMER_ID,
} from "./googleAdsPlanner.testFixtures";

/* Phase 2 — Planner metric semantics (v26). The metric block is
 * KeywordPlanHistoricalMetrics:
 * https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordPlanHistoricalMetrics
 */

let fetchMock = installFetchMock();

describe("Google Ads v26 planner metric normalization", () => {
  beforeEach(() => {
    auth.getAccessToken.mockResolvedValue({ accessToken: "test-token" });
    fetchMock = installFetchMock();
  });

  it("normalizes the canonical keyword, close-variant membership and every metric", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [ideaRow("running shoes", {}, ["running shoes", "run shoes"])],
      }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["running shoes"],
    });
    const idea = result.ideas[0];
    expect(idea.keyword).toBe("running shoes");
    expect(idea.closeVariants).toEqual(["running shoes", "run shoes"]);
    expect(idea.avgMonthlySearches).toBe(81_000);
    expect(idea.competition).toBe("MEDIUM");
    expect(idea.competitionIndex).toBe(52);
    expect(idea.averageCpcMicros).toBe(1_250_000);
    // The bid range is NOT a CPC: the three money values stay distinct.
    expect(idea.lowTopOfPageBidMicros).toBe(880_000);
    expect(idea.highTopOfPageBidMicros).toBe(2_400_000);
    expect(idea.averageCpcMicros).not.toBe(idea.lowTopOfPageBidMicros);
    expect(idea.averageCpcMicros).not.toBe(idea.highTopOfPageBidMicros);
    expect(idea.monthlySearchVolumes).toEqual([
      { year: 2026, month: 9, volume: 74_000 },
      { year: 2026, month: 10, volume: 91_000 },
    ]);
  });

  it("distinguishes a real zero from an absent metric", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          ideaRow("zero volume", { avgMonthlySearches: "0" }),
          {
            text: "no metrics",
            closeVariants: [],
            keywordIdeaMetrics: { avgMonthlySearches: undefined },
          },
        ],
      }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["zero volume", "no metrics"],
    });
    expect(result.ideas[0].avgMonthlySearches).toBe(0);
    expect(result.ideas[1].avgMonthlySearches).toBeNull();
    expect(result.ideas[1].averageCpcMicros).toBeNull();
    expect(result.ideas[1].lowTopOfPageBidMicros).toBeNull();
    expect(result.ideas[1].highTopOfPageBidMicros).toBeNull();
    expect(result.ideas[1].monthlySearchVolumes).toEqual([]);
  });

  it("keeps an unavailable monthly volume null instead of zero", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          {
            text: "partial months",
            closeVariants: [],
            keywordIdeaMetrics: {
              monthlySearchVolumes: [
                { year: "2026", month: "AUGUST", monthlySearches: "1200" },
                { year: "2026", month: "SEPTEMBER" },
              ],
            },
          },
        ],
      }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["partial months"],
    });
    expect(result.ideas[0].monthlySearchVolumes).toEqual([
      { year: 2026, month: 8, volume: 1_200 },
      { year: 2026, month: 9, volume: null },
    ]);
  });

  it("reports the total result count and stops at the requested result ceiling", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [ideaRow("one"), ideaRow("two")],
        totalSize: "4321",
        nextPageToken: "tok-2",
      }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed"],
      maxResults: 1,
    });
    expect(result.totalResults).toBe(4_321);
    expect(result.ideas).toHaveLength(1);
    expect(result.truncated).toBe(true);
    expect(result.partial).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("follows Planner page tokens and stops on a repeated token", async () => {
    fetchMock
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("one")], nextPageToken: "tok-2" }),
      )
      .mockResolvedValueOnce(
        jsonResponse({ results: [ideaRow("two")], nextPageToken: "tok-2" }),
      );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed"],
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(bodyRecord(callAt(fetchMock, 1).init).pageToken).toBe("tok-2");
    // The request fields must match across pages.
    expect(bodyRecord(callAt(fetchMock, 1).init).keywordSeed).toEqual(
      bodyRecord(callAt(fetchMock, 0).init).keywordSeed,
    );
    expect(bodyRecord(callAt(fetchMock, 1).init).pageSize).toBe(
      bodyRecord(callAt(fetchMock, 0).init).pageSize,
    );
    expect(result.ideas).toHaveLength(2);
    expect(result.truncated).toBe(true);
  });

  it("bounds the number of Planner pages it will fetch", async () => {
    fetchMock.mockImplementation(() =>
      Promise.resolve(
        jsonResponse({
          results: [ideaRow("loop")],
          nextPageToken: `tok-${fetchMock.mock.calls.length}`,
        }),
      ),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed"],
      maxPages: 2,
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.truncated).toBe(true);
    expect(result.partial).toBe(true);
  });

  it("counts malformed idea rows and reports the result as partial", async () => {
    fetchMock.mockResolvedValueOnce(
      jsonResponse({
        results: [
          ideaRow("good"),
          {
            text: "bad metrics",
            keywordIdeaMetrics: { avgMonthlySearches: "not-a-number" },
          },
          { closeVariants: [] },
        ],
      }),
    );
    const result = await createTestClient().generateKeywordIdeas({
      customerId: CUSTOMER_ID,
      keywords: ["seed"],
    });
    expect(result.ideas).toHaveLength(1);
    expect(result.malformedIdeas).toBe(2);
    expect(result.truncated).toBe(false);
    expect(result.partial).toBe(true);
  });
});
