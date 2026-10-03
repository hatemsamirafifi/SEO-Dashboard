import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  normalizeObjectSchema,
  safeParseAsync,
} from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  getOverview: vi.fn(),
  getLandingPages: vi.fn(),
  getAcquisition: vi.fn(),
  getEvents: vi.fn(),
  getConversions: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/ga4/services/AnalyticsService", () => ({
  AnalyticsService: {
    getOverview: mocks.getOverview,
    getLandingPages: mocks.getLandingPages,
    getAcquisition: mocks.getAcquisition,
    getEvents: mocks.getEvents,
    getConversions: mocks.getConversions,
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

function structuredRecord(result: CallToolResult): Record<string, unknown> {
  const content: unknown = result.structuredContent;
  if (typeof content !== "object" || content === null) {
    throw new Error("expected structured content");
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(content)) {
    out[key] = value;
  }
  return out;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value: unknown = record[key];
  if (!Array.isArray(value)) throw new Error(`expected array at ${key}`);
  return value as unknown[];
}

function textOf(result: CallToolResult): string {
  const first: unknown = result.content[0];
  if (typeof first !== "object" || first === null) return "";
  if (!("type" in first) || first.type !== "text") return "";
  if (!("text" in first) || typeof first.text !== "string") return "";
  return first.text;
}

function delta(current: number, previous: number): Record<string, unknown> {
  return { current, previous, change: current - previous, pctChange: 0.1 };
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockReset();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.getOverview.mockReset();
  mocks.getLandingPages.mockReset();
  mocks.getAcquisition.mockReset();
  mocks.getEvents.mockReset();
  mocks.getConversions.mockReset();
});

describe("analytics MCP tools", () => {
  it("get_analytics_overview guides to settings when unconnected", async () => {
    mocks.getOverview.mockResolvedValue({ connected: false });
    const { getAnalyticsOverviewTool } = await import("./analytics-tools");

    const result = await getAnalyticsOverviewTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(false);
    expect(textOf(result)).toContain("not connected");
  });

  it("get_analytics_overview reports current-vs-previous totals", async () => {
    mocks.getOverview.mockResolvedValue({
      connected: true,
      propertyId: "properties/1",
      windows: {
        current: { from: "2026-08-29", to: "2026-09-25" },
        previous: { from: "2026-08-01", to: "2026-08-28" },
      },
      coverage: { status: "complete", coveredDates: 28, totalDates: 28 },
      totals: {
        sessions: delta(1200, 1000),
        engagedSessions: delta(800, 700),
        screenPageViews: delta(3000, 2800),
        eventCount: delta(5000, 4800),
      },
    });
    const { getAnalyticsOverviewTool } = await import("./analytics-tools");

    const result = await getAnalyticsOverviewTool.handler(
      { projectId: "project_1", range: "last_28_days" },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(true);
    expect(mocks.getOverview).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      range: "last_28_days",
    });
  });

  it("get_analytics_overview output schema validates both states", async () => {
    const { getAnalyticsOverviewTool } = await import("./analytics-tools");
    const schema = normalizeObjectSchema(
      getAnalyticsOverviewTool.config.outputSchema,
    );
    if (!schema) throw new Error("output schema did not normalize");
    for (const payload of [
      { connected: false },
      { connected: true, overview: { totals: {} } },
    ]) {
      const result = await safeParseAsync(schema, payload);
      expect(result.success).toBe(true);
    }
  });

  it("get_analytics_landing_pages bounds rows at 50", async () => {
    const rows = Array.from({ length: 60 }, (_, index) => ({
      landingPage: `/p-${index}`,
      sessions: delta(100 + index, 90),
      screenPageViews: delta(200, 180),
    }));
    mocks.getLandingPages.mockResolvedValue({
      connected: true,
      propertyId: "properties/1",
      rows,
    });
    const { getAnalyticsLandingPagesTool } = await import("./analytics-tools");

    const result = await getAnalyticsLandingPagesTool.handler(
      { projectId: "project_1", limit: 50 },
      toolExtra,
    );
    const content = structuredRecord(result);
    expect(content["connected"]).toBe(true);
    expect(arrayField(content, "rows")).toHaveLength(50);
    expect(content["totalCount"]).toBe(60);
  });

  it("get_analytics_acquisition delegates to the service and bounds rows", async () => {
    mocks.getAcquisition.mockResolvedValue({
      connected: true,
      propertyId: "properties/1",
      rows: [
        {
          channelGroup: "Organic Search",
          source: "google",
          medium: "organic",
          isOrganic: true,
          sessions: delta(400, 300),
        },
      ],
    });
    const { getAnalyticsAcquisitionTool } = await import("./analytics-reads-tools");

    const result = await getAnalyticsAcquisitionTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(true);
    expect(mocks.getAcquisition).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      range: "last_28_days",
    });
    expect(textOf(result)).toContain("Organic Search");
  });

  it("get_analytics_acquisition guides to settings when unconnected", async () => {
    mocks.getAcquisition.mockResolvedValue({ connected: false });
    const { getAnalyticsAcquisitionTool } = await import("./analytics-reads-tools");

    const result = await getAnalyticsAcquisitionTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(false);
    expect(textOf(result)).toContain("not connected");
  });

  it("get_analytics_events delegates to the service", async () => {
    mocks.getEvents.mockResolvedValue({
      connected: true,
      propertyId: "properties/1",
      rows: [
        {
          eventName: "signup_completed",
          isKeyEvent: true,
          eventCount: delta(12, 20),
        },
      ],
    });
    const { getAnalyticsEventsTool } = await import("./analytics-reads-tools");

    const result = await getAnalyticsEventsTool.handler(
      { projectId: "project_1", limit: 10 },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(true);
    expect(mocks.getEvents).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      range: "last_28_days",
      limit: 10,
    });
    expect(textOf(result)).toContain("signup_completed");
  });

  it("get_analytics_conversions passes goalId through to the service", async () => {
    mocks.getConversions.mockResolvedValue({
      connected: true,
      propertyId: "properties/1",
      rows: [
        {
          eventName: "signup_completed",
          isKeyEvent: true,
          eventCount: delta(12, 20),
        },
      ],
    });
    const { getAnalyticsConversionsTool } = await import("./analytics-reads-tools");

    const result = await getAnalyticsConversionsTool.handler(
      { projectId: "project_1", goalId: "goal-1" },
      toolExtra,
    );
    expect(structuredRecord(result)["connected"]).toBe(true);
    expect(mocks.getConversions).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        organizationId: "org_123",
        goalId: "goal-1",
      }),
    );
    expect(textOf(result)).toContain("signup_completed");
  });

  it("get_analytics_conversions surfaces invalid-goal failures without fabrication", async () => {
    mocks.getConversions.mockRejectedValue(new Error("NOT_FOUND"));
    const { getAnalyticsConversionsTool } = await import("./analytics-reads-tools");

    await expect(
      getAnalyticsConversionsTool.handler(
        { projectId: "project_1", goalId: "missing-goal" },
        toolExtra,
      ),
    ).rejects.toThrow("NOT_FOUND");
  });
});
