import { z } from "zod";
import { AppError } from "@/server/lib/errors";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  AutopilotService,
  type AutopilotRunView,
} from "@/server/features/autopilot/services/AutopilotService";
import { AUTOPILOT_WORKFLOW_TYPES } from "@/shared/autopilot";

// SAM autopilot orchestration tools (spec 013, E2 — PR21). Same definition
// shape as report-autopilot-tools.ts and the same AutopilotService methods
// the UI server functions call — no parallel orchestration path.
//
// These definitions are adapted into the SAM chat agent only. They are NOT
// registered on the public MCP route (src/server/mcp/server.ts): run-starters
// stay deferred per source plan §22. SAM binds the session project server-side
// (via the adapter), so projectId never comes from the model.

const workflowTypeSchema = z
  .enum(AUTOPILOT_WORKFLOW_TYPES)
  .describe("Autopilot workflow to run (explicit allowlist).");

// ─── start_autopilot_run ─────────────────────────────────────────────────

type StartArgs = { projectId: string; workflowType: string };

export const startAutopilotRunTool = {
  name: "start_autopilot_run",
  config: {
    title: "Start autopilot run",
    description:
      "Start one allowlisted autopilot workflow run for this project: content_refresh, technical_seo, monthly_review, growth_plan, quick_wins, or traffic_drop. Returns immediately with the run id; poll it with get_autopilot_run. One workflow at a time — wait for a terminal state before summarizing.",
    inputSchema: {
      projectId: projectIdSchema,
      workflowType: workflowTypeSchema,
    } as const,
    outputSchema: z
      .object({
        runId: z.string(),
        workflowType: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler: withMcpProjectAuth(async (args: StartArgs, context) => {
    const { runId } = await AutopilotService.startAutopilotRun({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      userId: context.auth.userId,
      userEmail: context.auth.userEmail,
      workflowType: args.workflowType,
      trigger: "sam_chat",
    });
    return mcpResponse({
      text: `Run ${runId} (${args.workflowType}) started.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/sam`,
      ),
      structuredContent: { runId, workflowType: args.workflowType },
    });
  }),
};

// ─── get_autopilot_run ───────────────────────────────────────────────────

type AutopilotStepRow = AutopilotRunView["steps"][number];

const STEP_COLUMNS: McpTableColumn<AutopilotStepRow>[] = [
  { header: "seq", value: (row) => row.seq },
  { header: "kind", value: (row) => row.kind },
  { header: "name", value: (row) => row.name },
  { header: "status", value: (row) => row.status },
];

const runByIdInputSchema = {
  projectId: projectIdSchema,
  runId: z.string().min(1).describe("Autopilot run ID."),
} as const;

type RunByIdArgs = { projectId: string; runId: string };

export const getAutopilotRunTool = {
  name: "get_autopilot_run",
  config: {
    title: "Get autopilot run",
    description:
      "Poll an autopilot run: status, attempts (including invalidated retries), and the frozen step checklist with summary evidence. Live read — call again for fresh state.",
    inputSchema: runByIdInputSchema,
    outputSchema: z
      .object({
        run: looseObjectOutputSchema,
        attempts: z.array(looseObjectOutputSchema),
        steps: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: RunByIdArgs, context) => {
    const view = await AutopilotService.getAutopilotRun({
      runId: args.runId,
      projectId: args.projectId,
    });
    if (!view) {
      throw new AppError(
        "NOT_FOUND",
        `Autopilot run ${args.runId} not found in this project.`,
      );
    }
    const invalidated = view.attempts.filter(
      (attempt) => attempt.status === "invalidated",
    ).length;
    const text = [
      `Run ${view.run.id} (${view.run.workflowType}): ${view.run.status}.`,
      `Attempts: ${view.attempts.length} (${invalidated} invalidated by source changes).`,
      formatMcpTable(view.steps, STEP_COLUMNS),
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/sam`,
      ),
      structuredContent: {
        run: view.run,
        attempts: view.attempts,
        steps: view.steps,
      },
    });
  }),
};

// ─── list_autopilot_runs ─────────────────────────────────────────────────

type AutopilotRunRow = Awaited<
  ReturnType<typeof AutopilotService.listAutopilotRuns>
>[number];

const RUN_COLUMNS: McpTableColumn<AutopilotRunRow>[] = [
  { header: "id", value: (row) => row.id },
  { header: "workflowType", value: (row) => row.workflowType },
  { header: "status", value: (row) => row.status },
];

const listInputSchema = {
  projectId: projectIdSchema,
} as const;

type ListArgs = { projectId: string };

export const listAutopilotRunsTool = {
  name: "list_autopilot_runs",
  config: {
    title: "List autopilot runs",
    description:
      "List this project's autopilot runs with workflow type and status. Live read — call again for fresh state.",
    inputSchema: listInputSchema,
    outputSchema: z
      .object({
        runs: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const runs = await AutopilotService.listAutopilotRuns({
      projectId: args.projectId,
    });
    const text = [
      `${runs.length} autopilot run(s) in this project.`,
      formatMcpTable(runs, RUN_COLUMNS),
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/sam`,
      ),
      structuredContent: { runs },
    });
  }),
};

// ─── cancel_autopilot_run ────────────────────────────────────────────────

export const cancelAutopilotRunTool = {
  name: "cancel_autopilot_run",
  config: {
    title: "Cancel autopilot run",
    description:
      "Cancel a pending or running autopilot run. Terminal runs report their final status unchanged.",
    inputSchema: runByIdInputSchema,
    outputSchema: z
      .object({
        status: z.string(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler: withMcpProjectAuth(async (args: RunByIdArgs, context) => {
    const { status } = await AutopilotService.cancelAutopilotRun({
      runId: args.runId,
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      userId: context.auth.userId,
    });
    return mcpResponse({
      text: `Run ${args.runId} is ${status}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/sam`,
      ),
      structuredContent: { status },
    });
  }),
};

// ─── resume_autopilot_run ────────────────────────────────────────────────

export const resumeAutopilotRunTool = {
  name: "resume_autopilot_run",
  config: {
    title: "Resume autopilot run",
    description:
      "Resume a running or cancelled autopilot run whose workflow instance is gone. Completed or failed runs cannot resume.",
    inputSchema: runByIdInputSchema,
    outputSchema: z
      .object({
        runId: z.string(),
        resumed: z.boolean(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler: withMcpProjectAuth(async (args: RunByIdArgs, context) => {
    const { runId, resumed } = await AutopilotService.resumeAutopilotRun({
      runId: args.runId,
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      userId: context.auth.userId,
      userEmail: context.auth.userEmail,
    });
    return mcpResponse({
      text: resumed
        ? `Run ${runId} resumed.`
        : `Run ${runId} did not resume (already active or terminal).`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/sam`,
      ),
      structuredContent: { runId, resumed },
    });
  }),
};
