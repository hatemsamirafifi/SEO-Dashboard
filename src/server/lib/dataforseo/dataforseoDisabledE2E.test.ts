/* eslint-disable */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getSeoDataRouter, resetSeoDataRouter } from "@/server/lib/seo-data";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { McpToolAuthContext, ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";
import type * as SeoDataConfig from "@/server/lib/seo-data/config";

import type * as R2Cache from "@/server/lib/r2-cache";

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
    buildCacheKey: vi.fn(async () => "cache-key-" + Math.random()),
    getCached: vi.fn(async () => null),
    setCached: vi.fn(async () => {}),
  };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: vi.fn(async () => ({
      id: "proj-dfs-disabled",
      organizationId: "org-dfs-disabled",
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
    if (key === "SERANKING_API_KEY") return "mock-seranking-token-dfs-disabled";
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
    getProjectProviderSettingsRow: vi.fn(async (projectId: string, provider: string) => {
      if (provider === "dataforseo") {
        return {
          provider: "dataforseo",
          enabled: true, // DB row has enabled=true, but DATAFORSEO_ENABLED=false kill switch must override!
          circuitBreakerEnabled: true,
          maxRetries: 2,
          credentialsCiphertext: "mock-dfs-cipher",
          priority: 2,
        };
      }
      return null;
    }),
    getOrganizationProviderSettingsRow: vi.fn(async () => null),
  },
}));

vi.mock("@/server/features/keywords/repositories/KeywordResearchRepository", () => ({
  KeywordResearchRepository: {
    upsertKeywordMetric: vi.fn(async () => {}),
  },
}));

vi.mock("@/server/features/settings/dataforseoCrypto", () => ({
  decryptDataforseoCredentials: vi.fn(async () => ({
    login: "test-dfs-login",
    password: "test-dfs-password",
  })),
}));

import { buildSamMcpTools } from "@/server/features/sam/samChatTools";
import {
  searchLocalBusinessesTool,
  getLocalSerpResultsTool,
  getGoogleBusinessQuestionsTool,
} from "@/server/mcp/tools/dataforseo-research-tools";
import { getBrandLookup } from "@/server/features/ai-search/services/brandLookup";
import { explorePrompt } from "@/server/features/ai-search/services/promptExplorer";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";

describe("DataForSEO Independence End-to-End (Priority 5)", () => {
  const originalFetch = globalThis.fetch;
  let fetchUrls: string[] = [];

  const customer: BillingCustomerContext = {
    organizationId: "org-dfs-disabled",
    projectId: "proj-dfs-disabled",
    userId: "user-1",
    userEmail: "test@example.com",
  };

  const authContext: McpToolAuthContext = {
    userId: "user-1",
    userEmail: "test@example.com",
    organizationId: "org-dfs-disabled",
    role: "owner",
    clientId: "sam-client",
    scopes: ["mcp", "read", "write"],
    audience: "openseo",
    subject: "user-1",
    baseUrl: "https://open-seo.test",
  };

  const dummyExtra: ToolExtra = {
    authInfo: {
      clientId: "sam-client",
      scopes: ["mcp", "read", "write"],
      token: "test-token",
      extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
    },
    signal: new AbortController().signal,
    requestId: 1,
    sendNotification: vi.fn(),
    sendRequest: vi.fn(),
  };

  const project = {
    id: "proj-dfs-disabled",
    domain: "example.com",
  };

  beforeEach(() => {
    resetSeoDataRouter();
    vi.clearAllMocks();
    fetchUrls = [];

    globalThis.fetch = vi.fn().mockImplementation((url: string | URL) => {
      const u = String(url);
      fetchUrls.push(u);

      if (u.includes("dataforseo.com")) {
        throw new Error(`CRITICAL INVARIANT VIOLATION: HTTP request made to DataForSEO: ${u}`);
      }

      // Mock SE Ranking responses
      if (u.includes("/account/subscription")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ status: "active", units_left: 50000, units_limit: 100000 }),
        });
      }

      if (u.includes("/v1/domain/overview/db")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              organic: {
                base_domain: "example.com",
                target: "example.com",
                keywords_count: 5000,
                traffic_sum: 20000,
                price_sum: 5000,
              },
            }),
        });
      }

      if (u.includes("/v1/keywords/similar") || u.includes("/v1/keywords/related")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve([
              {
                keyword: "seo audit tools",
                volume: 2400,
                cpc: 3.2,
                competition: 0.4,
                difficulty: 30,
              },
            ]),
        });
      }

      if (u.includes("/v1/backlinks/summary")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () =>
            Promise.resolve({
              target: "example.com",
              total_backlinks: 15000,
              referring_domains: 400,
              domain_inlink_rank: 45,
            }),
        });
      }

      if (u.includes("/v1/backlinks/history")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve([]),
        });
      }

      if (u.includes("/v1/backlinks/refdomains")) {
        return Promise.resolve({
          ok: true,
          headers: new Headers({ "content-type": "application/json" }),
          json: () => Promise.resolve({ total: 400, items: [] }),
        });
      }

      return Promise.reject(new Error(`Unexpected fetch URL: ${u}`));
    });
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    resetSeoDataRouter();
  });

  it("1. resolveEffectiveDataforseoConfig enforces kill switch and disables provider despite DB row", async () => {
    const config = await resolveEffectiveDataforseoConfig({
      organizationId: customer.organizationId,
      projectId: customer.projectId,
    });
    expect(config.enabled).toBe(false);
  });

  it("2. SEO Data Router routes domain_overview to SE Ranking without calling DataForSEO", async () => {
    const router = getSeoDataRouter();
    const result = await router.route(
      {
        dataType: "domain_overview",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        billingCustomer: customer,
      },
      undefined,
    );

    expect(result.data).toBeDefined();
    expect(fetchUrls.some((u) => u.includes("dataforseo.com"))).toBe(false);
    expect(fetchUrls.some((u) => u.includes("seranking.com"))).toBe(true);
  });

  it("3. SAM research_keywords runs via SE Ranking without calling DataForSEO", async () => {
    const tools = buildSamMcpTools(authContext, project);
    const result = (await tools.research_keywords.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { seeds: [{ seed: "seo audit tools", locationCode: 2840, languageCode: "en" }] } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_dfs_1" } as any,
    )) as { summary?: string; data?: { results?: Array<{ ok: boolean }> } };

    expect(result.data?.results?.[0]?.ok).toBe(true);
    expect(fetchUrls.some((u) => u.includes("dataforseo.com"))).toBe(false);
  });

  it("4. SAM get_backlinks_overview runs via SE Ranking without calling DataForSEO", async () => {
    const tools = buildSamMcpTools(authContext, project);
    const result = (await tools.get_backlinks_overview.execute!(
      // oxlint-disable-next-line typescript/no-explicit-any
      { target: "example.com" } as any,
      // oxlint-disable-next-line typescript/no-explicit-any
      { messages: [], toolCallId: "call_dfs_2" } as any,
    )) as { summary?: string; data?: { overview?: { overview?: { summary?: { backlinks?: number } } } } };

    expect(result.data?.overview?.overview?.summary?.backlinks).toBe(15000);
    expect(fetchUrls.some((u) => u.includes("dataforseo.com"))).toBe(false);
  });

  it("5. DataForSEO-exclusive MCP tools return clean unavailable state without making network requests", async () => {
    const localRes = await searchLocalBusinessesTool.handler(
      {
        projectId: "proj-dfs-disabled",
        near: { latitude: 40.7128, longitude: -74.006, radiusKm: 10 },
      },
      dummyExtra,
    );
    expect(localRes.structuredContent).toMatchObject({
      unavailable: true,
      reason: "dataforseo_disabled",
    });

    const serpRes = await getLocalSerpResultsTool.handler(
      {
        projectId: "proj-dfs-disabled",
        keyword: "plumber",
        near: { latitude: 40.7128, longitude: -74.006 },
      },
      dummyExtra,
    );
    expect(serpRes.structuredContent).toMatchObject({
      unavailable: true,
      reason: "dataforseo_disabled",
    });

    const questionsRes = await getGoogleBusinessQuestionsTool.handler(
      {
        projectId: "proj-dfs-disabled",
        keyword: "plumber",
        near: { latitude: 40.7128, longitude: -74.006, radiusKm: 10 },
      },
      dummyExtra,
    );
    expect(questionsRes.structuredContent).toMatchObject({
      unavailable: true,
      reason: "dataforseo_disabled",
    });

    expect(fetchUrls.some((u) => u.includes("dataforseo.com"))).toBe(false);
  });

  it("6. AI Search operations throw ProviderUnavailableError without making network requests", async () => {
    await expect(
      getBrandLookup(
        {
          projectId: "proj-dfs-disabled",
          query: "example.com",
          locationCode: 2840,
          languageCode: "en",
          competitors: [],
        },
        customer,
      ),
    ).rejects.toThrow(ProviderUnavailableError);

    await expect(
      explorePrompt(
        {
          projectId: "proj-dfs-disabled",
          prompt: "What is modern SEO?",
          models: ["chat_gpt"],
          webSearch: false,
        },
        customer,
      ),
    ).rejects.toThrow(ProviderUnavailableError);

    expect(fetchUrls.some((u) => u.includes("dataforseo.com"))).toBe(false);
  });
});
