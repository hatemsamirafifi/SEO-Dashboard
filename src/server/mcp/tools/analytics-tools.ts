import { z } from "zod";
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
  AnalyticsService,
  type AnalyticsLandingRow,
  type MetricDelta,
} from "@/server/features/ga4/services/AnalyticsService";
import {
  ANALYTICS_RANGES,
  GA4_ANALYTICS_DEVICES,
  type AnalyticsRange,
} from "@/types/schemas/ga4";

// Engine-backed analytics reads (final-plan §16). Same AnalyticsService as
// the analytics page server fns — DB-first with coverage states.

export const MCP_ROW_LIMIT = 50;

export const rangeSchema = z
  .enum(ANALYTICS_RANGES)
  .default("last_28_days")
  .describe("Date range. Defaults to last_28_days.");

export const analyticsMcpFilterShape = {
  channel: z
    .string()
    .min(1)
    .max(100)
    .optional()
    .describe("Channel group filter."),
  device: z
    .enum(GA4_ANALYTICS_DEVICES)
    .optional()
    .describe("Device category filter."),
  country: z.string().min(1).max(100).optional().describe("Country filter."),
} as const;

const filterShape = analyticsMcpFilterShape;

export type AnalyticsMcpFilters = {
  channel?: string;
  device?: "desktop" | "mobile" | "tablet";
  country?: string;
};

type AnalyticsFilters = AnalyticsMcpFilters;

function deltaLine(label: string, delta: MetricDelta): string {
  const pct =
    delta.pctChange === null ? "n/a" : `${(delta.pctChange * 100).toFixed(1)}%`;
  return `${label}: ${delta.current} (was ${delta.previous}, ${pct})`;
}

export function notConnectedText(projectId: string): string {
  return (
    `Google Analytics is not connected for this project. ` +
    `Connect it from /p/${projectId}/settings, then sync before reading analytics.`
  );
}

// ─── get_analytics_overview ────────────────────────────────────────────────

const overviewInputSchema = {
  projectId: projectIdSchema,
  range: rangeSchema,
  ...filterShape,
} as const;

type OverviewArgs = {
  projectId: string;
  range?: AnalyticsRange;
  channel?: string;
  device?: "desktop" | "mobile" | "tablet";
  country?: string;
};

export const getAnalyticsOverviewTool = {
  name: "get_analytics_overview",
  config: {
    title: "Get analytics overview",
    description:
      "Get GA4 overview totals (current vs equivalent previous period) with coverage state. DB-first; connect GA4 first when unconnected.",
    inputSchema: overviewInputSchema,
    outputSchema: z
      .object({
        connected: z.boolean(),
        overview: looseObjectOutputSchema.optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    const filters: AnalyticsFilters = {};
    if (args.channel) filters.channel = args.channel;
    if (args.device) filters.device = args.device;
    if (args.country) filters.country = args.country;
    const overview = await AnalyticsService.getOverview({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      range: args.range ?? "last_28_days",
      ...filters,
    });
    if (!overview.connected) {
      return mcpResponse({
        text: notConnectedText(args.projectId),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/analytics`,
        ),
        structuredContent: { connected: false },
      });
    }
    const text = [
      `Sessions, engagement, and views for ${overview.windows.current.from} → ${overview.windows.current.to} (vs prior period):`,
      deltaLine("sessions", overview.totals.sessions),
      deltaLine("engaged sessions", overview.totals.engagedSessions),
      deltaLine("views", overview.totals.screenPageViews),
      deltaLine("events", overview.totals.eventCount),
      `Coverage: ${overview.coverage.status} (${overview.coverage.coveredDates}/${overview.coverage.totalDates} dates)`,
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/analytics`,
      ),
      structuredContent: { connected: true, overview },
    });
  }),
};

// ─── get_analytics_landing_pages ───────────────────────────────────────────

const landingInputSchema = {
  projectId: projectIdSchema,
  range: rangeSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MCP_ROW_LIMIT)
    .default(25)
    .describe(
      "Max landing pages to return (1-50, GSC-style agent bounding). Defaults to 25.",
    ),
  ...filterShape,
} as const;

type LandingArgs = OverviewArgs & { limit?: number };

const LANDING_COLUMNS: McpTableColumn<AnalyticsLandingRow>[] = [
  { header: "page", value: (row) => row.landingPage },
  { header: "sessions", value: (row) => row.sessions.current },
  { header: "sessions Δ%", value: (row) => row.sessions.pctChange },
  { header: "views", value: (row) => row.screenPageViews.current },
];

export const getAnalyticsLandingPagesTool = {
  name: "get_analytics_landing_pages",
  config: {
    title: "Get analytics landing pages",
    description:
      "Get top GA4 landing pages with current-vs-previous deltas. Page rows carry no per-event metric.",
    inputSchema: landingInputSchema,
    outputSchema: z
      .object({
        connected: z.boolean(),
        rows: z.array(looseObjectOutputSchema),
        totalCount: z.number(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  handler: withMcpProjectAuth(async (args: LandingArgs, context) => {
    const filters: AnalyticsFilters = {};
    if (args.channel) filters.channel = args.channel;
    if (args.device) filters.device = args.device;
    if (args.country) filters.country = args.country;
    const result = await AnalyticsService.getLandingPages({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      range: args.range ?? "last_28_days",
      limit: args.limit ?? 25,
      ...filters,
    });
    if (!result.connected) {
      return mcpResponse({
        text: notConnectedText(args.projectId),
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/analytics`,
        ),
        structuredContent: { connected: false, rows: [], totalCount: 0 },
      });
    }
    const rows = result.rows.slice(0, MCP_ROW_LIMIT);
    const text = [
      `${result.rows.length} landing pages (showing ${rows.length}):`,
      formatMcpTable(rows, LANDING_COLUMNS),
    ].join("\n");
    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/analytics`,
      ),
      structuredContent: {
        connected: true,
        rows,
        totalCount: result.rows.length,
      },
    });
  }),
};
