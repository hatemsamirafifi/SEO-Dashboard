// Boundary tests for the DataRouter migration: KeywordResearchService must
// never instantiate a DataForSEO client directly; every provider call goes
// through getSeoDataRouter().route (which owns cache + single-flight).
import type { SerpLiveItem } from "@/server/lib/dataforseo";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import type { SEODataRequest } from "@/server/lib/seo-data";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // refresh-metrics only reads keyword/location/language off saved rows.
  type SavedKeywordRowFixture = {
    row: { keyword: string; locationCode: number; languageCode: string };
  };
  return {
    seoDataRouter: {
      route:
        vi.fn<(req: SEODataRequest, schema?: unknown) => Promise<unknown>>(),
    },
    createDataforseoClient: vi.fn(() => {
      throw new Error("service must not create a DataForSEO client directly");
    }),
    repository: {
      upsertKeywordMetric: vi.fn(async () => {}),
      listSavedKeywordsByProject: vi.fn<
        (params: { projectId: string }) => Promise<{
          rows: SavedKeywordRowFixture[];
          totalCount: number;
          tags: never[];
        }>
      >(async () => ({ rows: [], totalCount: 0, tags: [] })),
    },
  };
});

vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => mocks.seoDataRouter,
}));

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: mocks.createDataforseoClient,
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

function routerResponse(dataType: string, data: unknown) {
  return {
    dataType,
    provider: "dataforseo",
    fromCache: false,
    durationMs: 100,
    data,
  };
}

function metricRow(keyword: string, searchVolume: number): KeywordMetricRow {
  return {
    keyword,
    searchVolume,
    cpc: null,
    competition: null,
    competitionLevel: null,
    keywordDifficulty: null,
    intent: null,
    monthlySearches: [{ year: 2026, month: 5, searchVolume }],
  };
}

beforeEach(() => {
  vi.resetModules();
  mocks.seoDataRouter.route.mockReset();
  mocks.createDataforseoClient.mockClear();
  mocks.repository.upsertKeywordMetric.mockClear();
  mocks.repository.listSavedKeywordsByProject.mockReset();
  mocks.repository.listSavedKeywordsByProject.mockResolvedValue({
    rows: [],
    totalCount: 0,
    tags: [],
  });
});

describe("getSerpAnalysis", () => {
  const serpItems = [
    {
      type: "organic",
      rank_group: 1,
      title: "SEO Tools",
      url: "https://example.com/seo-tools",
      domain: "example.com",
      description: "A list of SEO tools",
    },
    { type: "paid", rank_group: 1, title: "Ad", url: "https://ad.example" },
  ] as SerpLiveItem[];

  it("routes serp data through the router and trims to organic items", async () => {
    mocks.seoDataRouter.route.mockResolvedValue(
      routerResponse("serp", serpItems),
    );
    const { getSerpAnalysis } = await import("./serp");

    const result = await getSerpAnalysis(
      {
        projectId: "project_1",
        keyword: " SEO Tools ",
        locationCode: 2840,
        languageCode: "en",
      },
      billingCustomer,
    );

    expect(mocks.seoDataRouter.route).toHaveBeenCalledWith({
      dataType: "serp",
      keyword: "seo tools",
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
    });
    expect(result.requestedKeyword).toBe("seo tools");
    expect(result.items).toHaveLength(1);
    expect(result.items[0]).toMatchObject({
      rank: 1,
      domain: "example.com",
    });
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("flags results with no organic items", async () => {
    mocks.seoDataRouter.route.mockResolvedValue(
      routerResponse("serp", [serpItems[1]]),
    );
    const { getSerpAnalysis } = await import("./serp");

    const result = await getSerpAnalysis(
      {
        projectId: "project_1",
        keyword: "seo tools",
        locationCode: 2840,
        languageCode: "en",
      },
      billingCustomer,
    );

    expect(result.reason).toBe("no_organic_results");
    expect(result.items).toHaveLength(0);
  });
});

describe("refreshSavedKeywordMetrics", () => {
  it("routes metrics through the router and persists rows for the internal provider", async () => {
    mocks.repository.listSavedKeywordsByProject.mockResolvedValue({
      rows: [
        {
          row: {
            keyword: "seo tools",
            locationCode: 2840,
            languageCode: "en",
          },
        },
        {
          row: {
            keyword: "rank tracker",
            locationCode: 2840,
            languageCode: "en",
          },
        },
      ],
      totalCount: 2,
      tags: [],
    });
    mocks.seoDataRouter.route.mockResolvedValue(
      routerResponse("keyword_metrics", [
        metricRow("seo tools", 2400),
        metricRow("rank tracker", 1200),
      ]),
    );
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    const result = await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    expect(mocks.seoDataRouter.route).toHaveBeenCalledWith({
      dataType: "keyword_metrics",
      keywords: ["seo tools", "rank tracker"],
      locationCode: 2840,
      languageCode: "en",
      billingCustomer,
      creditFeature: "keyword_research",
      constraints: { projectId: "project_1" },
    });
    expect(result).toEqual({ updated: 2 });
    expect(mocks.repository.upsertKeywordMetric).toHaveBeenCalledTimes(2);
    expect(mocks.repository.upsertKeywordMetric).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        keyword: "seo tools",
        searchVolume: 2400,
        intent: "unknown",
      }),
    );
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("groups saved keywords by location/language into homogeneous router calls", async () => {
    mocks.repository.listSavedKeywordsByProject.mockResolvedValue({
      rows: [
        {
          row: { keyword: "seo tools", locationCode: 2840, languageCode: "en" },
        },
        {
          row: { keyword: "seo tools", locationCode: 2826, languageCode: "en" },
        },
      ],
      totalCount: 2,
      tags: [],
    });
    mocks.seoDataRouter.route.mockResolvedValue(
      routerResponse("keyword_metrics", [metricRow("seo tools", 2400)]),
    );
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    const locations = mocks.seoDataRouter.route.mock.calls.map(
      ([req]) => req.locationCode,
    );
    expect(locations.toSorted((a, b) => (a ?? 0) - (b ?? 0))).toEqual([
      2826, 2840,
    ]);
  });
});
