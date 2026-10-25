import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  collectPaidSearch: vi.fn(),
  getProjectForOrganization: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));
vi.mock("@/server/features/reports/services/reportSections", () => ({
  collectPaidSearch: mocks.collectPaidSearch,
}));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));

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

const availableTotals = {
  status: { available: true, reason: null },
  currencyCode: "USD",
  metricDateBasis: "month",
  totals: {
    impressions: 40000,
    clicks: 2000,
    cost: 150,
    conversions: 30,
    conversionsValue: 900,
    ctr: 0.05,
    cpc: 0.075,
    cpa: 5,
    roas: 6,
  },
  previousTotals: {
    impressions: 38000,
    clicks: 2100,
    cost: 140,
    conversions: 28,
    conversionsValue: 850,
    ctr: 0.055,
    cpc: 0.067,
    cpa: 5,
    roas: 6.1,
  },
  deltas: [],
  campaigns: [
    {
      campaignResourceId: "111",
      name: "Brand",
      status: "ENABLED",
      totals: {
        impressions: 30000,
        clicks: 1500,
        cost: 120,
        conversions: 20,
        conversionsValue: 600,
        ctr: 0.05,
        cpc: 0.08,
        cpa: 6,
        roas: 5,
      },
    },
  ],
  searchTerms: [
    {
      searchText: "seo tool",
      totals: {
        impressions: 10000,
        clicks: 500,
        cost: 60,
        conversions: 10,
        conversionsValue: 300,
        ctr: 0.05,
        cpc: 0.12,
        cpa: 6,
        roas: 5,
      },
    },
  ],
};

function textOf(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content: unknown = Reflect.get(result, "content");
  if (!Array.isArray(content) || content.length === 0) return "";
  const first: unknown = content[0];
  if (
    typeof first !== "object" ||
    first === null ||
    Reflect.get(first, "type") !== "text"
  ) {
    return "";
  }
  const text: unknown = Reflect.get(first, "text");
  return typeof text === "string" ? text : "";
}

describe("get_google_ads_overview", () => {
  beforeEach(() => {
    mocks.collectPaidSearch.mockReset();
    mocks.getProjectForOrganization.mockReset();
    mocks.getProjectForOrganization.mockResolvedValue({
      id: "project_1",
      locationCode: 2840,
      languageCode: "en",
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-25T12:00:00.000Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("summarizes totals, comparisons, and top rows when Ads data exists", async () => {
    mocks.collectPaidSearch.mockResolvedValue(availableTotals);
    const { getGoogleAdsOverviewTool } = await import("./google-ads-tools");
    const result = await getGoogleAdsOverviewTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    // Default window: 28 days ending yesterday UTC.
    expect(mocks.collectPaidSearch).toHaveBeenCalledWith(
      "project_1",
      "org_123",
      "2026-09-27",
      "2026-10-24",
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      currencyCode: "USD",
      totals: { cost: 150 },
      previousTotals: { cost: 140 },
    });
    const text = textOf(result);
    expect(text).toContain("Google Ads · 2026-09-27→2026-10-24 · currency USD");
    expect(text).toContain("Previous window:");
    expect(text).toContain("Top campaigns by cost:");
    expect(text).toContain("Top search terms by cost:");
    expect(text).toContain("Brand");
    expect(text).toContain("seo tool");
  });

  it("caps the requested window length at 90 days", async () => {
    mocks.collectPaidSearch.mockResolvedValue(availableTotals);
    const { getGoogleAdsOverviewTool } = await import("./google-ads-tools");
    await getGoogleAdsOverviewTool.handler(
      { projectId: "project_1", days: 90 },
      toolExtra,
    );
    expect(mocks.collectPaidSearch).toHaveBeenCalledWith(
      "project_1",
      "org_123",
      "2026-07-27",
      "2026-10-24",
    );
  });

  it("stays available-ok with a connect URL when Ads is not connected", async () => {
    mocks.collectPaidSearch.mockResolvedValue({
      status: { available: false, reason: "not_connected" },
      currencyCode: null,
      metricDateBasis: null,
      totals: null,
      previousTotals: null,
      deltas: [],
      campaigns: [],
      searchTerms: [],
    });
    const { getGoogleAdsOverviewTool } = await import("./google-ads-tools");
    const result = await getGoogleAdsOverviewTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(result.structuredContent).toMatchObject({
      ok: true,
      reason: "not_connected",
      connectUrl: "https://open-seo.test/p/project_1/settings",
    });
    expect(textOf(result)).toContain("not_connected");
    expect(textOf(result)).toContain("Connect it here");
  });

  it("reports a covered-empty window instead of zeros", async () => {
    mocks.collectPaidSearch.mockResolvedValue({
      ...availableTotals,
      totals: null,
      previousTotals: null,
      campaigns: [],
      searchTerms: [],
    });
    const { getGoogleAdsOverviewTool } = await import("./google-ads-tools");
    const result = await getGoogleAdsOverviewTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(result.structuredContent).toMatchObject({ ok: true, totals: null });
    expect(textOf(result)).toContain("no paid search data");
  });
});
