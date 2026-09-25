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
import { ReportService } from "@/server/features/reports/services/ReportService";
import { REPORT_TYPES, type ReportType } from "@/shared/reports";

// Report snapshots + autopilot run reads (final-plan §16). Same services as
// the reports/autopilot server fns — snapshots stay frozen, runs stay
// durable-executed. No run-starters here (deferred per §22).

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "Expected an ISO date (YYYY-MM-DD)")
  .describe("ISO date (YYYY-MM-DD).");

// ─── generate_report ───────────────────────────────────────────────────────

const generateInputSchema = {
  projectId: projectIdSchema,
  type: z.enum(REPORT_TYPES).describe("Report type (section selector)."),
  from: isoDateSchema,
  to: isoDateSchema,
  strict: z
    .boolean()
    .optional()
    .describe(
      "Abort when sources change mid-collection instead of bannered output. Defaults to false.",
    ),
} as const;

type GenerateArgs = {
  projectId: string;
  type: ReportType;
  from: string;
  to: string;
  strict?: boolean;
};

export const generateReportTool = {
  name: "generate_report",
  config: {
    title: "Generate report",
    description:
      "Generate a frozen report snapshot (metrics plus insight and opportunity copies) with dual-sided provenance. Immutable once ready.",
    inputSchema: generateInputSchema,
    outputSchema: z
      .object({
        report: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler: withMcpProjectAuth(async (args: GenerateArgs, context) => {
    if (args.from > args.to) {
      throw new AppError(
        "VALIDATION_ERROR",
        "Report period must satisfy from <= to.",
      );
    }
    const report = await ReportService.generateReport({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      userId: context.auth.userId,
      domain: context.project.domain,
      type: args.type,
      period: { from: args.from, to: args.to },
      strict: args.strict,
    });
    return mcpResponse({
      text: `Report ${report.id} (${report.type}) is ready for ${args.from} → ${args.to}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/reports/${report.id}`,
      ),
      structuredContent: { report },
    });
  }),
};

// ─── get_report ────────────────────────────────────────────────────────────

const reportByIdInputSchema = {
  projectId: projectIdSchema,
  id: z.string().min(1).describe("Report ID."),
} as const;

type ReportByIdArgs = { projectId: string; id: string };

export const getReportTool = {
  name: "get_report",
  config: {
    title: "Get report",
    description: "Read a frozen report snapshot with its provenance block.",
    inputSchema: reportByIdInputSchema,
    outputSchema: z
      .object({
        report: looseObjectOutputSchema,
        payload: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: ReportByIdArgs, context) => {
    const result = await ReportService.getReport({
      id: args.id,
      projectId: args.projectId,
    });
    if (!result) {
      throw new AppError(
        "NOT_FOUND",
        `Report ${args.id} not found in this project.`,
      );
    }
    return mcpResponse({
      text: `Report ${result.report.id} (${result.report.type}): ${result.report.consistencyStatus}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/reports/${result.report.id}`,
      ),
      structuredContent: { report: result.report, payload: result.payload },
    });
  }),
};

// ─── get_autopilot_run ─────────────────────────────────────────────────────

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
      "Poll an autopilot run: status, attempts (including invalidated retries), and the frozen step checklist with summary evidence.",
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
