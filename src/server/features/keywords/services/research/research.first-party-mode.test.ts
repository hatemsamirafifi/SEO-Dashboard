/* eslint-disable max-lines-per-function -- full harness parity with the service suite */
// First-party keyword research semantics for Google-Ads-served markets:
// diagnostics must report the mode the user actually chose, the DFS
// keyword_ideas fallback is declared as a fallback, and first-party rows
// must not run through the legacy DataForSEO persistence path.
import type { SEODataRequest } from "@/server/lib/seo-data";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  // refresh-metrics only reads keyword/location/language off saved rows.
  type SavedKeywordRowFixture = {
    row: { keyword: string; locationCode: number; languageCode: string };
  };
  return {
    seoDataRouter: {
      route: vi.fn<(req: SEODataRequest) => Promise<unknown>>(),
    },
    repository: {
      upsertKeywordMetric: vi.fn(async () => {}),
      listSavedKeywordsByProject: vi.fn<
        () => Promise<{
          rows: SavedKeywordRowFixture[];
          totalCount: number;
          tags: never[];
        }>
      >(async () => ({ rows: [], totalCount: 0, tags: [] })),
    },
    plannerAccess: {
      getPlannerConnectionForBilling: vi.fn(),
      GOOGLE_ADS_PLANNER_CACHE_CONTRACT: "v26-planner",
    },
    plannerRepo: {
      recordGroupObservation: vi.fn(async () => {}),
    },
  };
});

vi.mock("cloudflare:workers", () => ({
  waitUntil: vi.fn(),
}));

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => mocks.seoDataRouter,
}));

vi.mock(
  "@/server/lib/seo-data/providers/google-ads-planner-access",
  () => mocks.plannerAccess,
);

vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository",
  () => ({
    GoogleAdsPlannerKeywordRepository: mocks.plannerRepo,
  }),
);

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

const icelandInput = {
  projectId: "project_1",
  keywords: ["hotel reykjavik"],
  locationCode: 2352, // Iceland — Labs does not cover it
  languageCode: "is",
  resultLimit: 150 as const,
  mode: "auto" as const,
  clickstream: false,
};

function firstPartyEnvelope(ideas: unknown[]): unknown {
  return {
    source: "google_ads",
    currencyCode: "USD",
    ideas: ideas,
    keywords: [],
    missingKeywords: [],
    malformedKeywords: 0,
    duplicateKeywords: 0,
    truncated: false,
    partial: false,
    fetchedAt: new Date().toISOString(),
  };
}

const flushMicrotasks = () => new Promise((r) => setTimeout(r, 0));

describe("research — Google-Ads-served markets", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.seoDataRouter.route.mockReset();
    mocks.repository.upsertKeywordMetric.mockClear();
  });

  it("reports the user's explicit mode and the DFS fallback honestly", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "dataforseo",
      data: [],
      fromCache: false,
      durationMs: 10,
    });
    const { research } = await import("./research");

    const result = await research(
      { ...icelandInput, mode: "ideas" },
      billingCustomer,
    );

    expect(mocks.seoDataRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: { source: "google_ads", limit: 150 },
      }),
    );
    expect(result.diagnostics.requestedMode).toBe("ideas");
    expect(result.usedFallback).toBe(true);
  });

  it("keeps usedFallback false for the auto waterfall on Google-Ads-served markets", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "dataforseo",
      data: [],
      fromCache: false,
      durationMs: 10,
    });
    const { research } = await import("./research");

    const result = await research(icelandInput, billingCustomer);

    expect(result.diagnostics.requestedMode).toBe("auto");
    expect(result.usedFallback).toBe(false);
  });

  it("drops Labs refinements (clickstream) for Google-Ads-served markets", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "dataforseo",
      data: [],
      fromCache: false,
      durationMs: 10,
    });
    const { research } = await import("./research");

    await research({ ...icelandInput, clickstream: true }, billingCustomer);

    const call = mocks.seoDataRouter.route.mock.calls[0][0];
    expect(call.constraints).toBeDefined();
    expect(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion — the router constraint bag is loosely typed; asserting the Labs-only refinement is absent
      (call.constraints as Record<string, unknown>).includeClickstreamData,
    ).toBeUndefined();
  });

  it("does not persist first-party rows through the legacy DFS upsert path", async () => {
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
          competition: null,
          competitionIndex: null,
          averageCpcMicros: null,
          lowTopOfPageBidMicros: null,
          highTopOfPageBidMicros: null,
        },
      ]),
    });
    const { research } = await import("./research");

    await research(icelandInput, billingCustomer);
    await flushMicrotasks();

    expect(mocks.repository.upsertKeywordMetric).not.toHaveBeenCalled();
  });

  it("persists DFS fallback rows when the google payload is the legacy array shape", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "dataforseo",
      fromCache: false,
      durationMs: 10,
      data: [
        {
          keyword: "hotel reykjavik",
          search_volume: 1300,
          monthly_searches: [{ year: 2026, month: 5, search_volume: 1300 }],
        },
      ],
    });
    const { research } = await import("./research");

    await research(icelandInput, billingCustomer);
    await flushMicrotasks();

    expect(mocks.repository.upsertKeywordMetric).toHaveBeenCalled();
  });
});

function routerResponse(dataType: string, data: unknown) {
  return {
    dataType,
    provider: "dataforseo" as const,
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

describe("refreshSavedKeywordMetrics", () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.seoDataRouter.route.mockReset();
    mocks.repository.upsertKeywordMetric.mockClear();
    mocks.repository.listSavedKeywordsByProject.mockReset();
    mocks.repository.listSavedKeywordsByProject.mockResolvedValue({
      rows: [],
      totalCount: 0,
      tags: [],
    });
    mocks.plannerRepo.recordGroupObservation.mockReset();
    mocks.plannerRepo.recordGroupObservation.mockResolvedValue(undefined);
  });

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
