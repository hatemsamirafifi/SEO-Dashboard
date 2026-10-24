/* eslint-disable max-lines-per-function -- full harness parity with the service suite */
// First-party refresh flows: when the router serves keyword_metrics from the
// connected Google Ads planner, the envelope is an object with source
// "google_ads" — it must be mapped into legacy KeywordMetricRow upserts so
// saved-keyword refresh keeps working. The DFS array shape stays intact.
import type { SEODataRequest } from "@/server/lib/seo-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seoDataRouter: {
    route: vi.fn<(req: SEODataRequest) => Promise<unknown>>(),
  },
  repository: {
    upsertKeywordMetric: vi.fn(async () => {}),
    listSavedKeywordsByProject: vi.fn<
      () => Promise<{
        rows: Array<{
          row: {
            keyword: string;
            locationCode: number;
            languageCode: string;
          };
        }>;
        totalCount: number;
        tags: never[];
      }>
    >(async () => ({ rows: [], totalCount: 0, tags: [] })),
  },
}));

vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => mocks.seoDataRouter,
}));

vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: mocks.repository,
  }),
);

const billingCustomer = {
  organizationId: "org_123",
  userId: "user_123",
  userEmail: "alice@example.com",
};

const savedRow = {
  row: { keyword: "alpha", locationCode: 2840, languageCode: "en" },
};

function firstPartyMetricsEnvelope(keywords: unknown[]): unknown {
  return {
    source: "google_ads",
    currencyCode: "USD",
    ideas: [],
    keywords,
    missingKeywords: [],
    malformedKeywords: 0,
    duplicateKeywords: 0,
    truncated: false,
    partial: false,
    fetchedAt: new Date().toISOString(),
  };
}

describe("refreshSavedKeywordMetrics — first-party payload mapping", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.seoDataRouter.route.mockReset();
    mocks.repository.upsertKeywordMetric.mockClear();
    mocks.repository.listSavedKeywordsByProject.mockReset();
    mocks.repository.listSavedKeywordsByProject.mockResolvedValue({
      rows: [savedRow],
      totalCount: 1,
      tags: [],
    });
  });

  it("maps first-party keyword_metrics envelopes into saved-keyword upserts", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_metrics",
      provider: "google_ads",
      fromCache: false,
      durationMs: 10,
      data: firstPartyMetricsEnvelope([
        {
          keyword: "Alpha",
          closeVariants: [],
          avgMonthlySearches: 81000,
          monthlySearchVolumes: [{ year: 2026, month: 5, volume: 74000 }],
          competition: "MEDIUM",
          competitionIndex: 52,
          averageCpcMicros: 1250000,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
        },
      ]),
    });
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    const result = await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    expect(result.updated).toBe(1);
    expect(mocks.repository.upsertKeywordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        keyword: "alpha",
        searchVolume: 81000,
        cpc: 1.25,
        competition: 0.52,
        keywordDifficulty: null,
        intent: "unknown",
        monthlySearchesJson: JSON.stringify([
          { year: 2026, month: 5, searchVolume: 74000 },
        ]),
      }),
    );
  });

  it("keeps the legacy DataForSEO array payload working", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_metrics",
      provider: "dataforseo",
      fromCache: false,
      durationMs: 10,
      data: [
        {
          keyword: "alpha",
          searchVolume: 1200,
          cpc: 0.9,
          competition: 0.3,
          competitionLevel: "LOW",
          keywordDifficulty: 15,
          intent: "informational",
          monthlySearches: [{ year: 2026, month: 5, searchVolume: 1200 }],
        },
      ],
    });
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    expect(mocks.repository.upsertKeywordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        keyword: "alpha",
        searchVolume: 1200,
        keywordDifficulty: 15,
        intent: "informational",
      }),
    );
  });
});
