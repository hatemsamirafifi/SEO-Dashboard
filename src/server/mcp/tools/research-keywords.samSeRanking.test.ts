import { describe, expect, it, vi, beforeEach } from "vitest";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type * as SerankingModule from "@/server/lib/seranking";
import { researchKeywordsTool } from "./research-keywords";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  resolveEffectiveSeRankingConfig: vi.fn(),
  getSimilarKeywords: vi.fn(),
  getRelatedKeywords: vi.fn(async () => []),
  getLongTailKeywords: vi.fn(async () => []),
  upsertKeywordMetric: vi.fn(async () => {}),
  reserveCredits: vi.fn(async () => ({
    commit: vi.fn(async () => {}),
    release: vi.fn(async () => {}),
  })),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));

vi.mock("@/server/lib/r2-cache", () => ({
  buildCacheKey: vi.fn(
    async (prefix: string, params: Record<string, unknown>) =>
      `${prefix}:${JSON.stringify(params)}`,
  ),
  getCached: vi.fn(async () => null),
  setCached: vi.fn(async () => {}),
  CACHE_TTL: { researchResult: 86400 },
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

vi.mock("@/server/features/settings/services/SeRankingSettingsService", () => ({
  resolveEffectiveSeRankingConfig: mocks.resolveEffectiveSeRankingConfig,
}));

vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: mocks.upsertKeywordMetric,
      listSavedKeywordsByProject: vi.fn(async () => ({
        rows: [],
        totalCount: 0,
        tags: [],
      })),
    },
  }),
);

vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<typeof SerankingModule>();
  return {
    ...actual,
    createSeRankingClient: vi.fn(() => ({})),
    getSimilarKeywords: mocks.getSimilarKeywords,
    getRelatedKeywords: mocks.getRelatedKeywords,
    getLongTailKeywords: mocks.getLongTailKeywords,
    reserveSeRankingCredits: mocks.reserveCredits,
  };
});

const authContext = {
  userId: "user_123",
  userEmail: "sam@example.com",
  organizationId: "org_123",
  clientId: "client_sam",
  scopes: ["mcp"],
  audience: "https://open-seo.test/mcp",
  subject: "user_123",
  baseUrl: "https://open-seo.test",
};

const toolExtra: ToolExtra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: {
    token: "token",
    clientId: "client_sam",
    scopes: ["mcp"],
    resource: new URL("https://open-seo.test/mcp"),
    extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
  } satisfies AuthInfo,
};

describe("SAM Integration: research_keywords Tool with SE Ranking", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.SERANKING_ENABLED = "true";
    process.env.DATAFORSEO_ENABLED = "false"; // Verify DataForSEO is disabled

    mocks.getProjectForOrganization.mockResolvedValue({
      id: "proj_sam_eg",
      organizationId: "org_123",
      locationCode: 2818, // Egypt
      languageCode: "ar",
      domain: "perfumes.eg",
    });

    mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
      provider: "seranking",
      configured: true,
      enabled: true,
      apiKey: "test-seranking-key",
      baseUrl: "https://api.seranking.com",
      circuitBreakerEnabled: true,
      maxRetries: 2,
      source: "organization",
      priority: 1,
    });
  });

  it("executes SAM -> Tool -> Service -> Data Router -> SE Ranking -> SAM Structured Response for Arabic keyword in Egypt", async () => {
    mocks.getSimilarKeywords.mockResolvedValueOnce([
      {
        keyword: "عطور رجالية",
        volume: 2400,
        cpc: 0.85,
        difficulty: 32,
        competition: 0.65,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 2400 }],
      },
      {
        keyword: "عطور رجالية صيفية",
        volume: 1200,
        cpc: 0.75,
        difficulty: 25,
        competition: 0.5,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 1200 }],
      },
      {
        keyword: "عطور رجالية شتوية",
        volume: 950,
        cpc: 0.6,
        difficulty: 22,
        competition: 0.45,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 950 }],
      },
      {
        keyword: "افضل عطور رجالية",
        volume: 1800,
        cpc: 0.9,
        difficulty: 28,
        competition: 0.55,
        intent: "informational",
        history_trend: [{ date: "2026-01-01", volume: 1800 }],
      },
      {
        keyword: "عطور رجالية فخمة",
        volume: 1500,
        cpc: 1.1,
        difficulty: 35,
        competition: 0.7,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 1500 }],
      },
      {
        keyword: "عطور رجالية ثبات وفوحان",
        volume: 1100,
        cpc: 0.8,
        difficulty: 26,
        competition: 0.52,
        intent: "commercial",
        history_trend: [{ date: "2026-01-01", volume: 1100 }],
      },
    ]);

    const response = await researchKeywordsTool.handler(
      {
        projectId: "proj_sam_eg",
        seeds: [
          { seed: "عطور رجالية", locationCode: 2818, languageCode: "ar" },
        ],
        resultLimit: 150,
      },
      toolExtra,
    );

    // 1. Verify SAM receives valid structuredContent
    expect(response).toBeDefined();
    expect(response.structuredContent).toBeDefined();
    const results = (
      response.structuredContent as { results: Array<Record<string, unknown>> }
    ).results;
    expect(results).toHaveLength(1);

    const firstSeedResult = results[0];
    if (!firstSeedResult.ok) {
      console.error("SAM error result:", firstSeedResult);
    }
    expect(firstSeedResult.seed).toBe("عطور رجالية");
    expect(firstSeedResult.ok).toBe(true);
    expect(firstSeedResult.source).toBe("suggestions");
    expect(firstSeedResult.usedFallback).toBe(false);

    // 2. Verify rows and metrics populated accurately
    const rows = firstSeedResult.rows as Array<{
      keyword: string;
      searchVolume: number;
      keywordDifficulty: number;
      cpc: number;
      competition: number;
      intent: string;
    }>;
    expect(rows.length).toBeGreaterThanOrEqual(6);
    expect(rows[0]).toMatchObject({
      keyword: "عطور رجالية",
      searchVolume: 2400,
      keywordDifficulty: 32,
      cpc: 0.85,
      intent: "commercial",
    });

    // 3. Verify SE Ranking client called with source=eg and Arabic keyword
    expect(mocks.getSimilarKeywords).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        keyword: "عطور رجالية",
        source: "eg",
        limit: 150,
      }),
    );

    // 4. Verify text content table formatting
    const textContent =
      response.content?.find((c) => c.type === "text")?.text ?? "";
    expect(textContent).toContain("عطور رجالية");
    expect(textContent).toContain("2400");
    expect(textContent).toContain("commercial");
  });
});
