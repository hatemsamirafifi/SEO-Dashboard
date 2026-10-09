import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";

// Spec 013 (US4 T020): the five SAM autopilot tools delegate to the exact
// AutopilotService methods the UI server functions use — no parallel path.

const mocks = vi.hoisted(() => ({
  getProjectForOrganization: vi.fn(),
  startAutopilotRun: vi.fn(),
  getAutopilotRun: vi.fn(),
  listAutopilotRuns: vi.fn(),
  cancelAutopilotRun: vi.fn(),
  resumeAutopilotRun: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock("@/server/features/autopilot/services/AutopilotService", () => ({
  AutopilotService: {
    startAutopilotRun: mocks.startAutopilotRun,
    getAutopilotRun: mocks.getAutopilotRun,
    listAutopilotRuns: mocks.listAutopilotRuns,
    cancelAutopilotRun: mocks.cancelAutopilotRun,
    resumeAutopilotRun: mocks.resumeAutopilotRun,
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
  for (const [key, entry] of Object.entries(content)) {
    out[key] = entry;
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
  mocks.startAutopilotRun.mockReset();
  mocks.getAutopilotRun.mockReset();
  mocks.listAutopilotRuns.mockReset();
  mocks.cancelAutopilotRun.mockReset();
  mocks.resumeAutopilotRun.mockReset();
});

describe("autopilot run tools (SAM orchestration)", () => {
  it("start_autopilot_run delegates with chat provenance", async () => {
    mocks.startAutopilotRun.mockResolvedValue({ runId: "run-1" });
    const { startAutopilotRunTool } = await import("./autopilot-run-tools");
    const result = await startAutopilotRunTool.handler(
      { projectId: "project_1", workflowType: "content_refresh" },
      toolExtra,
    );
    expect(mocks.startAutopilotRun).toHaveBeenCalledWith({
      projectId: "project_1",
      organizationId: "org_123",
      userId: "user_123",
      userEmail: "alice@example.com",
      workflowType: "content_refresh",
      trigger: "sam_chat",
    });
    expect(structuredRecord(result)["runId"]).toBe("run-1");
    expect(textOf(result)).toContain("run-1");
  });

  it("start_autopilot_run rejects non-allowlisted types at the schema layer", async () => {
    const { startAutopilotRunTool } = await import("./autopilot-run-tools");
    const schema = z.object(startAutopilotRunTool.config.inputSchema);
    for (const workflowType of ["competitor_gap", "arbitrary_workflow", ""]) {
      expect(
        schema.safeParse({ projectId: "project_1", workflowType }).success,
      ).toBe(false);
    }
    expect(
      schema.safeParse({ projectId: "project_1", workflowType: "monthly_review" })
        .success,
    ).toBe(true);
  });

  it("start_autopilot_run denies projects outside the organization", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);
    const { startAutopilotRunTool } = await import("./autopilot-run-tools");
    await expect(
      startAutopilotRunTool.handler(
        { projectId: "other-project", workflowType: "content_refresh" },
        toolExtra,
      ),
    ).rejects.toThrow();
    expect(mocks.startAutopilotRun).not.toHaveBeenCalled();
  });

  it("get_autopilot_run reports a wrong-project run as not found", async () => {
    mocks.getAutopilotRun.mockResolvedValue(null);
    const { getAutopilotRunTool } = await import("./autopilot-run-tools");
    await expect(
      getAutopilotRunTool.handler(
        { projectId: "project_1", runId: "run-x" },
        toolExtra,
      ),
    ).rejects.toThrow("not found in this project");
  });

  it("list_autopilot_runs returns the bounded run table", async () => {
    mocks.listAutopilotRuns.mockResolvedValue([
      { id: "run-1", workflowType: "content_refresh", status: "running" },
      { id: "run-2", workflowType: "monthly_review", status: "completed" },
    ]);
    const { listAutopilotRunsTool } = await import("./autopilot-run-tools");
    const result = await listAutopilotRunsTool.handler(
      { projectId: "project_1" },
      toolExtra,
    );
    const structured = structuredRecord(result);
    expect(Array.isArray(structured["runs"])).toBe(true);
    expect(textOf(result)).toContain("run-1");
  });

  it("cancel_autopilot_run delegates with service idempotency", async () => {
    mocks.cancelAutopilotRun.mockResolvedValue({ status: "cancelled" });
    const { cancelAutopilotRunTool } = await import("./autopilot-run-tools");
    const result = await cancelAutopilotRunTool.handler(
      { projectId: "project_1", runId: "run-1" },
      toolExtra,
    );
    expect(mocks.cancelAutopilotRun).toHaveBeenCalledWith({
      runId: "run-1",
      projectId: "project_1",
      organizationId: "org_123",
      userId: "user_123",
    });
    expect(structuredRecord(result)["status"]).toBe("cancelled");
  });

  it("resume_autopilot_run delegates with user identity", async () => {
    mocks.resumeAutopilotRun.mockResolvedValue({ runId: "run-1", resumed: true });
    const { resumeAutopilotRunTool } = await import("./autopilot-run-tools");
    const result = await resumeAutopilotRunTool.handler(
      { projectId: "project_1", runId: "run-1" },
      toolExtra,
    );
    expect(mocks.resumeAutopilotRun).toHaveBeenCalledWith({
      runId: "run-1",
      projectId: "project_1",
      organizationId: "org_123",
      userId: "user_123",
      userEmail: "alice@example.com",
    });
    expect(structuredRecord(result)["resumed"]).toBe(true);
  });

  it("marks mutating tools non-read-only and reads read-only", async () => {
    const tools = await import("./autopilot-run-tools");
    expect(tools.startAutopilotRunTool.config.annotations?.readOnlyHint).toBe(
      false,
    );
    expect(tools.cancelAutopilotRunTool.config.annotations?.readOnlyHint).toBe(
      false,
    );
    expect(tools.resumeAutopilotRunTool.config.annotations?.readOnlyHint).toBe(
      false,
    );
    expect(tools.getAutopilotRunTool.config.annotations?.readOnlyHint).toBe(true);
    expect(tools.listAutopilotRunsTool.config.annotations?.readOnlyHint).toBe(
      true,
    );
  });
});
