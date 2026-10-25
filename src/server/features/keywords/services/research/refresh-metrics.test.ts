/* eslint-disable max-lines-per-function -- full harness parity with the service suite */
// First-party refresh flows: when the router serves keyword_metrics from the
// connected Google Ads planner, the envelope is an object with source
// "google_ads" â€” planner rows never fit the legacy DataForSEO-shaped
// `keyword_metrics` table (different competition space, no difficulty or
// intent), so the first-party branch records a normalized planner group
// observation instead and leaves the legacy upsert for DFS rows only.
import type { SEODataRequest } from "@/server/lib/seo-data";
import type { GoogleAdsPlannerObservationInput } from "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository";
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
  plannerAccess: {
    getPlannerConnectionForBilling: vi.fn(),
    GOOGLE_ADS_PLANNER_CACHE_CONTRACT: "v26-planner",
  },
  plannerRepo: {
    recordGroupObservation:
      vi.fn<(input: GoogleAdsPlannerObservationInput) => Promise<void>>(),
  },
}));

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

const savedRow = {
  row: { keyword: "alpha", locationCode: 2840, languageCode: "en" },
};

function firstPartyMetricsEnvelope(
  keywords: unknown[],
): Record<string, unknown> {
  return {
    source: "google_ads",
    currencyCode: "USD",
    network: "GOOGLE_SEARCH_AND_PARTNERS",
    // A fresh envelope carries the Ads identity it was fetched under; no
    // connection lookup is needed to attribute the observation.
    customerId: "1234567890",
    loginCustomerId: "9876543210",
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

describe("refreshSavedKeywordMetrics â€” first-party payload mapping", () => {
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
    mocks.plannerAccess.getPlannerConnectionForBilling.mockReset();
    mocks.plannerRepo.recordGroupObservation.mockReset();
    mocks.plannerRepo.recordGroupObservation.mockResolvedValue(undefined);
  });

  it("records first-party keyword_metrics envelopes as planner observations", async () => {
    const fetchedAt = new Date().toISOString();
    const envelope = firstPartyMetricsEnvelope([
      {
        keyword: "Alpha",
        closeVariants: ["alpha"],
        avgMonthlySearches: 81000,
        monthlySearchVolumes: [{ year: 2026, month: 5, volume: 74000 }],
        competition: "MEDIUM",
        competitionIndex: 52,
        averageCpcMicros: 1250000,
        lowTopOfPageBidMicros: null,
        highTopOfPageBidMicros: null,
      },
    ]);
    envelope.fetchedAt = fetchedAt;
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_metrics",
      provider: "google_ads",
      fromCache: false,
      durationMs: 10,
      data: envelope,
    });
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    const result = await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    expect(result.updated).toBe(1);
    expect(mocks.repository.upsertKeywordMetric).not.toHaveBeenCalled();
    expect(mocks.plannerRepo.recordGroupObservation).toHaveBeenCalledTimes(1);
    const recorded =
      mocks.plannerRepo.recordGroupObservation.mock.calls[0]?.[0];
    expect(recorded?.scope).toEqual({
      projectId: "project_1",
      organizationId: "org_123",
      customerId: "1234567890",
      loginCustomerId: "9876543210",
      currencyCode: "USD",
      locationCode: 2840,
      languageCode: "en",
      network: "GOOGLE_SEARCH_AND_PARTNERS",
      contractVersion: "v26-planner",
    });
    expect(recorded?.dataType).toBe("keyword_metrics");
    expect(recorded?.seedKeyword).toBe("");
    expect(recorded?.sourceFetchedAt).toBe(fetchedAt);
    expect(recorded?.stats).toEqual({
      truncated: false,
      partial: false,
      malformedKeywordCount: 0,
      duplicateKeywordCount: 0,
      missingKeywordCount: 0,
    });
  });

  it("resolves the current connection when a replayed envelope has no Ads identity", async () => {
    mocks.plannerAccess.getPlannerConnectionForBilling.mockResolvedValue({
      customerId: "1234567890",
      loginCustomerId: "9876543210",
      currencyCode: "EUR",
    });
    const envelope = firstPartyMetricsEnvelope([
      {
        keyword: "alpha",
        closeVariants: [],
        avgMonthlySearches: null,
        monthlySearchVolumes: [],
        competition: null,
        competitionIndex: null,
        averageCpcMicros: null,
        lowTopOfPageBidMicros: null,
        highTopOfPageBidMicros: null,
      },
    ]);
    // Simulate a pre-identity cache replay: no customerId attached.
    delete (envelope as { customerId?: string }).customerId;
    delete (envelope as { loginCustomerId?: string }).loginCustomerId;
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_metrics",
      provider: "google_ads",
      fromCache: true,
      durationMs: 10,
      data: envelope,
    });
    const { refreshSavedKeywordMetrics } = await import("./refresh-metrics");

    await refreshSavedKeywordMetrics(
      { projectId: "project_1" },
      billingCustomer,
    );

    expect(mocks.plannerRepo.recordGroupObservation).toHaveBeenCalledTimes(1);
    const recorded =
      mocks.plannerRepo.recordGroupObservation.mock.calls[0]?.[0];
    expect(recorded?.scope).toMatchObject({
      customerId: "1234567890",
      loginCustomerId: "9876543210",
      // The envelope carries the currency; it wins over the fallback
      // connection's EUR.
      currencyCode: "USD",
    });
    expect(
      mocks.plannerAccess.getPlannerConnectionForBilling,
    ).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
    });
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
    expect(mocks.plannerRepo.recordGroupObservation).not.toHaveBeenCalled();
  });
});
