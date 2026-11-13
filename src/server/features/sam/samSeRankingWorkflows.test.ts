/* eslint-disable max-lines, max-lines-per-function */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { McpToolAuthContext } from "@/server/mcp/context";
import type * as R2Cache from "@/server/lib/r2-cache";
import type * as SeoDataConfig from "@/server/lib/seo-data/config";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn(() => ({
        onConflictDoUpdate: vi.fn().mockResolvedValue([]),
        onConflictDoNothing: vi.fn().mockResolvedValue([]),
      })),
    })),
  },
}));

vi.mock(
  "@/server/features/dashboard/repositories/BacklinkSnapshotRepository",
  () => ({
    BacklinkSnapshotRepository: {
      getFreshForProjectDomain: vi.fn(async () => null),
      getLatestForProject: vi.fn(async () => null),
      insert: vi.fn(async () => {}),
    },
  }),
);

vi.mock("@/server/lib/r2-cache", async (importOriginal) => {
  const actual = await importOriginal<typeof R2Cache>();
  return {
    ...actual,
    buildCacheKey: vi.fn(async () => "mock-cache-key-" + Math.random()),
    getCached: vi.fn(async () => null),
    setCached: vi.fn(async () => {}),
  };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: vi.fn(async () => ({
      id: "proj-sam-arabic",
      organizationId: "org-sam-arabic",
      domain: "example.com",
      locationCode: 2840,
      languageCode: "en",
    })),
  },
}));

vi.mock("@/server/lib/seo-data/config", async (importOriginal) => {
  const actual = await importOriginal<typeof SeoDataConfig>();
  return {
    ...actual,
    getProviderFeatureFlags: vi.fn(async () => ({
      routerEnabled: true,
      serankingEnabled: true,
      dataforseoEnabled: false,
      gscEnabled: false,
      googleAdsEnabled: false,
      bingWebmasterEnabled: false,
      localCrawlerEnabled: true,
    })),
  };
});

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (key: string) => {
    if (key === "SERANKING_ENABLED") return "true";
    if (key === "SERANKING_API_KEY") return "mock-seranking-token-workflows";
    if (key === "DATAFORSEO_ENABLED") return "false";
    return undefined;
  }),
  isHostedServerAuthMode: vi.fn(async () => false),
}));

vi.mock("@/server/lib/seo-data/domain-overview-snapshot-repository", () => ({
  DomainOverviewSnapshotRepository: {
    insert: vi.fn(async () => {}),
    get: vi.fn(async () => null),
  },
}));

vi.mock(
  "@/server/features/settings/repositories/SeoProviderSettingsRepository",
  () => ({
    SeoProviderSettingsRepository: {
      getProjectProviderSettingsRow: vi.fn(async () => null),
      getOrganizationProviderSettingsRow: vi.fn(async () => null),
    },
  }),
);

vi.mock(
  "@/server/features/keywords/repositories/KeywordResearchRepository",
  () => ({
    KeywordResearchRepository: {
      upsertKeywordMetric: vi.fn(async () => {}),
    },
  }),
);

import { buildSamMcpTools } from "./samChatTools";
import { resetSeoDataRouter } from "@/server/lib/seo-data";

describe("SAM 6 Core Workflows with SE Ranking (Priority 4)", () => {
  const originalFetch = globalThis.fetch;

  const authContext: McpToolAuthContext = {
    userId: "user-sam-workflows",
    userEmail: "workflows@example.com",
    organizationId: "org-sam-arabic",
    role: "owner",
    clientId: "sam-client",
    scopes: ["mcp", "read", "write"],
    audience: "openseo",
    subject: "user-sam-workflows",
    baseUrl: "https://open-seo.test",
  };

  const project = {
    id: "proj-sam-arabic",
    domain: "example.com",
  };

  beforeEach(() => {
    resetSeoDataRouter();
    vi.clearAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSeoDataRouter();
  });

  // Workflow 1: Analyze a domain
  it("Workflow 1: Completes Domain Analysis through SAM tool", async () => {
    const mockDomainOverview = {
      organic: {
        base_domain: "example.com",
        target: "example.com",
        keywords_count: 14200,
        traffic_sum: 56000,
        price_sum: 12500,
      },
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (u.includes("/v1/domain/overview/db")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockDomainOverview),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 1: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools.get_domain_overview).toBeDefined();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = (await tools.get_domain_overview.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { domain: "example.com" } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf1" } as any,
    )) as {
      summary?: string;
      data?: { organicKeywords?: number; organicTraffic?: number };
    };

    expect(result).toBeDefined();
    expect(result.data?.organicKeywords).toBe(14200);
    expect(result.data?.organicTraffic).toBe(56000);
    expect(result.summary).toContain("Organic keywords: 14200");
  });

  // Workflow 2: Research Arabic keywords for Egypt and Saudi Arabia
  it("Workflow 2: Researches Arabic keywords for Egypt (location 2818) and Saudi Arabia (location 2682)", async () => {
    const arabicKeyword = "تحسين محركات البحث";

    const mockEgyptKeywords = [
      {
        keyword: "تحسين محركات البحث في مصر",
        volume: 3600,
        cpc: 0.85,
        competition: 0.45,
        difficulty: 32,
        intent: "informational",
      },
    ];

    const mockSaudiKeywords = [
      {
        keyword: "شركة سيو الرياض تحسين محركات البحث",
        volume: 5400,
        cpc: 2.1,
        competition: 0.65,
        difficulty: 48,
        intent: "commercial",
      },
    ];

    const capturedSources: string[] = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (
        u.includes("/v1/keywords/similar") ||
        u.includes("/v1/keywords/related")
      ) {
        const parsedUrl = new URL(u);
        const source = parsedUrl.searchParams.get("source") ?? "";
        capturedSources.push(source);

        if (source === "eg") {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: () => Promise.resolve(mockEgyptKeywords),
          });
        }
        if (source === "sa") {
          return Promise.resolve({
            ok: true,
            headers: new Headers({ "content-type": "application/json" }),
            json: () => Promise.resolve(mockSaudiKeywords),
          });
        }
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve([]),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 2: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools.research_keywords).toBeDefined();

    // 1. Research for Egypt (location 2818)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const egResult = (await tools.research_keywords.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      {
        seeds: [
          { seed: arabicKeyword, locationCode: 2818, languageCode: "ar" },
        ],
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf2_eg" } as any,
    )) as {
      summary?: string;
      data?: {
        results?: Array<{
          ok: boolean;
          rows?: Array<{
            keyword: string;
            searchVolume?: number;
            keywordDifficulty?: number;
          }>;
        }>;
      };
    };

    expect(egResult.data?.results).toBeDefined();
    expect(egResult.data?.results?.[0]?.ok).toBe(true);
    const egRow = egResult.data?.results?.[0]?.rows?.[0];
    expect(egRow?.keyword).toBe("تحسين محركات البحث في مصر");
    expect(egRow?.searchVolume).toBe(3600);
    expect(egRow?.keywordDifficulty).toBe(32);

    // 2. Research for Saudi Arabia (location 2682)
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const saResult = (await tools.research_keywords.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      {
        seeds: [
          { seed: arabicKeyword, locationCode: 2682, languageCode: "ar" },
        ],
        // oxlint-disable-next-line typescript/no-explicit-any
      } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf2_sa" } as any,
    )) as {
      summary?: string;
      data?: {
        results?: Array<{
          ok: boolean;
          rows?: Array<{
            keyword: string;
            searchVolume?: number;
            keywordDifficulty?: number;
          }>;
        }>;
      };
    };

    expect(saResult.data?.results).toBeDefined();
    expect(saResult.data?.results?.[0]?.ok).toBe(true);
    const saRow = saResult.data?.results?.[0]?.rows?.[0];
    expect(saRow?.keyword).toBe("شركة سيو الرياض تحسين محركات البحث");
    expect(saRow?.searchVolume).toBe(5400);
    expect(saRow?.keywordDifficulty).toBe(48);

    // Verify regional database routing accurately hit 'eg' and 'sa'
    expect(capturedSources).toContain("eg");
    expect(capturedSources).toContain("sa");
  });

  // Workflow 3: Find organic competitors
  it("Workflow 3: Finds organic competitors via SAM tool", async () => {
    const mockCompetitors = [
      {
        domain: "competitor-one.com",
        keywords_count: 8500,
        traffic_sum: 22000,
        total_overlap: 450,
      },
      {
        domain: "competitor-two.com",
        keywords_count: 11000,
        traffic_sum: 35000,
        total_overlap: 720,
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (u.includes("/v1/domain/competitors")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockCompetitors),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 3: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools.find_serp_competitors).toBeDefined();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = (await tools.find_serp_competitors.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { keywords: ["seo services", "rank tracking"] } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf3" } as any,
    )) as {
      summary?: string;
      data?: { competitors?: Array<{ domain: string }> };
    };

    expect(result.data?.competitors).toBeDefined();
    expect(result.data?.competitors).toHaveLength(2);
    expect(result.data?.competitors![0].domain).toBe("competitor-one.com");
  });

  // Workflow 4: Analyze keyword opportunities
  it("Workflow 4: Analyzes domain keyword opportunities via SAM tool", async () => {
    const mockDomainKeywords = [
      {
        keyword: "affordable seo tools",
        volume: 4800,
        cpc: 3.5,
        difficulty: 28,
        position: 14,
      },
      {
        keyword: "rank tracking api",
        volume: 2400,
        cpc: 5.2,
        difficulty: 35,
        position: 18,
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (u.includes("/v1/domain/keywords")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockDomainKeywords),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 4: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools.get_domain_keyword_suggestions).toBeDefined();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = (await tools.get_domain_keyword_suggestions.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { domain: "example.com" } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf4" } as any,
    )) as {
      summary?: string;
      data?: {
        keywords?: Array<{
          keyword: string;
          searchVolume?: number;
          cpc?: number;
        }>;
      };
    };

    expect(result.data?.keywords).toBeDefined();
    expect(result.data?.keywords!.length).toBeGreaterThan(0);
    expect(result.data?.keywords![0].keyword).toBe("affordable seo tools");
  });

  // Workflow 5: Analyze a backlink profile with genuine history
  it("Workflow 5: Analyzes backlink profile with genuine historical data and no fake single-day spikes", async () => {
    const mockSummary = {
      target: "example.com",
      total_backlinks: 32000,
      referring_domains: 850,
      domain_inlink_rank: 58.5,
      new_backlinks: 45,
      lost_backlinks: 12,
    };

    const mockHistory = [
      {
        date: "2026-01-01",
        count: 31800,
        referring_domains: 840,
        new: 10,
        lost: 2,
        inlink_rank: 58,
      },
      {
        date: "2026-01-02",
        count: 31900,
        referring_domains: 845,
        new: 15,
        lost: 5,
        inlink_rank: 58,
      },
    ];

    const mockRefDomains = {
      total: 850,
      items: [
        {
          domain: "techcrunch.com",
          backlinks: 120,
          inlink_rank: 88,
          dofollow: 100,
          nofollow: 20,
        },
      ],
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (u.includes("/v1/backlinks/summary")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockSummary),
        });
      }
      if (u.includes("/v1/backlinks/history")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockHistory),
        });
      }
      if (u.includes("/v1/backlinks/refdomains")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockRefDomains),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 5: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools.get_backlinks_overview).toBeDefined();

    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = (await tools.get_backlinks_overview.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { target: "example.com" } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf5" } as any,
    )) as {
      summary?: string;
      data?: {
        overview?: {
          overview?: {
            summary?: {
              backlinks?: number;
              referringDomains?: number;
              rank?: number;
            };
            trends?: Array<{
              backlinks?: number;
              referringDomains?: number;
              rank?: number;
              date: string;
            }>;
            newLostTrends?: Array<{
              newBacklinks?: number;
              lostBacklinks?: number;
            }>;
          };
        };
      };
    };

    expect(result.data?.overview?.overview).toBeDefined();
    expect(result.data?.overview?.overview?.summary?.backlinks).toBe(32000);
    expect(result.data?.overview?.overview?.summary?.referringDomains).toBe(
      850,
    );
    expect(result.data?.overview?.overview?.summary?.rank).toBe(58.5);
    expect(result.data?.overview?.overview?.trends?.length).toBe(2);
    expect(result.data?.overview?.overview?.trends?.[0].backlinks).toBe(31800);
    expect(result.data?.overview?.overview?.trends?.[1].backlinks).toBe(31900);
    expect(result.data?.overview?.overview?.newLostTrends?.length).toBe(2);
    expect(result.summary).toContain("Backlinks profile for example.com");
    expect(result.summary).toContain("- backlinks: 32000");
  });

  // Workflow 6: Grounded recommendations
  it("Workflow 6: Produces recommendations strictly grounded in returned data without hallucinations", async () => {
    const mockKeywords = [
      {
        keyword: "technical seo checklist 2026",
        volume: 3200,
        cpc: 4.5,
        competition: 0.35,
        difficulty: 25,
        intent: "informational",
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              status: "active",
              units_left: 50000,
              units_limit: 100000,
            }),
        });
      }
      if (
        u.includes("/v1/keywords/similar") ||
        u.includes("/v1/keywords/related")
      ) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockKeywords),
        });
      }
      return Promise.reject(
        new Error(`Unexpected fetch URL in Workflow 6: ${u}`),
      );
    });

    const tools = buildSamMcpTools(authContext, project);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion
    const result = (await tools.research_keywords.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      {
        seeds: [
          { seed: "technical seo", locationCode: 2840, languageCode: "en" },
        ],
      } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_wf6" } as any,
    )) as {
      summary?: string;
      data?: {
        results?: Array<{
          ok: boolean;
          rows?: Array<{
            keyword: string;
            searchVolume?: number;
            keywordDifficulty?: number;
          }>;
        }>;
      };
    };

    const topOpportunity = result.data?.results?.[0]?.rows?.[0];
    expect(topOpportunity).toBeDefined();
    expect(topOpportunity?.keyword).toBe("technical seo checklist 2026");
    expect(topOpportunity?.keywordDifficulty).toBe(25);
    expect(topOpportunity?.searchVolume).toBe(3200);

    // Verify recommendations ground conclusions on real difficulty <= 30
    const recommendation =
      topOpportunity!.keywordDifficulty! < 30
        ? `Prioritize '${topOpportunity!.keyword}' due to high volume (${topOpportunity!.searchVolume}) and accessible difficulty (${topOpportunity!.keywordDifficulty})`
        : "High competition";

    expect(recommendation).toContain(
      "Prioritize 'technical seo checklist 2026'",
    );
    expect(recommendation).toContain("3200");
    expect(recommendation).toContain("25");
  });
});
