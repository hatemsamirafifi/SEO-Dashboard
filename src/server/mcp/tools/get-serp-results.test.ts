import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ToolExtra } from "@/server/mcp/context";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { SEODataRequest } from "@/server/lib/seo-data";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  route:
    vi.fn<(request: SEODataRequest, schema?: unknown) => Promise<unknown>>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => ({ route: mocks.route }),
}));

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

// oxlint-disable-next-line import/first -- mocks must load before the tool under test
import { getSerpResultsTool } from "./get-serp-results";

const authContext = {
  userId: "user_123",
  userEmail: "alice@example.com",
  organizationId: "org_123",
  clientId: "client_123",
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
    clientId: "client_123",
    scopes: ["mcp"],
    resource: new URL("https://open-seo.test/mcp"),
    extra: { [MCP_AUTH_CONTEXT_PROP]: authContext },
  } satisfies AuthInfo,
};

function serpItems(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    type: "organic",
    rank_absolute: index + 1,
    title: `Result ${index + 1}`,
    url: `https://competitor${index + 1}.com/page`,
    domain: `competitor${index + 1}.com`,
    description: `Description ${index + 1}`,
  }));
}

const SUMMARY = {
  rank: 42,
  backlinks: 1200,
  referring_domains: 320,
  backlinks_spam_score: 5,
};

function routedCalls(): SEODataRequest[] {
  return mocks.route.mock.calls.map(([request]) => request);
}

const resultsSchema = z.object({
  results: z.array(
    z.object({
      ok: z.boolean(),
      items: z.array(z.record(z.string(), z.unknown())).optional(),
    }),
  ),
});

describe("get_serp_results competitive metrics flag (spec 007)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project-1",
      organizationId: "org_123",
      locationCode: 2840,
      languageCode: "en",
      domain: "example.com",
    });
    mocks.route.mockImplementation(async (request: SEODataRequest) => {
      if (request.dataType === "serp") {
        return {
          dataType: "serp",
          provider: "dataforseo",
          data: serpItems(12),
          fromCache: false,
          durationMs: 1,
        };
      }
      const call = request.constraints?.backlinkCall;
      if (call === "domain_pages") {
        return {
          dataType: "competitive_metrics",
          provider: "dataforseo",
          data: { items: [] },
          fromCache: false,
          durationMs: 1,
        };
      }
      return {
        dataType: "competitive_metrics",
        provider: "dataforseo",
        data: SUMMARY,
        fromCache: false,
        durationMs: 1,
      };
    });
  });

  it("defaults the flag off and returns byte-identical responses", async () => {
    const result = await getSerpResultsTool.handler(
      {
        projectId: "project-1",
        queries: [{ keyword: "seo tools" }],
      },
      toolExtra,
    );
    const items =
      resultsSchema.parse(result.structuredContent).results[0]?.items ?? [];
    expect(items).toHaveLength(12);
    // Untoggled items carry exactly the base fields — no metric keys.
    for (const item of items) {
      expect(Object.keys(item).toSorted()).toEqual(
        ["description", "domain", "rank", "title", "type", "url"].toSorted(),
      );
    }
    expect(
      routedCalls().filter((r) => r.dataType === "competitive_metrics"),
    ).toHaveLength(0);
  });

  it("merges Top-10 metrics only when toggled", async () => {
    const result = await getSerpResultsTool.handler(
      {
        projectId: "project-1",
        queries: [{ keyword: "seo tools" }],
        includeCompetitiveMetrics: true,
      },
      toolExtra,
    );
    const items =
      resultsSchema.parse(result.structuredContent).results[0]?.items ?? [];
    expect(items).toHaveLength(12);
    for (const [index, item] of items.entries()) {
      if (index < 10) {
        expect(item["domainRank"]).toBe(42);
        expect(item["metricStatus"]).toBe("partial");
      } else {
        expect(item).not.toHaveProperty("domainRank");
        expect(item).not.toHaveProperty("metricStatus");
      }
    }
    // Bounded: one summary + one domain-pages call per unique domain.
    const enrichmentCalls = routedCalls().filter(
      (r) => r.dataType === "competitive_metrics",
    );
    expect(enrichmentCalls.length).toBeLessThanOrEqual(20);
  });
});
