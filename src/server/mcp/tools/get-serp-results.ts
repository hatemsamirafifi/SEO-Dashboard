import { z } from "zod";
import { canonicalUrl } from "@/shared/intelligence";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import type { SerpLiveItem } from "@/server/lib/dataforseo";
import { enrichCompetitiveMetrics } from "@/server/features/serp/serpEnrichment";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

type SerpItem = {
  type?: string | null;
  rank: number | null;
  title: string | null;
  url: string | null;
  domain: string | null;
  description: string | null;
  // Competitive enrichment overlay (spec 007, opt-in only).
  domainRank?: number | null;
  pageRank?: number | null;
  referringDomains?: number | null;
  backlinks?: number | null;
  metricStatus?: "available" | "partial" | "unavailable" | "failed";
};

const SERP_ITEM_COLUMNS: McpTableColumn<SerpItem>[] = [
  { header: "rank", value: (item) => item.rank },
  { header: "domain", value: (item) => item.domain },
  { header: "title", value: (item) => item.title },
  { header: "url", value: (item) => item.url },
];

const querySchema = z.object({
  keyword: z.string().min(1).describe("Search query to fetch the SERP for."),
  locationCode: locationCodeSchema.optional(),
  languageCode: languageCodeSchema.optional(),
});

const inputSchema = {
  projectId: projectIdSchema,
  includeCompetitiveMetrics: z
    .boolean()
    .optional()
    .describe(
      "Opt-in Top-10 competitive metrics (Domain Rank, Page Rank, referring domains, backlinks). " +
        "Defaults off: enabling it spends paid provider calls per uncached competitor (bounded: " +
        "Top-10 only, cached, coalesced). Base SERP results are unaffected either way.",
    ),
  queries: z
    .array(querySchema)
    .min(1)
    .max(10)
    .describe(
      "1-10 queries. Bulk-friendly — prefer this over multiple single-query calls.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

/**
 * Merge opt-in competitive metrics into the trimmed SERP items in place
 * (Top-10 only, by normalized identity). Rows without a match keep their
 * base fields — enrichment never removes or rewrites base data.
 */
async function mergeCompetitiveMetrics(
  items: SerpItem[],
  billingCustomer: BillingCustomerContext,
): Promise<void> {
  const enriched = await enrichCompetitiveMetrics({
    results: items.slice(0, 10).map((item, index) => ({
      position: item.rank ?? index + 1,
      url: item.url ?? "",
      domain: item.domain ?? "",
    })),
    billingCustomer,
  });
  const byIdentity = new Map(
    enriched.targets.map((entry) => [entry.target.identity, entry.metrics]),
  );
  for (const [index, item] of items.entries()) {
    if (index >= 10 || !item.url) continue;
    const metrics = byIdentity.get(canonicalUrl(item.url));
    if (!metrics) continue;
    item.domainRank = metrics.domainRank;
    item.pageRank = metrics.pageRank;
    item.referringDomains = metrics.referringDomains;
    item.backlinks = metrics.backlinks;
    item.metricStatus = metrics.status;
  }
}

export const getSerpResultsTool = {
  name: "get_serp_results",
  config: {
    title: "Get Google SERP results",
    description:
      "Fetch live Google organic search results for 1-10 keywords. Use this to inspect who ranks for a query, verify competitors, compare SERPs across keywords, or gather source URLs before content planning. Charges credits per keyword (~30-60 each). Does not save results to OpenSEO. Per-keyword errors don't fail the batch. The opt-in includeCompetitiveMetrics flag (default off) additionally enriches the Top-10 results per keyword with competitive metrics at extra credit cost.",
    inputSchema,
    outputSchema: {
      results: z.array(
        z.union([
          z
            .object({
              keyword: z.string(),
              ok: z.literal(true),
              items: z.array(
                z
                  .object({
                    type: z.string().nullable().optional(),
                    rank: z.number().nullable(),
                    title: z.string().nullable(),
                    url: z.string().nullable(),
                    domain: z.string().nullable(),
                    description: z.string().nullable(),
                  })
                  .passthrough(),
              ),
            })
            .passthrough(),
          z
            .object({
              keyword: z.string(),
              ok: z.literal(false),
              error: z.string(),
            })
            .passthrough(),
        ]),
      ),
      ...optionalMetaOutputSchema,
    },
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const router = getSeoDataRouter();
    const results = await Promise.all(
      args.queries.map(async (q) => {
        try {
          const market = resolveMarket(q, context.project);
          const response = await router.route<SerpLiveItem[]>({
            dataType: "serp",
            keyword: q.keyword,
            locationCode: market.locationCode,
            languageCode: market.languageCode,
            billingCustomer: context.billing,
          });
          const items = response.data;
          // Trim noise — return only essentials per item.
          const trimmed = items.slice(0, 20).map((item) => ({
            type: item.type,
            rank: item.rank_absolute ?? item.rank_group ?? null,
            title: item.title ?? null,
            url: item.url ?? null,
            domain: item.domain ?? null,
            description: item.description ?? null,
          }));
          // Opt-in Top-10 enrichment (spec 007): merged by normalized
          // identity, Top-10 only. Any failure degrades to unenriched items —
          // the base SERP response never fails because of enrichment.
          if (args.includeCompetitiveMetrics ?? false) {
            try {
              await mergeCompetitiveMetrics(trimmed, context.billing);
            } catch {
              // Base items stand as-is.
            }
          }
          return { keyword: q.keyword, ok: true as const, items: trimmed };
        } catch (error) {
          return {
            keyword: q.keyword,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `"${r.keyword}": FAILED — ${r.error}`;
          }
          if (r.items.length === 0) {
            return `"${r.keyword}" (0 results)`;
          }
          return `"${r.keyword}" (${r.items.length} results):\n${formatMcpTable(r.items, SERP_ITEM_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\n${okCount} of ${results.length} queries succeeded.`;

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/keywords`,
      ),
      structuredContent: { results },
    });
  }),
};
