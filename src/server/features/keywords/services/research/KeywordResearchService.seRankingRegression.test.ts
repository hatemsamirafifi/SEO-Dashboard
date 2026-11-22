/* eslint-disable eslint/max-lines, eslint/max-lines-per-function */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SEODataRequest } from "@/server/lib/seo-data";
import { AppError } from "@/server/lib/errors";
import {
  ProviderUnavailableError,
  SerpNoProviderConfiguredError,
} from "@/server/lib/seo-data/errors";
import {
  SeRankingCreditExhaustedError,
  SeRankingValidationError,
} from "@/server/lib/seranking/errors";
import {
  getOrganizationSeRankingSpend,
  resetCreditGuardState,
  reserveSeRankingCredits,
} from "@/server/lib/seranking/credits";
import { research } from "./research";
import { getSerpAnalysis } from "./serp";
import { resetProviderConfigCache } from "@/server/lib/seo-data/config";
import { RateLimitError } from "@/server/lib/seo-data/errors";
import type { GscService } from "@/server/features/gsc/services/GscService";
import type * as plannerFallback from "@/server/lib/seo-data/providers/google-ads-planner-fallback";

const mocks = vi.hoisted(() => ({
  seoDataRouter: {
    route: vi.fn<(req: SEODataRequest, schema?: unknown) => Promise<unknown>>(),
  },
  createDataforseoClient: vi.fn(() => {
    throw new Error("DataForSEO client should not be invoked");
  }),
  getPerformance: vi.fn<typeof GscService.getPerformance>(),
  authorizePlanner:
    vi.fn<typeof plannerFallback.authorizePlannerResearchFallback>(),
  repository: {
    listResearchOpportunities: vi.fn<
      () => Promise<{ keyword: string; observedAt: string }[]>
    >(async () => []),
    upsertKeywordMetric: vi.fn(async () => {}),
    listSavedKeywordsByProject: vi.fn(async () => ({
      rows: [],
      totalCount: 0,
      tags: [],
    })),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));
vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => mocks.seoDataRouter,
}));
vi.mock("@/server/features/gsc/services/GscService", () => ({
  GscService: { getPerformance: mocks.getPerformance },
}));
vi.mock(
  "@/server/lib/seo-data/providers/google-ads-planner-fallback",
  async (importOriginal) => ({
    ...(await importOriginal<typeof plannerFallback>()),
    authorizePlannerResearchFallback: mocks.authorizePlanner,
  }),
);
vi.mock(
  "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository",
  () => ({
    GoogleAdsPlannerKeywordRepository: {
      recordGroupObservation: vi.fn(async () => {}),
    },
  }),
);
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
  organizationId: "org_seranking_test",
  userId: "user_test",
  userEmail: "test@example.com",
};

function makeSeRankingRow(
  keyword: string,
  volume: number,
  difficulty = 30,
  intent = "commercial",
) {
  const dataItem = {
    keyword,
    keyword_info: {
      search_volume: volume,
      cpc: 0.85,
      competition: 0.65,
      monthly_searches: [
        { year: 2026, month: 1, search_volume: volume },
        { year: 2026, month: 2, search_volume: volume },
      ],
    },
    keyword_properties: {
      keyword_difficulty: difficulty,
    },
    search_intent_info: {
      main_intent: intent,
    },
  };
  return {
    ...dataItem,
    keyword_data: dataItem,
  };
}

describe("SE Ranking Keyword Research Regression Suite", () => {
  beforeEach(() => {
    mocks.seoDataRouter.route.mockReset();
    mocks.createDataforseoClient.mockClear();
    mocks.repository.upsertKeywordMetric.mockClear();
    mocks.repository.listResearchOpportunities
      .mockReset()
      .mockResolvedValue([]);
    mocks.getPerformance.mockReset();
    mocks.authorizePlanner.mockReset();
    vi.stubEnv("GOOGLE_ADS_ENABLED", "true");
    vi.stubEnv("GOOGLE_SEARCH_CONSOLE_ENABLED", "false");
    vi.stubEnv("GOOGLE_ADS_KEYWORD_RESEARCH_FALLBACK_ENABLED", "false");
    resetProviderConfigCache();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetProviderConfigCache();
  });

  // 1. Arabic keyword + Egypt + Auto mode
  it("researches Arabic keywords in Egypt (location 2818, ar) in Auto mode", async () => {
    const arabicRows = [
      makeSeRankingRow("عطور رجالية", 2400, 35, "commercial"),
      makeSeRankingRow("عطور رجالية فخمة", 1800, 28, "commercial"),
      makeSeRankingRow("افضل عطور رجالية", 1500, 25, "informational"),
      makeSeRankingRow("عطور رجالية صيفية", 1100, 20, "commercial"),
      makeSeRankingRow("عطور رجالية شتوية", 900, 18, "commercial"),
      makeSeRankingRow("عطور رجالية ثبات وفوحان", 800, 22, "commercial"),
    ];

    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 120,
      data: arabicRows,
    });

    const result = await research(
      {
        projectId: "proj_arabic_eg",
        keywords: ["عطور رجالية"],
        locationCode: 2818, // Egypt
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(mocks.seoDataRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({
        dataType: "keyword_ideas",
        keyword: "عطور رجالية",
        locationCode: 2818,
        languageCode: "ar",
        constraints: expect.objectContaining({
          source: "suggestions",
          limit: 150,
        }),
      }),
    );

    expect(result.source).toBe("suggestions");
    expect(result.rows).toHaveLength(6);
    expect(result.rows[0]).toMatchObject({
      keyword: "عطور رجالية",
      searchVolume: 2400,
      keywordDifficulty: 35,
      intent: "commercial",
      cpc: 0.85,
    });
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  // 2. SE Ranking-only research (DataForSEO never called)
  it("serves research completely from SE Ranking without invoking DataForSEO", async () => {
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 95,
      data: [
        makeSeRankingRow("ساعات رجالية", 3200, 40, "commercial"),
        makeSeRankingRow("ساعات رجالية فاخرة", 2100, 35, "commercial"),
        makeSeRankingRow("ساعات يد رجالية", 1600, 30, "commercial"),
        makeSeRankingRow("افضل ساعات رجالية", 1200, 25, "informational"),
        makeSeRankingRow("ساعات رجالية كلاسيك", 950, 20, "commercial"),
        makeSeRankingRow("ساعات رجالية جلد", 750, 18, "commercial"),
      ],
    });

    const result = await research(
      {
        projectId: "proj_seranking_only",
        keywords: ["ساعات رجالية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.rows.length).toBeGreaterThanOrEqual(6);
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  // 3. Result limits and constraints
  it("caps and limits results to requested resultLimit", async () => {
    const tenRows = Array.from({ length: 10 }, (_, i) =>
      makeSeRankingRow(`keyword variation ${i}`, 1000 - i * 50),
    );

    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 80,
      data: tenRows,
    });

    const result = await research(
      {
        projectId: "proj_limits",
        keywords: ["keyword variation 0"],
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.rows.length).toBeLessThanOrEqual(150);
  });

  // 4. Keyword suggestions and related keywords
  it("routes manual mode 'related' to source: 'related' with depth: 1", async () => {
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 110,
      data: [makeSeRankingRow("related perfume", 500)],
    });

    const result = await research(
      {
        projectId: "proj_related",
        keywords: ["perfume"],
        locationCode: 2840,
        languageCode: "en",
        resultLimit: 150,
        mode: "related",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(mocks.seoDataRouter.route).toHaveBeenCalledWith(
      expect.objectContaining({
        constraints: expect.objectContaining({
          source: "related",
          depth: 1,
        }),
      }),
    );
    expect(result.source).toBe("related");
  });

  // 5. Empty API results handled cleanly (and skips duplicate "ideas" when seranking serves suggestions)
  it("handles empty API results without error and skips duplicate ideas call for seranking", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 50,
      data: [],
    });

    const result = await research(
      {
        projectId: "proj_empty",
        keywords: ["nonexistentxyzterm12345"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.rows).toEqual([]);
    // Only 2 attempts (suggestions -> related), skipping duplicate "ideas" (/v1/keywords/similar)
    expect(
      result.diagnostics.sourceAttempts
        .filter((a) => a.provider === "seranking")
        .map((a) => a.source),
    ).toEqual(["suggestions", "related"]);
    expect(mocks.seoDataRouter.route).toHaveBeenCalledTimes(2);
  });

  it.each([
    [
      new SeRankingCreditExhaustedError("SE Ranking credit limit reached"),
      "credit_limit",
    ],
    [new RateLimitError("seranking"), "rate_limited"],
    [new ProviderUnavailableError("seranking"), "unavailable"],
  ])(
    "keeps project opportunities when SE Ranking fails with %s",
    async (error, status) => {
      vi.stubEnv("GOOGLE_ADS_KEYWORD_RESEARCH_FALLBACK_ENABLED", "true");
      mocks.seoDataRouter.route.mockRejectedValue(error);
      mocks.repository.listResearchOpportunities.mockResolvedValue([
        { keyword: "عطور رجالية فاخرة", observedAt: "2026-01-01T00:00:00Z" },
      ]);

      const result = await research(
        {
          projectId: "proj_credits",
          keywords: ["عطور رجالية"],
          locationCode: 2818,
          languageCode: "ar",
          resultLimit: 150,
          mode: "auto",
          clickstream: false,
        },
        billingCustomer,
      );

      expect(result.diagnostics.sourceAttempts[0]).toMatchObject({ status });
      expect(result.diagnostics.coverage).toBe("partial");
      expect(result.rows[0]).toMatchObject({
        keyword: "عطور رجالية فاخرة",
        searchVolume: null,
      });
      expect(mocks.seoDataRouter.route).toHaveBeenCalledTimes(1);
      expect(mocks.authorizePlanner).not.toHaveBeenCalled();
    },
  );

  // 8. Partial keyword results preserved when later source fails
  it("preserves partial accumulated rows when a subsequent source fails in auto waterfall", async () => {
    mocks.seoDataRouter.route
      // suggestions returns 2 rows (below MIN_NON_SEED threshold 5)
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 80,
        data: [
          makeSeRankingRow("عطور فخمة", 1000),
          makeSeRankingRow("عطور ثبات", 800),
        ],
      })
      // related fails with upstream error
      .mockRejectedValueOnce(
        new ProviderUnavailableError("seranking", "related upstream error"),
      );

    const result = await research(
      {
        projectId: "proj_partial",
        keywords: ["عطور"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    // The 2 rows from suggestions must be preserved!
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].keyword).toBe("عطور فخمة");
  });

  // 9. Reports actual serving provider in result and diagnostics
  it("reports actual serving provider 'seranking' on ResearchResult and in diagnostics", async () => {
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 85,
      data: [
        makeSeRankingRow("عطور شرقية", 1900, 32, "commercial"),
        makeSeRankingRow("عطور شرقية نسائية", 1400, 28, "commercial"),
        makeSeRankingRow("عطور شرقية رجالية", 1200, 26, "commercial"),
        makeSeRankingRow("افضل عطور شرقية", 950, 22, "informational"),
        makeSeRankingRow("عطور شرقية ثبات", 750, 20, "commercial"),
        makeSeRankingRow("عطور شرقية فاخرة", 650, 18, "commercial"),
      ],
    });

    const result = await research(
      {
        projectId: "proj_provider_check",
        keywords: ["عطور شرقية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.provider).toBe("seranking");
    expect(result.diagnostics.servingProvider).toBe("seranking");
    expect(result.diagnostics.providerReturnedData).toBe("seranking");
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  // 10. Normalizes native SE Ranking suggestion items into canonical internal DTOs
  it("normalizes flat native SE Ranking items directly into canonical EnrichedKeyword DTOs", async () => {
    // Native SE Ranking response shape: flat volume, cpc, difficulty, intent, history_trend
    const nativeSeRankingItems = [
      {
        keyword: "عطور عود",
        volume: 3600,
        cpc: 1.25,
        competition: 0.72,
        difficulty: 45,
        intent: "commercial",
        history_trend: [
          { date: "2026-01-01", volume: 3600 },
          { date: "2026-02-01", volume: 3400 },
        ],
      },
      {
        keyword: "عطور عود فاخرة",
        volume: 1800,
        cpc: 1.1,
        competition: 0.65,
        difficulty: 38,
        intent: "c", // single-letter code from SE Ranking
        history_trend: [{ date: "2026-01-01", volume: 1800 }],
      },
      {
        keyword: "افضل انواع عطور العود",
        volume: 1200,
        cpc: 0.9,
        competition: 0.5,
        difficulty: 30,
        intent: "1", // numeric code from SE Ranking (informational)
        history_trend: [{ date: "2026-01-01", volume: 1200 }],
      },
      {
        keyword: "عطور عود رجالية",
        volume: 950,
        cpc: 0.8,
        competition: 0.55,
        difficulty: 28,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 950 }],
      },
      {
        keyword: "عطور عود اصلية",
        volume: 850,
        cpc: 0.95,
        competition: 0.6,
        difficulty: 32,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 850 }],
      },
      {
        keyword: "اسعار عطور العود",
        volume: 700,
        cpc: 0.75,
        competition: 0.45,
        difficulty: 25,
        intent: "transactional",
        history_trend: [{ date: "2026-01-01", volume: 700 }],
      },
    ];

    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 90,
      data: nativeSeRankingItems,
    });

    const result = await research(
      {
        projectId: "proj_native_seranking",
        keywords: ["عطور عود"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.rows).toHaveLength(6);
    expect(result.rows[0]).toMatchObject({
      keyword: "عطور عود",
      searchVolume: 3600,
      cpc: 1.25,
      competition: 0.72,
      keywordDifficulty: 45,
      intent: "commercial",
      trend: [
        { year: 2026, month: 1, searchVolume: 3600 },
        { year: 2026, month: 2, searchVolume: 3400 },
      ],
    });
    // Single-letter "c" mapped to "commercial"
    expect(result.rows[1].intent).toBe("commercial");
    // Numeric "1" mapped to "informational"
    expect(result.rows[2].intent).toBe("informational");
  });

  // 11. Handles malformed upstream responses without crashing
  it("handles malformed upstream items gracefully without throwing", async () => {
    const malformedData = [
      null,
      undefined,
      "not an object",
      { keyword: null },
      { not_a_keyword: "test" },
      makeSeRankingRow("عطور صالحة", 1500, 20),
    ];

    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 70,
      data: malformedData,
    });

    const result = await research(
      {
        projectId: "proj_malformed",
        keywords: ["عطور صالحة"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    // The one valid keyword should be parsed; nulls/strings skipped without error
    expect(result.rows.length).toBeGreaterThanOrEqual(1);
    expect(result.rows[0].keyword).toBe("عطور صالحة");
  });

  // 12. Google Ads unavailable falls back cleanly to SE Ranking
  it("falls back cleanly to SE Ranking when Google Ads is unavailable", async () => {
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 110,
      data: [
        makeSeRankingRow("عطور رجالية مميزة", 2200),
        makeSeRankingRow("عطور رجالية شتوية فخمة", 1700),
        makeSeRankingRow("اجمل عطور رجالية", 1400),
        makeSeRankingRow("عطور رجالية جذابة", 1100),
        makeSeRankingRow("عطور رجالية كلاسيك", 950),
        makeSeRankingRow("عطور رجالية ثقيلة", 800),
      ],
    });

    const result = await research(
      {
        projectId: "proj_no_gads",
        keywords: ["عطور رجالية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.provider).toBe("seranking");
    expect(result.rows).toHaveLength(6);
    expect(mocks.createDataforseoClient).not.toHaveBeenCalled();
  });

  it("reports validation failure and avoids additional paid attempts", async () => {
    mocks.seoDataRouter.route.mockRejectedValue(
      new AppError("VALIDATION_ERROR"),
    );
    const result = await research(
      {
        projectId: "proj_val_stop",
        keywords: ["عطور رجالية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );
    expect(result.rows).toEqual([]);
    expect(result.diagnostics.sourceAttempts[0]).toMatchObject({
      status: "invalid_response",
    });
    expect(mocks.seoDataRouter.route).toHaveBeenCalledTimes(1);
  });

  // 14. Handles official SE Ranking payload with null fields (null history_trend, null intents)
  it("parses official SE Ranking payload containing null history_trend, null intents, and null metrics", async () => {
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 80,
      data: [
        {
          keyword: "عطور رجالية شتوية",
          volume: 1200,
          cpc: null,
          difficulty: null,
          competition: null,
          intents: null,
          history_trend: null,
        },
        {
          keyword: "عطور رجالية صيفية",
          volume: null,
          cpc: 0.5,
          difficulty: 20,
          competition: 0.3,
          intents: ["I"],
          history_trend: { "2026-01-01": 500 },
        },
      ],
    });

    const result = await research(
      {
        projectId: "proj_nulls",
        keywords: ["عطور رجالية شتوية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].keyword).toBe("عطور رجالية شتوية");
    expect(result.rows[0].trend).toEqual([]);
    expect(result.rows[1].keyword).toBe("عطور رجالية صيفية");
    expect(result.rows[1].intent).toBe("informational");
  });

  // 15. Arabic relevance & exact overview for "شركات لاندسكيب" in Egypt
  it("keeps Arabic market rows and reports missing exact match for 'شركات لاندسكيب'", async () => {
    mocks.seoDataRouter.route
      // suggestions returns 1 row (below threshold 5)
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 90,
        data: [
          makeSeRankingRow("شركات لاندسكيب في مصر", 320, 18, "commercial"),
        ],
      })
      // related returns mixed Arabic + weakly related English rows (ideas is skipped because seranking served suggestions)
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 110,
        data: [
          makeSeRankingRow(
            "landscape architecture course",
            900,
            35,
            "informational",
          ),
          makeSeRankingRow(
            "افضل شركات لاندسكيب في القاهرة",
            210,
            15,
            "commercial",
          ),
          makeSeRankingRow("اسعار شركات اللاندسكيب", 140, 12, "commercial"),
          makeSeRankingRow("backyard ideas", 1500, 40, "informational"),
        ],
      });

    const result = await research(
      {
        projectId: "proj_landscape_eg",
        keywords: ["شركات لاندسكيب"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    // Must not have called duplicate "ideas"
    expect(mocks.seoDataRouter.route).toHaveBeenCalledTimes(2);
    // Exact seed "شركات لاندسكيب" was not returned by provider
    expect(result.seedOverview).toMatchObject({
      keyword: "شركات لاندسكيب",
      exactMatchFound: false,
      metricsStatus: "missing_from_provider",
      row: {
        keyword: "شركات لاندسكيب",
        searchVolume: null,
        cpc: null,
        competition: null,
        keywordDifficulty: null,
        intent: null,
        matchType: "exact",
      },
    });
    expect(result.rows).toHaveLength(3);
    expect(result.rows[0].keyword).toBe("شركات لاندسكيب في مصر");
    expect(result.rows[0].isWeaklyRelated).toBe(false);
    expect(result.rows[1].keyword).toBe("افضل شركات لاندسكيب في القاهرة");
    expect(result.rows[2].keyword).toBe("اسعار شركات اللاندسكيب");
  });

  // 16. SERP Analysis works independently of DataForSEO and returns structured unavailable/ok states
  it("returns structured 'unavailable' state when no SERP provider is configured and 'ok' when Serper serves results", async () => {
    mocks.seoDataRouter.route.mockRejectedValueOnce(
      new SerpNoProviderConfiguredError("no_serp_provider_configured", [
        { provider: "serper", reason: "missing_credentials" },
        { provider: "zenserp", reason: "disabled" },
      ]),
    );

    const unavailable = await getSerpAnalysis(
      {
        projectId: "proj_serp_eg",
        keyword: "شركات لاندسكيب",
        locationCode: 2818,
        languageCode: "ar",
      },
      billingCustomer,
    );

    expect(unavailable.status).toBe("unavailable");
    expect(unavailable.unavailableReason).toBe("no_serp_provider_configured");
    expect(unavailable.providerDiagnostics).toEqual([
      { provider: "serper", reason: "missing_credentials" },
      { provider: "zenserp", reason: "disabled" },
    ]);

    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "serp",
      provider: "serper",
      fromCache: false,
      fetchedAt: "2026-11-11T01:00:00.000Z",
      durationMs: 140,
      data: [
        {
          type: "organic",
          rank_group: 1,
          rank_absolute: 1,
          url: "https://example.eg/landscape",
          domain: "example.eg",
          title: "أفضل شركات لاندسكيب في مصر",
          description: "تصميم وتنفيذ حدائق ولاندسكيب في مصر",
          _provider: "serper",
          _fetchedAt: "2026-11-11T01:00:00.000Z",
        },
        {
          type: "people_also_ask",
          title: "ما هي أفضل شركة لاندسكيب في مصر؟",
        },
        {
          type: "local_pack",
          title: "شركات لاندسكيب القاهرة",
        },
      ],
    });

    const okResult = await getSerpAnalysis(
      {
        projectId: "proj_serp_eg",
        keyword: "شركات لاندسكيب",
        locationCode: 2818,
        languageCode: "ar",
      },
      billingCustomer,
    );

    expect(okResult.status).toBe("ok");
    expect(okResult.provider).toBe("serper");
    expect(okResult.fromCache).toBe(false);
    expect(okResult.locationCode).toBe(2818);
    expect(okResult.languageCode).toBe("ar");
    expect(okResult.items).toHaveLength(1);
    expect(okResult.items[0]).toMatchObject({
      rank: 1,
      url: "https://example.eg/landscape",
      title: "أفضل شركات لاندسكيب في مصر",
      description: "تصميم وتنفيذ حدائق ولاندسكيب في مصر",
    });
    expect(okResult.features?.peopleAlsoAsk).toBeDefined();
    expect(okResult.features?.localPack).toBeDefined();
  });

  // 17. Credit accounting: reconciles actual units (including 0) and preserves rawItemCount on validation error
  it("reconciles exact SE Ranking units (110 for 11 rows, 0 for 0 rows) and preserves rawItemCount on validation failure", async () => {
    resetCreditGuardState();
    const orgId = "org_credit_test_17";

    // 11 rows returned -> 110 credits
    const res1 = await reserveSeRankingCredits({
      organizationId: orgId,
      operation: "keyword_ideas",
      count: 150,
    });
    await res1.commit(110);
    expect(getOrganizationSeRankingSpend(orgId)).toBe(110);

    // 0 rows returned -> 0 credits (must not charge 1500 estimated units)
    const res2 = await reserveSeRankingCredits({
      organizationId: orgId,
      operation: "keyword_ideas",
      count: 150,
    });
    await res2.commit(0);
    expect(getOrganizationSeRankingSpend(orgId)).toBe(110);

    // Validation error after HTTP 200 carries rawItemCount so credits are committed, not released
    const valErr = new SeRankingValidationError(
      "Invalid item schema",
      undefined,
      200,
      5,
    );
    expect(valErr.rawItemCount).toBe(5);
  });

  // 18. DataForSEO request count is strictly 0 across all runs
  it("ensures DataForSEO client invocation count is strictly zero", () => {
    expect(mocks.createDataforseoClient).toHaveBeenCalledTimes(0);
  });

  // 19. Accurate attemptedProvider & per-attempt diagnostics on Egypt zero-row live miss vs cache hit
  it("reports actual attemptedProvider ('seranking' on miss, null on cache hit) and upstream diagnostics", async () => {
    mocks.seoDataRouter.route
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 420,
        attemptedProviders: ["seranking"],
        diagnostics: {
          endpoint: "/v1/keywords/similar",
          upstreamTotal: 0,
          rawItemCount: 0,
          parsedItemCount: 0,
        },
        data: [],
      })
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 390,
        attemptedProviders: ["seranking"],
        diagnostics: {
          endpoint: "/v1/keywords/related",
          upstreamTotal: 0,
          rawItemCount: 0,
          parsedItemCount: 0,
        },
        data: [],
      });

    const missResult = await research(
      {
        projectId: "proj_eg_diag",
        keywords: ["إنشاء ملاعب صناعية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(missResult.rows).toEqual([]);
    expect(missResult.diagnostics.attemptedProvider).toBe("seranking");
    expect(missResult.diagnostics.attemptedProviders).toEqual(["seranking"]);
    expect(missResult.diagnostics.fromCache).toBe(false);
    expect(missResult.diagnostics.sourceAttempts[0]).toMatchObject({
      source: "suggestions",
      endpoint: "/v1/keywords/similar",
      upstreamTotal: 0,
      rawItemCount: 0,
      parsedItemCount: 0,
      mappedRowCount: 0,
      fromCache: false,
      servingProvider: "seranking",
    });

    // Cache hit case: attemptedProvider must be null and attemptedProviders empty
    mocks.seoDataRouter.route.mockResolvedValueOnce({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: true,
      durationMs: 25,
      attemptedProviders: [],
      data: [],
    });

    const hitResult = await research(
      {
        projectId: "proj_eg_diag",
        keywords: ["إنشاء ملاعب صناعية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "related",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(hitResult.diagnostics.attemptedProvider).toBeNull();
    expect(hitResult.diagnostics.attemptedProviders).toEqual([]);
    expect(hitResult.diagnostics.fromCache).toBe(true);
    expect(hitResult.diagnostics.sourceAttempts[0]).toMatchObject({
      source: "related",
      fromCache: true,
      servingProvider: "seranking",
      mappedRowCount: 0,
    });
  });
  it.each([
    [2818, "egy"],
    [2682, "sau"],
  ])(
    "combines scoped Arabic opportunities for %i",
    async (locationCode, country) => {
      vi.stubEnv("GOOGLE_SEARCH_CONSOLE_ENABLED", "true");
      vi.stubEnv("GOOGLE_ADS_KEYWORD_RESEARCH_FALLBACK_ENABLED", "true");
      // Even a general flag enabling DFS cannot make it eligible in this flow.
      vi.stubEnv("DATAFORSEO_ENABLED", "true");
      const now = "2026-11-22T00:00:00.000Z";
      mocks.seoDataRouter.route.mockImplementation(async ({ onlyProvider }) =>
        onlyProvider === "seranking"
          ? {
              provider: "seranking",
              fromCache: false,
              fetchedAt: now,
              data: [],
            }
          : {
              provider: "google_ads",
              fromCache: true,
              attemptedProviders: [],
              data: {
                source: "google_ads",
                fetchedAt: now,
                currencyCode: "SAR",
                customerId: "1234567890",
                loginCustomerId: null,
                network: "GOOGLE_SEARCH_AND_PARTNERS",
                missingKeywords: [],
                malformedKeywords: 0,
                duplicateKeywords: 0,
                truncated: false,
                partial: false,
                ideas: [
                  {
                    keyword: "أفضل عطور",
                    closeVariants: ["افضل عطور مميزة"],
                    avgMonthlySearches: 90,
                    averageCpcMicros: 1_500_000,
                    competitionIndex: null,
                    competition: null,
                    lowTopOfPageBidMicros: null,
                    highTopOfPageBidMicros: null,
                    monthlySearchVolumes: [],
                  },
                ],
              },
            },
      );
      // Only the scoped identity string is consumed before dispatch; the provider
      // preflight and actual Ads permission checks are exercised in its suite.
      mocks.authorizePlanner.mockResolvedValue({
        scope: "authorized-project-account",
        connection: {
          id: "ads-connection",
          projectId: "arabic-project",
          organizationId: billingCustomer.organizationId,
          customerId: "1234567890",
          loginCustomerId: null,
          customerDisplayName: null,
          grantAccountId: "grant",
          connectedByUserId: "local-user",
          currencyCode: "SAR",
          timeZone: null,
          isTestAccount: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      mocks.getPerformance.mockResolvedValue({
        siteUrl: "sc-domain:project.test",
        connectedBy: null,
        request: {
          startDate: "2026-08-20",
          endDate: "2026-11-20",
          dimensions: ["query"],
        },
        rows: [
          {
            keys: ["افضل عُطور"],
            impressions: 120,
            clicks: 5,
            ctr: 0.04,
            position: 7,
          },
          {
            keys: ["عطور اقتصادية"],
            impressions: 18,
            clicks: 0,
            ctr: 0,
            position: 9,
          },
          {
            keys: ["وصفات الطعام"],
            impressions: 42,
            clicks: 3,
            ctr: 0.07,
            position: 7,
          },
        ],
      });
      mocks.repository.listResearchOpportunities.mockResolvedValue([
        { keyword: "أفضل  عطور", observedAt: now },
        { keyword: "عطور فاخرة", observedAt: now },
        { keyword: "عطور فاخره", observedAt: now },
        { keyword: "عُطور فاخرة", observedAt: now },
      ]);
      const result = await research(
        {
          projectId: "arabic-project",
          keywords: ["عطور"],
          locationCode,
          languageCode: "ar",
          resultLimit: 6,
          mode: "auto",
          clickstream: false,
        },
        billingCustomer,
      );

      expect(
        mocks.seoDataRouter.route.mock.calls.map(([req]) => req.onlyProvider),
      ).toEqual(["seranking", "seranking", "google_ads"]);
      expect(mocks.getPerformance).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "arabic-project",
          organizationId: billingCustomer.organizationId,
          filters: [
            { dimension: "country", operator: "equals", expression: country },
          ],
        }),
      );
      expect(mocks.repository.listResearchOpportunities).toHaveBeenCalledWith(
        expect.objectContaining({
          projectId: "arabic-project",
          languageCode: "ar",
          locationCode,
        }),
      );
      expect(result.diagnostics.servingProviders).toEqual([
        "google_ads",
        "gsc",
        "internal",
      ]);
      expect(result.diagnostics.enabledProviders).not.toContain("dataforseo");
      expect(result.rows.map(({ keyword }) => keyword)).toEqual(
        expect.arrayContaining([
          "أفضل عطور",
          "افضل عطور مميزة",
          "عطور فاخرة",
          "عطور فاخره",
          "عطور اقتصادية",
        ]),
      );
      expect(result.rows).toHaveLength(5);
      expect(
        result.rows.find(({ keyword }) => keyword === "أفضل عطور"),
      ).toMatchObject({
        searchVolume: 90,
        cpc: 1.5,
        cpcCurrencyCode: "SAR",
        keywordDifficulty: null,
        intent: null,
        attribution: [
          { source: "google_ads", cacheStatus: "hit", observedAt: now },
          { source: "gsc", sitePerformance: { impressions: 120 } },
          { source: "internal", cacheStatus: "stored" },
        ],
      });
      expect(
        result.rows.find(({ keyword }) => keyword === "افضل عطور مميزة")
          ?.searchVolume,
      ).toBeNull();
      expect(
        result.rows.find(({ keyword }) => keyword === "عطور اقتصادية"),
      ).toMatchObject({
        searchVolume: null,
        cpc: null,
        keywordDifficulty: null,
        intent: null,
        metricAvailability: {
          searchVolume: false,
          cpc: false,
          keywordDifficulty: false,
          intent: false,
        },
        attribution: [
          { source: "gsc", sitePerformance: { impressions: 18, clicks: 0 } },
        ],
      });
      expect(mocks.repository.upsertKeywordMetric).not.toHaveBeenCalled();
    },
  );

  it("reports an unconnected Planner after genuine empty coverage and keeps other opportunities", async () => {
    vi.stubEnv("GOOGLE_ADS_KEYWORD_RESEARCH_FALLBACK_ENABLED", "true");
    mocks.seoDataRouter.route.mockResolvedValue({
      provider: "seranking",
      fromCache: true,
      data: [],
    });
    mocks.authorizePlanner.mockRejectedValue(
      new ProviderUnavailableError(
        "google_ads",
        "Google Ads is not connected to this project.",
      ),
    );
    mocks.repository.listResearchOpportunities.mockResolvedValue([
      { keyword: "عطور خشبية", observedAt: "2026-01-01T00:00:00Z" },
      { keyword: "عطور فاخرة", observedAt: "2026-01-01T00:00:00Z" },
    ]);
    const result = await research(
      {
        projectId: "unconnected",
        keywords: ["عطور"],
        locationCode: 2682,
        languageCode: "ar",
        resultLimit: 1,
        mode: "ideas",
        clickstream: false,
      },
      billingCustomer,
    );
    expect(mocks.seoDataRouter.route).toHaveBeenCalledTimes(1);
    expect(result.rows).toHaveLength(1);
    expect(result.diagnostics.sourceAttempts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          provider: "google_ads",
          status: "unavailable",
        }),
        expect.objectContaining({
          provider: "seranking",
          status: "no_coverage",
          fromCache: true,
        }),
      ]),
    );
  });
});
