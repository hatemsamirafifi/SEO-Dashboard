import { z } from "zod";
import { buildProjectMeta } from "@/server/mcp/context";
import { mcpResponse } from "@/server/mcp/formatters";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";
import { buildDashboardUrl } from "@/server/mcp/urls";
import { collectPaidSearch } from "@/server/features/reports/services/reportSections";

// Read-only Google Ads overview (master plan phase 6): a stored-ads reader
// over the synced analytics units. No mutations, no API calls — the tool
// reads the same frozen evidence the report payload uses.

type Kpi = {
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
};
type PaidTotals = Kpi & {
  conversions: number | null;
  conversionsValue: number | null;
  ctr: number | null;
  cpc: number | null;
  cpa: number | null;
  roas: number | null;
};
type PaidRow = {
  key: string;
  status: string | null;
  totals: Kpi;
};

const OVERVIEW_COLUMNS: McpTableColumn<PaidRow>[] = [
  { header: "key", value: (row) => row.key },
  {
    header: "status",
    value: (row) => row.status ?? "—",
  },
  {
    header: "impressions",
    value: (row) => row.totals.impressions ?? "—",
  },
  { header: "clicks", value: (row) => row.totals.clicks ?? "—" },
  { header: "cost", value: (row) => row.totals.cost ?? "—" },
];

function money(value: number | null, currency: string | null): string {
  if (value === null) return "—";
  return value.toFixed(2) + (currency ? ` ${currency}` : "");
}

function count(value: number | null): string {
  return value === null ? "—" : String(value);
}

function kpiLine(totals: PaidTotals, currency: string | null): string {
  return (
    `impressions ${count(totals.impressions)}, clicks ${count(totals.clicks)}, ` +
    `cost ${money(totals.cost, currency)}, conversions ${count(totals.conversions)}, ` +
    `conversions value ${money(totals.conversionsValue, currency)}, ` +
    `CTR ${totals.ctr === null ? "—" : `${(totals.ctr * 100).toFixed(1)}%`}, ` +
    `CPC ${money(totals.cpc, currency)}, CPA ${money(totals.cpa, currency)}, ` +
    `ROAS ${totals.roas === null ? "—" : `${totals.roas.toFixed(2)}x`}`
  );
}

/** Yesterday-anchored UTC window of `days` days. */
function paidWindowUtc(days: number): { startDate: string; endDate: string } {
  const day = 24 * 60 * 60 * 1000;
  const end = new Date(Date.now() - day);
  const start = new Date(end.getTime() - (days - 1) * day);
  return {
    startDate: start.toISOString().slice(0, 10),
    endDate: end.toISOString().slice(0, 10),
  };
}

const overviewInputSchema = {
  projectId: projectIdSchema,
  days: z
    .number()
    .int()
    .min(1)
    .max(90)
    .optional()
    .describe(
      "Window length in days, ending yesterday UTC (default 28, max 90).",
    ),
} as const;

type OverviewArgs = z.infer<z.ZodObject<typeof overviewInputSchema>>;

export const getGoogleAdsOverviewTool = {
  name: "get_google_ads_overview",
  config: {
    title: "Get Google Ads overview",
    description:
      "Summarize the project's connected Google Ads account from synced stored analytics: spend, clicks, impressions, conversions (with currency), plus top campaigns and search terms by cost, and an equal-length preceding-window comparison when both windows are fully covered. Read-only; uses no credits. First connect Google Ads on the project settings page.",
    inputSchema: overviewInputSchema,
    outputSchema: {
      ok: z.boolean(),
      reason: z.string().optional(),
      connectUrl: z.string().optional(),
      startDate: z.string().optional(),
      endDate: z.string().optional(),
      currencyCode: z.string().nullable().optional(),
      metricDateBasis: z.string().nullable().optional(),
      totals: z
        .object({
          impressions: z.number().nullable(),
          clicks: z.number().nullable(),
          cost: z.number().nullable(),
          conversions: z.number().nullable(),
          conversionsValue: z.number().nullable(),
          ctr: z.number().nullable(),
          cpc: z.number().nullable(),
          cpa: z.number().nullable(),
          roas: z.number().nullable(),
        })
        .nullable()
        .optional(),
      previousTotals: z
        .object({
          impressions: z.number().nullable(),
          clicks: z.number().nullable(),
          cost: z.number().nullable(),
          conversions: z.number().nullable(),
          conversionsValue: z.number().nullable(),
          ctr: z.number().nullable(),
          cpc: z.number().nullable(),
          cpa: z.number().nullable(),
          roas: z.number().nullable(),
        })
        .nullable()
        .optional(),
      campaigns: z
        .array(
          z
            .object({
              campaignResourceId: z.string(),
              name: z.string().nullable(),
              status: z.string().nullable(),
              totals: z
                .object({
                  impressions: z.number().nullable(),
                  clicks: z.number().nullable(),
                  cost: z.number().nullable(),
                })
                .passthrough(),
            })
            .passthrough(),
        )
        .optional(),
      searchTerms: z
        .array(
          z
            .object({
              searchText: z.string(),
              totals: z
                .object({
                  impressions: z.number().nullable(),
                  clicks: z.number().nullable(),
                  cost: z.number().nullable(),
                })
                .passthrough(),
            })
            .passthrough(),
        )
        .optional(),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: OverviewArgs, context) => {
    const connectUrl = buildDashboardUrl(
      context.baseUrl,
      `/p/${args.projectId}/settings`,
    );
    const meta = buildProjectMeta(
      context,
      args.projectId,
      `/p/${args.projectId}/settings`,
    );
    const window = paidWindowUtc(args.days ?? 28);
    const paid = await collectPaidSearch(
      args.projectId,
      context.auth.organizationId,
      window.startDate,
      window.endDate,
    );
    if (!paid.status.available) {
      return mcpResponse({
        text: `Google Ads is not available for this project (${paid.status.reason}). Connect it here: ${connectUrl}`,
        meta,
        structuredContent: {
          ok: true,
          reason: paid.status.reason,
          connectUrl,
        },
      });
    }
    const currency = paid.currencyCode;
    const totals = paid.totals;
    const header =
      `Google Ads · ${window.startDate}→${window.endDate}` +
      (currency ? ` · currency ${currency}` : "") +
      (paid.metricDateBasis
        ? ` · metric date basis: ${paid.metricDateBasis}`
        : "");
    if (!totals) {
      return mcpResponse({
        text: `${header}\nConnected, but no paid search data in this period.`,
        meta,
        structuredContent: {
          ok: true,
          startDate: window.startDate,
          endDate: window.endDate,
          currencyCode: currency,
          totals: null,
        },
      });
    }
    const lines: string[] = [header, `Totals: ${kpiLine(totals, currency)}`];
    if (paid.previousTotals) {
      lines.push(`Previous window: ${kpiLine(paid.previousTotals, currency)}`);
    }
    const campaigns = paid.campaigns.map((campaign) => ({
      key: campaign.name ?? campaign.campaignResourceId,
      status: campaign.status,
      totals: campaign.totals,
    }));
    const searchTerms = paid.searchTerms.map((term) => ({
      key: term.searchText,
      status: null as string | null,
      totals: term.totals,
    }));
    if (campaigns.length > 0) {
      lines.push("Top campaigns by cost:");
      lines.push(formatMcpTable(campaigns, OVERVIEW_COLUMNS));
    }
    if (searchTerms.length > 0) {
      lines.push("Top search terms by cost:");
      lines.push(formatMcpTable(searchTerms, OVERVIEW_COLUMNS));
    }
    return mcpResponse({
      text: lines.join("\n"),
      meta,
      structuredContent: {
        ok: true,
        startDate: window.startDate,
        endDate: window.endDate,
        currencyCode: currency,
        metricDateBasis: paid.metricDateBasis,
        totals,
        previousTotals: paid.previousTotals,
        campaigns: paid.campaigns,
        searchTerms: paid.searchTerms,
      },
    });
  }),
};
