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
  },
}));

vi.mock("@/server/features/dashboard/repositories/BacklinkSnapshotRepository", () => ({
  BacklinkSnapshotRepository: {
    getFreshForProjectDomain: vi.fn(async () => null),
    getLatestForProject: vi.fn(async () => null),
    insert: vi.fn(async () => {}),
  },
}));

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
      id: "proj-sam-1",
      organizationId: "org-sam-1",
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
    if (key === "SERANKING_API_KEY") return "mock-seranking-token-xyz";
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

vi.mock("@/server/features/settings/repositories/SeoProviderSettingsRepository", () => ({
  SeoProviderSettingsRepository: {
    getProjectProviderSettingsRow: vi.fn(async () => null),
    getOrganizationProviderSettingsRow: vi.fn(async () => null),
  },
}));

vi.mock("@/server/features/keywords/repositories/KeywordResearchRepository", () => ({
  KeywordResearchRepository: {
    upsertKeywordMetric: vi.fn(async () => {}),
  },
}));

import { buildSamMcpTools } from "./samChatTools";
import { resetSeoDataRouter } from "@/server/lib/seo-data";

describe("SAM -> Tool -> Service -> Data Router -> SE Ranking Provider E2E", () => {
  const originalFetch = globalThis.fetch;

  const authContext: McpToolAuthContext = {
    userId: "user-sam-1",
    userEmail: "sam@example.com",
    organizationId: "org-sam-1",
    role: "owner",
    clientId: "sam-client",
    scopes: ["mcp", "read", "write"],
    audience: "openseo",
    subject: "user-sam-1",
    baseUrl: "https://open-seo.test",
  };

  const project = {
    id: "proj-sam-1",
    domain: "example.com",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    resetSeoDataRouter();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it("get_domain_overview routes through SE Ranking and returns normalized SAM result", async () => {
    const mockOverviewResponse = {
      organic: {
        traffic_sum: 25400,
        keywords_count: 850,
        price_sum: 12000,
      },
      adv: {
        traffic_sum: 500,
        keywords_count: 20,
      },
    };

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ status: "active", units_left: 50000, units_limit: 100000 }),
        });
      }
      if (urlStr.includes("/v1/domain/overview/db")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockOverviewResponse),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${urlStr}`));
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools).toHaveProperty("get_domain_overview");

    // SAM calls get_domain_overview without needing projectId (it's bound server-side)
    const result = (await tools.get_domain_overview.execute!(
      { domain: "example.com" },
      { messages: [], toolCallId: "call_1" },
    )) as { summary?: string; data?: unknown };

    // Verify fetch was called with SE Ranking endpoint and auth token
    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.seranking.com/v1/domain/overview/db"),
      expect.objectContaining({
        method: "GET",
        headers: expect.objectContaining({
          Authorization: "Token mock-seranking-token-xyz",
        }),
      }),
    );

    // Verify normalized text returned to SAM
    const textContent = result.summary ?? "";
    expect(textContent).toContain("Domain: example.com");
    expect(textContent).toContain("Organic traffic: 25400");
    expect(textContent).toContain("Organic keywords: 850");

    // Verify data matches normalized SE Ranking metrics
    expect(result.data).toMatchObject({
      domain: "example.com",
      organicTraffic: 25400,
      organicKeywords: 850,
    });
  });

  it("research_keywords routes through SE Ranking and returns bounded related keyword rows", async () => {
    const mockKeywordsResponse = [
      {
        keyword: "seo agency pricing",
        volume: 1200,
        cpc: 4.5,
        competition: 0.65,
        difficulty: 38,
        intent: "commercial",
      },
      {
        keyword: "best seo agency",
        volume: 3400,
        cpc: 8.2,
        competition: 0.85,
        difficulty: 62,
        intent: "commercial",
      },
      {
        keyword: "local seo agency",
        volume: 2100,
        cpc: 5.1,
        competition: 0.7,
        difficulty: 42,
        intent: "commercial",
      },
      {
        keyword: "ecommerce seo agency",
        volume: 1800,
        cpc: 6.3,
        competition: 0.75,
        difficulty: 50,
        intent: "commercial",
      },
      {
        keyword: "top seo agencies",
        volume: 950,
        cpc: 7.0,
        competition: 0.8,
        difficulty: 55,
        intent: "commercial",
      },
      {
        keyword: "seo marketing agency",
        volume: 2900,
        cpc: 9.0,
        competition: 0.88,
        difficulty: 68,
        intent: "commercial",
      },
    ];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL | Request) => {
      const urlStr = url.toString();
      if (urlStr.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ status: "active", units_left: 50000, units_limit: 100000 }),
        });
      }
      if (
        urlStr.includes("/v1/keywords/similar") ||
        urlStr.includes("/v1/keywords/suggestions") ||
        urlStr.includes("/v1/keywords/related")
      ) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve(mockKeywordsResponse),
        });
      }
      return Promise.reject(new Error(`Unhandled mock url: ${urlStr}`));
    });

    const tools = buildSamMcpTools(authContext, project);
    expect(tools).toHaveProperty("research_keywords");

    const result = (await tools.research_keywords.execute!(
      {
        seeds: [{ seed: "seo agency" }],
        resultLimit: 50,
      },
      { messages: [], toolCallId: "call_2" },
    )) as { summary?: string; data?: { results?: Array<{ ok: boolean; rows?: unknown[]; source?: string }> } };

    expect(globalThis.fetch).toHaveBeenCalledWith(
      expect.stringContaining("https://api.seranking.com/v1/keywords/"),
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: "Token mock-seranking-token-xyz",
        }),
      }),
    );

    const textContent = result.summary ?? "";
    expect(textContent).toContain("seo agency pricing");
    expect(textContent).toContain("best seo agency");

    const results = result.data?.results;
    expect(results).toBeDefined();
    expect(results?.[0]?.ok).toBe(true);
    expect(results?.[0]?.rows?.length).toBeGreaterThan(0);
  });
});
