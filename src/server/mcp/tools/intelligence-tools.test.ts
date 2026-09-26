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
  listOpportunities: vi.fn(),
  getOpportunity: vi.fn(),
  updateOpportunityStatus: vi.fn(),
  getDashboardInsights: vi.fn(),
  getByProjectId: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/intelligence/services/OpportunityService", () => ({
  OpportunityService: {
    listOpportunities: mocks.listOpportunities,
    getOpportunity: mocks.getOpportunity,
    updateOpportunityStatus: mocks.updateOpportunityStatus,
  },
}));
vi.mock("@/server/features/intelligence/services/InsightService", () => ({
  InsightService: {
    getDashboardInsights: mocks.getDashboardInsights,
  },
}));
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getByProjectId },
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

function field(record: Record<string, unknown>, key: string): unknown {
  return record[key];
}

function recordOf(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null) {
    throw new Error("expected record");
  }
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

function opportunityRow(id: string): Record<string, unknown> {
  return {
    id,
    projectId: "project_1",
    organizationId: "org_123",
    logicalKey: `low_ctr_query:${id}`,
    occurrenceNumber: 1,
    type: "low_ctr_query",
    detectorKey: "low_ctr_query",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 62,
    confidenceScore: 55,
    priority: "High",
    title: `Fix CTR for ${id}`,
    explanationFact: "CTR sits below the band floor.",
    recommendation: "Rewrite the title.",
    evidenceJson: "{}",
    keyword: id,
    page: null,
    sourcesJson: "[]",
    firstDetectedAt: "2026-09-01T00:00:00.000Z",
    lastDetectedAt: "2026-09-20T00:00:00.000Z",
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-20T00:00:00.000Z",
  };
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockReset();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.listOpportunities.mockReset();
  mocks.getOpportunity.mockReset();
  mocks.updateOpportunityStatus.mockReset();
  mocks.getDashboardInsights.mockReset();
  mocks.getByProjectId.mockReset();
  mocks.getByProjectId.mockResolvedValue(null);
});

describe("intelligence MCP tools", () => {
  it("list_opportunities bounds rows at 50 with a total count", async () => {
    const rows = Array.from({ length: 60 }, (_, index) =>
      opportunityRow(`kw-${index}`),
    );
    mocks.listOpportunities.mockResolvedValue(rows);
    const { listOpportunitiesTool } = await import("./intelligence-tools");

    const result = await listOpportunitiesTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    const content = structuredRecord(result);
    expect(field(content, "totalCount")).toBe(60);
    expect(field(content, "hasMore")).toBe(true);
    expect(arrayField(content, "opportunities")).toHaveLength(50);
    expect(mocks.listOpportunities).toHaveBeenCalledWith({
      projectId: "project_1",
      status: undefined,
      type: undefined,
    });
  });

  it("list_opportunities output schema validates a bounded payload", async () => {
    const { listOpportunitiesTool } = await import("./intelligence-tools");
    const schema = normalizeObjectSchema(
      listOpportunitiesTool.config.outputSchema,
    );
    if (!schema) throw new Error("output schema did not normalize");
    const result = await safeParseAsync(schema, {
      opportunities: [opportunityRow("kw-0")],
      totalCount: 1,
      hasMore: false,
    });
    expect(result.success).toBe(true);
  });

  it("get_opportunity returns evidence plus bounded history", async () => {
    mocks.getOpportunity.mockResolvedValue({
      opportunity: opportunityRow("kw-1"),
      events: [{ id: "e1" }, { id: "e2" }],
    });
    const { getOpportunityTool } = await import("./intelligence-tools");

    const result = await getOpportunityTool.handler(
      { projectId: "project_1", id: "opp-1" },
      toolExtra,
    );
    const content = structuredRecord(result);
    expect(field(recordOf(field(content, "opportunity")), "id")).toBe("kw-1");
    expect(arrayField(content, "events")).toHaveLength(2);
  });

  it("update_opportunity_status forwards guards without bypass", async () => {
    mocks.updateOpportunityStatus.mockResolvedValue(opportunityRow("kw-1"));
    const { updateOpportunityStatusTool } =
      await import("./intelligence-tools");

    const result = await updateOpportunityStatusTool.handler(
      { projectId: "project_1", id: "opp-1", status: "in_progress" },
      toolExtra,
    );
    expect(mocks.updateOpportunityStatus).toHaveBeenCalledWith({
      id: "opp-1",
      projectId: "project_1",
      organizationId: "org_123",
      userId: "user_123",
      status: "in_progress",
      reason: undefined,
    });
    const content = structuredRecord(result);
    expect(field(recordOf(field(content, "opportunity")), "id")).toBe("kw-1");
  });

  it("get_dashboard_insights reads stored rows with banner state", async () => {
    mocks.getDashboardInsights.mockResolvedValue({
      insights: [
        {
          id: "ins-1",
          insightKey: "ranking_drop:top",
          severity: "high",
          title: "Top keywords lost rankings",
        },
      ],
      dismissedCount: 2,
      banner: { hasSuccessfulScan: true, stale: false },
    });
    const { getDashboardInsightsTool } = await import("./intelligence-tools");

    const result = await getDashboardInsightsTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    expect(mocks.getByProjectId).toHaveBeenCalledWith("project_1", "org_123");
    const content = structuredRecord(result);
    expect(field(content, "totalCount")).toBe(1);
    expect(field(content, "dismissedCount")).toBe(2);
  });

  it("rejects projects outside the caller's organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    const { listOpportunitiesTool } = await import("./intelligence-tools");

    await expect(
      listOpportunitiesTool.handler({ projectId: "project_9" }, toolExtra),
    ).rejects.toThrow();
    expect(mocks.listOpportunities).not.toHaveBeenCalled();
  });
});
