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
  type AnalyticsAcquisitionRow,
  type AnalyticsEventRow,
} from "@/server/features/ga4/services/AnalyticsService";
import { type AnalyticsRange } from "@/types/schemas/ga4";
import {
  analyticsMcpFilterShape as filterShape,
  MCP_ROW_LIMIT,
  notConnectedText,
  rangeSchema,
  type AnalyticsMcpFilters as AnalyticsFilters,
} from "./analytics-tools";

// Spec 010 (plan section 4 cross-cutting): thin acquisition/events/conversion
// readers over the same AnalyticsService as the analytics page server fns.
// DB-first with coverage states; no independent MCP logic (P1.5).

type OverviewArgs = {
  projectId: string;
  range?: AnalyticsRange;
  channel?: string;
  device?: "desktop" | "mobile" | "tablet";
  country?: string;
};

// ─── get_analytics_acquisition ───────────────────────────────────────────────
// Spec 010 (plan §4 cross-cutting): new thin service wrappers. Same
// AnalyticsService as the analytics page server fns — DB-first with coverage
// states; no independent MCP logic (P1.5).

const acquisitionInputSchema = {
  projectId: projectIdSchema,
  range: rangeSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MCP_ROW_LIMIT)
    .default(25)
    .describe(
      "Max acquisition rows to return (1-50, GSC-style agent bounding). Defaults to 25.",
    ),
  ...filterShape,
} as const;

type AcquisitionArgs = OverviewArgs & { limit?: number };

const ACQUISITION_COLUMNS: McpTableColumn<AnalyticsAcquisitionRow>[] = [
  { header: "channel", value: (row) => row.channelGroup },
  { header: "source", value: (row) => row.source },
  { header: "medium", value: (row) => row.medium },
  { header: "sessions", value: (row) => row.sessions.current },
  { header: "sessions Δ%", value: (row) => row.sessions.pctChange },
];

export const getAnalyticsAcquisitionTool = {
  name: "get_analytics_acquisition",
  config: {
    title: "Get analytics acquisition",
    description:
      "Get GA4 acquisition rows (channel/source/medium) with current-vs-previous deltas. DB-first; connect GA4 first when unconnected.",
    inputSchema: acquisitionInputSchema,
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
  handler: withMcpProjectAuth(async (args: AcquisitionArgs, context) => {
    const filters: AnalyticsFilters = {};
    if (args.channel) filters.channel = args.channel;
    if (args.device) filters.device = args.device;
    if (args.country) filters.country = args.country;
    const result = await AnalyticsService.getAcquisition({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      range: args.range ?? "last_28_days",
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
      `${result.rows.length} acquisition rows (showing ${rows.length}):`,
      formatMcpTable(rows, ACQUISITION_COLUMNS),
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

// ─── get_analytics_events ────────────────────────────────────────────────────

const eventsInputSchema = {
  projectId: projectIdSchema,
  range: rangeSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MCP_ROW_LIMIT)
    .default(25)
    .describe(
      "Max event rows to return (1-50, GSC-style agent bounding). Defaults to 25.",
    ),
  ...filterShape,
} as const;

type EventsArgs = OverviewArgs & { limit?: number };

const EVENTS_COLUMNS: McpTableColumn<AnalyticsEventRow>[] = [
  { header: "event", value: (row) => row.eventName },
  { header: "key", value: (row) => row.isKeyEvent },
  { header: "count", value: (row) => row.eventCount.current },
  { header: "count Δ%", value: (row) => row.eventCount.pctChange },
];

export const getAnalyticsEventsTool = {
  name: "get_analytics_events",
  config: {
    title: "Get analytics events",
    description:
      "Get GA4 event rows with current-vs-previous deltas. DB-first; connect GA4 first when unconnected.",
    inputSchema: eventsInputSchema,
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
  handler: withMcpProjectAuth(async (args: EventsArgs, context) => {
    const filters: AnalyticsFilters = {};
    if (args.channel) filters.channel = args.channel;
    if (args.device) filters.device = args.device;
    if (args.country) filters.country = args.country;
    const result = await AnalyticsService.getEvents({
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
      `${result.rows.length} events (showing ${rows.length}):`,
      formatMcpTable(rows, EVENTS_COLUMNS),
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

// ─── get_analytics_conversions ───────────────────────────────────────────────

const conversionsInputSchema = {
  projectId: projectIdSchema,
  range: rangeSchema,
  limit: z.coerce
    .number()
    .int()
    .min(1)
    .max(MCP_ROW_LIMIT)
    .default(25)
    .describe(
      "Max conversion rows to return (1-50, GSC-style agent bounding). Defaults to 25.",
    ),
  goalId: z
    .string()
    .min(1)
    .optional()
    .describe(
      "Optional conversion-goal id: scopes conversions to that goal's stored event binding. Unknown, archived, or other-project ids fail closed.",
    ),
  ...filterShape,
} as const;

type ConversionsArgs = OverviewArgs & { limit?: number; goalId?: string };

export const getAnalyticsConversionsTool = {
  name: "get_analytics_conversions",
  config: {
    title: "Get analytics conversions",
    description:
      "Get GA4 key-event conversions with current-vs-previous deltas, optionally scoped to one goal. DB-first; connect GA4 first when unconnected.",
    inputSchema: conversionsInputSchema,
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
  handler: withMcpProjectAuth(async (args: ConversionsArgs, context) => {
    const filters: AnalyticsFilters = {};
    if (args.channel) filters.channel = args.channel;
    if (args.device) filters.device = args.device;
    if (args.country) filters.country = args.country;
    const result = await AnalyticsService.getConversions({
      projectId: args.projectId,
      organizationId: context.auth.organizationId,
      range: args.range ?? "last_28_days",
      limit: args.limit ?? 25,
      ...(args.goalId ? { goalId: args.goalId } : {}),
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
      `${result.rows.length} conversions (showing ${rows.length}):`,
      formatMcpTable(rows, EVENTS_COLUMNS),
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
