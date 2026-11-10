import { beforeEach, describe, expect, it, vi } from "vitest";
import type { SEODataRequest } from "@/server/lib/seo-data";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import { SeRankingCreditExhaustedError } from "@/server/lib/seranking/errors";

const mocks = vi.hoisted(() => ({
  seoDataRouter: {
    route: vi.fn<(req: SEODataRequest, schema?: unknown) => Promise<unknown>>(),
  },
  createDataforseoClient: vi.fn(() => {
    throw new Error("DataForSEO client should not be invoked");
  }),
  repository: {
    upsertKeywordMetric: vi.fn(async () => {}),
    listSavedKeywordsByProject: vi.fn(async () => ({ rows: [], totalCount: 0, tags: [] })),
  },
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
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
  organizationId: "org_seranking_test",
  userId: "user_test",
  userEmail: "test@example.com",
};

function makeSeRankingRow(keyword: string, volume: number, difficulty = 30, intent = "commercial") {
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
    vi.resetModules();
    mocks.seoDataRouter.route.mockReset();
    mocks.createDataforseoClient.mockClear();
    mocks.repository.upsertKeywordMetric.mockClear();
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

    const { research } = await import("./research");
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

    const { research } = await import("./research");
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

    const { research } = await import("./research");
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

    const { research } = await import("./research");
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

  // 5. Empty API results handled cleanly
  it("handles empty API results without error", async () => {
    mocks.seoDataRouter.route.mockResolvedValue({
      dataType: "keyword_ideas",
      provider: "seranking",
      fromCache: false,
      durationMs: 50,
      data: [],
    });

    const { research } = await import("./research");
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
    expect(result.diagnostics.sourceAttempts.length).toBe(3); // attempted suggestions, ideas, related
  });

  // 6. Credit exhaustion error handled safely
  it("propagates credit exhaustion error with appropriate code", async () => {
    mocks.seoDataRouter.route.mockRejectedValue(
      new SeRankingCreditExhaustedError("SE Ranking credit limit reached"),
    );

    const { research } = await import("./research");
    await expect(
      research(
        {
          projectId: "proj_credits",
          keywords: ["credits test"],
          locationCode: 2818,
          languageCode: "ar",
          resultLimit: 150,
          mode: "auto",
          clickstream: false,
        },
        billingCustomer,
      ),
    ).rejects.toThrow();
  });

  // 7. Auto mode waterfall continues to next source when one source fails
  it("continues auto waterfall to 'ideas' when 'suggestions' throws ProviderUnavailableError", async () => {
    mocks.seoDataRouter.route
      .mockRejectedValueOnce(
        new ProviderUnavailableError("seranking", "suggestions temporarily unavailable"),
      )
      .mockResolvedValueOnce({
        dataType: "keyword_ideas",
        provider: "seranking",
        fromCache: false,
        durationMs: 100,
        data: [
          makeSeRankingRow("عطور فرنسية", 3000, 40, "commercial"),
          makeSeRankingRow("عطور فرنسية نسائية", 2500, 35, "commercial"),
          makeSeRankingRow("عطور فرنسية رجالية", 2200, 30, "commercial"),
          makeSeRankingRow("افضل عطور فرنسية", 1800, 25, "informational"),
          makeSeRankingRow("ماركات عطور فرنسية", 1400, 22, "commercial"),
          makeSeRankingRow("عطور فرنسية قديمة", 900, 18, "commercial"),
        ],
      });

    const { research } = await import("./research");
    const result = await research(
      {
        projectId: "proj_fallback",
        keywords: ["عطور فرنسية"],
        locationCode: 2818,
        languageCode: "ar",
        resultLimit: 150,
        mode: "auto",
        clickstream: false,
      },
      billingCustomer,
    );

    expect(result.source).toBe("ideas");
    expect(result.rows).toHaveLength(6);
    expect(result.rows[0].keyword).toBe("عطور فرنسية");
    expect(result.rows[0].searchVolume).toBe(3000);
  });

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
      // ideas fails with upstream error
      .mockRejectedValueOnce(
        new ProviderUnavailableError("seranking", "ideas upstream error"),
      )
      // related also fails
      .mockRejectedValueOnce(
        new ProviderUnavailableError("seranking", "related upstream error"),
      );

    const { research } = await import("./research");
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
});
