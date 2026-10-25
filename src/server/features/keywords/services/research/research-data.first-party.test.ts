// The ResearchData consumer accepts BOTH payload shapes from the router:
// the legacy DataForSEO item arrays and the first-party Google Ads planner
// envelope (an object with source "google_ads" plus ideas/keywords arrays).
// This suite pins the discrimination without trusting any third-party type.
import type { SEODataRequest } from "@/server/lib/seo-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seoDataRouter: {
    route: vi.fn<(req: SEODataRequest) => Promise<unknown>>(),
  },
}));

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => mocks.seoDataRouter,
}));

vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
}));

const billingCustomer = {
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "alice@example.com",
};

function firstPartyEnvelope(ideas: unknown[]): unknown {
  return {
    source: "google_ads",
    currencyCode: "USD",
    ideas,
    keywords: [],
    missingKeywords: [],
    malformedKeywords: 0,
    duplicateKeywords: 0,
    truncated: false,
    partial: false,
    fetchedAt: new Date().toISOString(),
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.seoDataRouter.route.mockReset();
});

describe("research-data — first-party payload discrimination", () => {
  it("keeps the DataForSEO array payload on the legacy Ads mapper", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "dataforseo",
      fromCache: false,
      durationMs: 10,
      data: [
        {
          keyword: "Hotel Reykjavik",
          search_volume: 1300,
          competition_index: 42,
          monthly_searches: [{ year: 2026, month: 5, search_volume: 1300 }],
        },
      ],
    });
    const { fetchGoogleAdsResearchRows } = await import("./research-data");

    const { rows } = await fetchGoogleAdsResearchRows(
      {
        seedKeyword: "hotel reykjavik",
        locationCode: 2352,
        languageCode: "is",
        resultLimit: 150,
      },
      billingCustomer,
    );

    expect(rows).toEqual([
      {
        keyword: "hotel reykjavik",
        searchVolume: 1300,
        trend: [{ year: 2026, month: 5, searchVolume: 1300 }],
        cpc: null,
        competition: 0.42,
        keywordDifficulty: null,
        intent: "unknown",
      },
    ]);
  });

  it("maps first-party planner envelopes into research rows", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "google_ads",
      fromCache: false,
      durationMs: 10,
      data: firstPartyEnvelope([
        {
          keyword: "hotel reykjavik",
          closeVariants: [],
          avgMonthlySearches: 1300,
          monthlySearchVolumes: [{ year: 2026, month: 5, volume: 1300 }],
          competition: "HIGH",
          competitionIndex: 42,
          averageCpcMicros: 2540000,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
        },
      ]),
    });
    const { fetchGoogleAdsResearchRows } = await import("./research-data");

    const { rows } = await fetchGoogleAdsResearchRows(
      {
        seedKeyword: "hotel reykjavik",
        locationCode: 2352,
        languageCode: "is",
        resultLimit: 150,
      },
      billingCustomer,
    );

    expect(rows[0]).toMatchObject({
      keyword: "hotel reykjavik",
      searchVolume: 1300,
      cpc: 2.54,
      competition: 0.42,
      keywordDifficulty: null,
      intent: "unknown",
    });
  });

  it("maps first-party envelopes on the Labs 'ideas' mode path too", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "google_ads",
      fromCache: false,
      durationMs: 10,
      data: firstPartyEnvelope([
        {
          keyword: "seo software",
          closeVariants: [],
          avgMonthlySearches: 2400,
          monthlySearchVolumes: [{ year: 2026, month: 5, volume: 2400 }],
          competition: null,
          competitionIndex: null,
          averageCpcMicros: null,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
        },
      ]),
    });
    const { fetchResearchRowsBySource } = await import("./research-data");

    const rows = await fetchResearchRowsBySource(
      {
        seedKeyword: "seo tools",
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        source: "ideas",
      },
      billingCustomer,
    );

    expect(rows[0]).toMatchObject({
      keyword: "seo software",
      searchVolume: 2400,
      keywordDifficulty: null,
      intent: "unknown",
    });
  });
});
