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
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import {
  OpportunityService,
  type OpportunityWithBreakdown,
} from "@/server/features/intelligence/services/OpportunityService";
import { InsightService } from "@/server/features/intelligence/services/InsightService";

// Engine-backed intelligence reads (final-plan §16). Same services as the
// dashboard/opportunities server fns — no detector logic in handlers.

const MCP_ROW_LIMIT = 50;

const opportunityStatusSchema = z
  .enum(["open", "in_progress", "completed", "dismissed"])
  .describe("Filter by lifecycle status. Omit for all statuses.");

type OpportunityListRow = OpportunityWithBreakdown;

const OPPORTUNITY_COLUMNS: McpTableColumn<OpportunityListRow>[] = [
  { header: "id", value: (row) => row.id },
  { header: "priority", value: (row) => row.priority },
  { header: "impact", value: (row) => row.impactScore },
  { header: "confidence", value: (row) => row.confidenceScore },
  { header: "type", value: (row) => row.type },
  { header: "status", value: (row) => row.status },
  { header: "title", value: (row) => row.title },
];

const opportunityRowsOutput = z
  .object({
    opportunities: z.array(looseObjectOutputSchema),
    totalCount: z.number(),
    hasMore: z.boolean(),
    ...optionalMetaOutputSchema,
  })
  .passthrough();

// ─── list_opportunities ────────────────────────────────────────────────────

const listInputSchema = {
  projectId: projectIdSchema,
  status: opportunityStatusSchema.optional(),
  type: z
    .string()
    .min(1)
    .optional()
    .describe("Filter by detector-family type. Omit for all types."),
} as const;

type ListArgs = {
  projectId: string;
  status?: "open" | "in_progress" | "completed" | "dismissed";
  type?: string;
};

export const listOpportunitiesTool = {
  name: "list_opportunities",
  config: {
    title: "List opportunities",
    description:
      "List scored SEO opportunities for a project (canonical priority order). Reads engine-backed lifecycle rows — detection and scoring stay in the engine.",
    inputSchema: listInputSchema,
    outputSchema: opportunityRowsOutput,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: ListArgs, context) => {
    const rows = await OpportunityService.listOpportunities({
      projectId: args.projectId,
      status: args.status,
      type: args.type,
    });
    const shown = rows.slice(0, MCP_ROW_LIMIT);
    const text =
      rows.length === 0
        ? "No opportunities match these filters yet. Run an intelligence scan from the dashboard, then try again."
        : [
            `${rows.length} opportunit${rows.length === 1 ? "y" : "ies"} (showing ${shown.length}):`,
            formatMcpTable(shown, OPPORTUNITY_COLUMNS),
          ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/opportunities`,
      ),
      structuredContent: {
        opportunities: shown,
        totalCount: rows.length,
        hasMore: rows.length > shown.length,
      },
    });
  }),
};

// ─── get_opportunity ───────────────────────────────────────────────────────

const byIdInputSchema = {
  projectId: projectIdSchema,
  id: z.string().min(1).describe("Opportunity occurrence ID."),
} as const;

type ByIdArgs = { projectId: string; id: string };

export const getOpportunityTool = {
  name: "get_opportunity",
  config: {
    title: "Get opportunity",
    description:
      "Get one opportunity with its evidence, score breakdown, and lifecycle history.",
    inputSchema: byIdInputSchema,
    outputSchema: z
      .object({
        opportunity: looseObjectOutputSchema,
        events: z.array(looseObjectOutputSchema),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: ByIdArgs, context) => {
    const result = await OpportunityService.getOpportunity({
      id: args.id,
      projectId: args.projectId,
    });
    if (!result) {
      throw new AppError(
        "NOT_FOUND",
        `Opportunity ${args.id} not found in this project.`,
      );
    }
    const { opportunity, events } = result;
    const text = [
      `${opportunity.priority} · impact ${opportunity.impactScore} · confidence ${opportunity.confidenceScore}`,
      opportunity.title,
      `Status: ${opportunity.status} · type ${opportunity.type}`,
      `History events: ${events.length}`,
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/opportunities/${opportunity.id}`,
      ),
      structuredContent: {
        opportunity,
        events: events.slice(0, MCP_ROW_LIMIT),
      },
    });
  }),
};

// ─── update_opportunity_status ─────────────────────────────────────────────

const updateInputSchema = {
  projectId: projectIdSchema,
  id: z.string().min(1).describe("Opportunity occurrence ID."),
  status: z
    .enum(["open", "in_progress", "completed", "dismissed"])
    .describe("Target lifecycle status."),
  reason: z
    .string()
    .max(500)
    .optional()
    .describe("Required when dismissing; recorded in the audit trail."),
} as const;

type UpdateArgs = {
  projectId: string;
  id: string;
  status: "open" | "in_progress" | "completed" | "dismissed";
  reason?: string;
};

export const updateOpportunityStatusTool = {
  name: "update_opportunity_status",
  config: {
    title: "Update opportunity status",
    description:
      "Move an opportunity through its lifecycle (open/in_progress/completed/dismissed). Terminal rows stay terminal; dismissal requires a reason.",
    inputSchema: updateInputSchema,
    outputSchema: z
      .object({
        opportunity: looseObjectOutputSchema,
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: false, destructiveHint: false },
  },
  handler: withMcpProjectAuth(async (args: UpdateArgs, context) => {
    const opportunity = await OpportunityService.updateOpportunityStatus({
      id: args.id,
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      userId: context.auth.userId,
      status: args.status,
      reason: args.reason,
    });
    return mcpResponse({
      text: `Opportunity ${opportunity.id} is now ${opportunity.status}.`,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/opportunities/${opportunity.id}`,
      ),
      structuredContent: { opportunity },
    });
  }),
};

// ─── get_dashboard_insights ────────────────────────────────────────────────

type InsightListRow = {
  insightKey: string;
  severity: string;
  title: string;
};

const INSIGHT_COLUMNS: McpTableColumn<InsightListRow>[] = [
  { header: "key", value: (row) => row.insightKey },
  { header: "severity", value: (row) => row.severity },
  { header: "title", value: (row) => row.title },
];

export const getDashboardInsightsTool = {
  name: "get_dashboard_insights",
  config: {
    title: "Get dashboard insights",
    description:
      "Read composed dashboard insights for a project (stored rows plus scan-ledger state). Reads only — scans run on the cron/manual paths.",
    inputSchema: { projectId: projectIdSchema } as const,
    outputSchema: z
      .object({
        insights: z.array(looseObjectOutputSchema),
        totalCount: z.number(),
        hasMore: z.boolean(),
        dismissedCount: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: { projectId: string }, context) => {
    const connection = await Ga4ConnectionRepository.getByProjectId(
      args.projectId,
      context.auth.organizationId,
    );
    const { insights, dismissedCount } =
      await InsightService.getDashboardInsights({
        projectId: args.projectId,
        organizationId: context.auth.organizationId,
        userId: context.auth.userId,
        ga4Connected: connection !== null,
      });
    const shown = insights.slice(0, MCP_ROW_LIMIT);
    const text =
      insights.length === 0
        ? "No current insights for this project yet."
        : [
            `${insights.length} insight${insights.length === 1 ? "" : "s"} (showing ${shown.length}):`,
            formatMcpTable(
              shown.map((row) => ({
                insightKey: row.insightKey,
                severity: row.severity,
                title: row.title,
              })),
              INSIGHT_COLUMNS,
            ),
          ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(context, args.projectId, `/p/${args.projectId}`),
      structuredContent: {
        insights: shown,
        totalCount: insights.length,
        hasMore: insights.length > shown.length,
        dismissedCount,
      },
    });
  }),
};
