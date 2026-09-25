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
  generateReport: vi.fn(),
  getReport: vi.fn(),
  getAutopilotRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/reports/services/ReportService", () => ({
  ReportService: {
    generateReport: mocks.generateReport,
    getReport: mocks.getReport,
  },
}));
vi.mock("@/server/features/autopilot/services/AutopilotService", () => ({
  AutopilotService: { getAutopilotRun: mocks.getAutopilotRun },
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

function recordField(
  record: Record<string, unknown>,
  key: string,
): Record<string, unknown> {
  const value: unknown = record[key];
  if (typeof value !== "object" || value === null) {
    throw new Error(`expected record at ${key}`);
  }
  const out: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(value)) {
    out[entryKey] = entry;
  }
  return out;
}

function textOf(result: CallToolResult): string {
  const first: unknown = result.content[0];
  if (typeof first !== "object" || first === null) return "";
  if (!("type" in first) || first.type !== "text") return "";
  if (!("text" in first) || typeof first.text !== "string") return "";
  return first.text;
}

beforeEach(() => {
  mocks.getProjectForOrganization.mockReset();
  mocks.getProjectForOrganization.mockResolvedValue({
    id: "project_1",
    domain: "example.com",
    locationCode: 2840,
    languageCode: "en",
  });
  mocks.generateReport.mockReset();
  mocks.getReport.mockReset();
  mocks.getAutopilotRun.mockReset();
});

describe("report and autopilot MCP tools", () => {
  it("generate_report freezes a snapshot with the project domain", async () => {
    mocks.generateReport.mockResolvedValue({
      id: "rep-1",
      type: "overview",
      status: "ready",
    });
    const { generateReportTool } = await import("./report-autopilot-tools");

    const result = await generateReportTool.handler(
      {
        projectId: "project_1",
        type: "overview",
        from: "2026-08-29",
        to: "2026-09-25",
      },
      toolExtra,
    );
    expect(mocks.generateReport).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      userId: "user_123",
      domain: "example.com",
      type: "overview",
      period: { from: "2026-08-29", to: "2026-09-25" },
      strict: undefined,
    });
    expect(recordField(structuredRecord(result), "report")["id"]).toBe("rep-1");
  });

  it("generate_report output schema validates a snapshot payload", async () => {
    const { generateReportTool } = await import("./report-autopilot-tools");
    const schema = normalizeObjectSchema(
      generateReportTool.config.outputSchema,
    );
    if (!schema) throw new Error("output schema did not normalize");
    const result = await safeParseAsync(schema, {
      report: { id: "rep-1", type: "overview", status: "ready" },
    });
    expect(result.success).toBe(true);
  });

  it("get_report surfaces missing snapshots as NOT_FOUND", async () => {
    mocks.getReport.mockResolvedValue(null);
    const { getReportTool } = await import("./report-autopilot-tools");

    await expect(
      getReportTool.handler({ projectId: "project_1", id: "rep-9" }, toolExtra),
    ).rejects.toThrow("not found");
  });

  it("get_autopilot_run reports status, attempts, and steps", async () => {
    mocks.getAutopilotRun.mockResolvedValue({
      run: { id: "run-1", workflowType: "growth_plan", status: "running" },
      attempts: [
        { id: "a-1", attemptNumber: 1, status: "invalidated" },
        { id: "a-2", attemptNumber: 2, status: "running" },
      ],
      steps: [
        { seq: 0, kind: "collect", name: "collect", status: "completed" },
        { seq: 1, kind: "correlate", name: "rank", status: "running" },
      ],
    });
    const { getAutopilotRunTool } = await import("./report-autopilot-tools");

    const result = await getAutopilotRunTool.handler(
      { projectId: "project_1", runId: "run-1" },
      toolExtra,
    );
    expect(textOf(result)).toContain("running");
    expect(textOf(result)).toContain("1 invalidated");
    const content = structuredRecord(result);
    expect(arrayField(content, "attempts")).toHaveLength(2);
    expect(arrayField(content, "steps")).toHaveLength(2);
  });

  it("get_autopilot_run output schema validates a run view", async () => {
    const { getAutopilotRunTool } = await import("./report-autopilot-tools");
    const schema = normalizeObjectSchema(
      getAutopilotRunTool.config.outputSchema,
    );
    if (!schema) throw new Error("output schema did not normalize");
    const result = await safeParseAsync(schema, {
      run: { id: "run-1", status: "completed" },
      attempts: [{ id: "a-1", status: "completed" }],
      steps: [{ seq: 0, status: "completed" }],
    });
    expect(result.success).toBe(true);
  });
});
