import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  // D1-mode passthrough: the callback runs directly; the client handle only
  // matters in Postgres mode, which these tests never exercise.
  withPgClient: <T,>(
    fn: (p: Promise<never>) => Promise<T>,
  ): Promise<T> => fn(new Promise<never>(() => {})),
}));

// The audit tools are stubbed at the shared-definition boundary so this suite
// exercises only the SAM adapter behavior around them: cache policy,
// description overrides, and output tagging.
const auditHandler = vi.fn<
  (
    name: string,
    args: { projectId?: string },
    extra: unknown,
  ) => Promise<CallToolResult>
>();
vi.mock("@/server/mcp/tools/site-audit-tools", () => {
  const def = (
    name: string,
    inputSchema: Record<string, z.ZodType>,
  ): unknown => ({
    name,
    config: { description: `${name} shared description`, inputSchema },
    handler: (args: { projectId?: string }, extra: unknown) =>
      auditHandler(name, args, extra),
  });
  return {
    runSiteAuditTool: def("run_site_audit", { projectId: z.string() }),
    getAuditStatusTool: def("get_audit_status", {
      projectId: z.string(),
      auditId: z.string().optional(),
    }),
    getAuditIssuesTool: def("get_audit_issues", { projectId: z.string() }),
    getAuditPagesTool: def("get_audit_pages", { projectId: z.string() }),
  };
});

// Spec 013 (US4 T021): the autopilot run tools are stubbed at the same
// shared-definition boundary; this suite exercises only SAM adapter behavior.
const autopilotHandler = vi.fn<
  (
    name: string,
    args: { projectId?: string },
    extra: unknown,
  ) => Promise<CallToolResult>
>();
vi.mock("@/server/mcp/tools/autopilot-run-tools", () => {
  const def = (
    name: string,
    inputSchema: Record<string, z.ZodType>,
  ): unknown => ({
    name,
    config: { description: `${name} shared description`, inputSchema },
    handler: (args: { projectId?: string }, extra: unknown) =>
      autopilotHandler(name, args, extra),
  });
  return {
    startAutopilotRunTool: def("start_autopilot_run", {
      projectId: z.string(),
      workflowType: z.string(),
    }),
    getAutopilotRunTool: def("get_autopilot_run", {
      projectId: z.string(),
      runId: z.string(),
    }),
    listAutopilotRunsTool: def("list_autopilot_runs", {
      projectId: z.string(),
    }),
    cancelAutopilotRunTool: def("cancel_autopilot_run", {
      projectId: z.string(),
      runId: z.string(),
    }),
    resumeAutopilotRunTool: def("resume_autopilot_run", {
      projectId: z.string(),
      runId: z.string(),
    }),
  };
});

import { buildSamMcpTools } from "./samChatTools";
import { createPollCoordinator } from "./samLongRunningTools";
import { createToolExecutionTracker } from "./samToolExecution";
import type { McpToolAuthContext } from "@/server/mcp/context";

const authContext: McpToolAuthContext = {
  userId: "u1",
  userEmail: "u@example.com",
  organizationId: "org1",
  clientId: null,
  audience: "openseo",
  subject: "u1",
  baseUrl: "http://localhost",
  scopes: [],
};

const project = { id: "p1", domain: null };

function mcpResult(structured: unknown): CallToolResult {
  return {
    content: [{ type: "text", text: "summary" }],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test fixture: arbitrary structured payload behind the SDK's loose Record type
    structuredContent: structured as Record<string, unknown>,
  };
}

// Invoke one adapted tool through its AI SDK execute. ToolSet values are
// loosely typed by the SDK (execute unions with streaming variants), so the
// callable shape is narrowed once here instead of at every call site.
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing the SDK's loose ToolSet value to its callable shape once for all tests
function callTool(tool: unknown, args: unknown = {}): Promise<unknown> {
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowing the SDK's loose ToolSet value to its callable shape once for all tests
  const execute = (tool as { execute?: (...a: unknown[]) => unknown }).execute;
  if (!execute) throw new Error("tool has no execute");
  return Promise.resolve(execute(args, { toolCallId: "t", messages: [] }));
}

describe("samChatTools audit wiring", () => {
  beforeEach(() => {
    auditHandler.mockReset();
  });

  function tools() {
    return buildSamMcpTools(authContext, project, undefined, {
      poll: { initialMs: 1, maxMs: 2, maxAttempts: 1, timeoutMs: 10_000 },
      pollCoordinator: createPollCoordinator(),
    });
  }

  it("registers poll_site_audit when polling is configured", () => {
    expect(tools().poll_site_audit).toBeDefined();
    expect(
      buildSamMcpTools(authContext, project).poll_site_audit,
    ).toBeUndefined();
  });

  it("serves get_audit_status fresh on every call (never from dedup cache)", async () => {
    auditHandler.mockResolvedValue(
      mcpResult({ status: { id: "a1", status: "running" } }),
    );
    const set = tools();
    const first = await callTool(set.get_audit_status);
    const second = await callTool(set.get_audit_status);
    expect(auditHandler).toHaveBeenCalledTimes(2);
    // Both calls hit the handler; a cached snapshot would be identical, so
    // also assert the projectId was injected server-side.
    for (const call of auditHandler.mock.calls) {
      expect(call[1].projectId).toBe("p1");
    }
    expect(first).toEqual(second);
  });

  it("tags run_site_audit output with state=started and overrides its description", async () => {
    auditHandler.mockResolvedValue(mcpResult({ auditId: "a9" }));
    const set = tools();
    const runTool = set.run_site_audit;
    expect(runTool.description).toMatch(/poll_site_audit/);
    const raw = await callTool(runTool);
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- asserting the documented tagStartedAudit output shape
    const output = raw as { data: { auditId: string; state: string } };
    expect(output.data.auditId).toBe("a9");
    expect(output.data.state).toBe("started");
  });
});

// Spec 013 (US4 T021): SAM adapter behavior for the five autopilot run tools.
describe("samChatTools autopilot wiring", () => {
  beforeEach(() => {
    autopilotHandler.mockReset();
  });

  function tools(tracker?: ReturnType<typeof createToolExecutionTracker>) {
    return buildSamMcpTools(authContext, project, tracker, {
      poll: { initialMs: 1, maxMs: 2, maxAttempts: 1, timeoutMs: 10_000 },
      pollCoordinator: createPollCoordinator(),
    });
  }

  it("registers all five autopilot run tools", () => {
    const set = tools();
    expect(set.start_autopilot_run).toBeDefined();
    expect(set.get_autopilot_run).toBeDefined();
    expect(set.list_autopilot_runs).toBeDefined();
    expect(set.cancel_autopilot_run).toBeDefined();
    expect(set.resume_autopilot_run).toBeDefined();
  });

  it("injects the session project into run tool calls (model never passes it)", async () => {
    autopilotHandler.mockResolvedValue(mcpResult({ runId: "run-1" }));
    const set = tools();
    await callTool(set.start_autopilot_run, {
      workflowType: "content_refresh",
    });
    expect(autopilotHandler).toHaveBeenCalledTimes(1);
    expect(autopilotHandler.mock.calls[0]?.[1].projectId).toBe("p1");
  });

  it("serves run polls fresh on every call (never from dedup cache)", async () => {
    autopilotHandler.mockResolvedValue(
      mcpResult({ run: { id: "run-1", status: "running" } }),
    );
    const set = tools();
    await callTool(set.get_autopilot_run, { runId: "run-1" });
    await callTool(set.get_autopilot_run, { runId: "run-1" });
    await callTool(set.list_autopilot_runs);
    await callTool(set.list_autopilot_runs);
    expect(
      autopilotHandler.mock.calls.filter(([name]) => name === "get_autopilot_run"),
    ).toHaveLength(2);
    expect(
      autopilotHandler.mock.calls.filter(
        ([name]) => name === "list_autopilot_runs",
      ),
    ).toHaveLength(2);
  });

  it("dedups repeat start calls within one conversation", async () => {
    autopilotHandler.mockResolvedValue(mcpResult({ runId: "run-1" }));
    const tracker = createToolExecutionTracker({
      sessionId: "sam-test",
      projectId: "p1",
    });
    const set = tools(tracker);
    await callTool(set.start_autopilot_run, {
      workflowType: "content_refresh",
    });
    await callTool(set.start_autopilot_run, {
      workflowType: "content_refresh",
    });
    expect(
      autopilotHandler.mock.calls.filter(
        ([name]) => name === "start_autopilot_run",
      ),
    ).toHaveLength(1);
  });
});
