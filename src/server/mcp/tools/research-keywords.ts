import { z } from "zod";
import { KeywordResearchService } from "@/server/features/keywords/services/KeywordResearchService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { resolveMarket } from "@/shared/keyword-locations";
import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";
import { assertLanguageForLocation } from "@/server/lib/market";
import {
  languageCodeSchema,
  locationCodeSchema,
  projectIdSchema,
} from "@/server/mcp/schemas";

const seedItemSchema = z
  .union([
    z.string().min(1).describe("Seed keyword as a plain string."),
    z
      .object({
        seed: z
          .string()
          .min(1)
          .optional()
          .describe("Seed keyword to research."),
        keyword: z
          .string()
          .min(1)
          .optional()
          .describe("Alternative key for seed keyword."),
        query: z
          .string()
          .min(1)
          .optional()
          .describe("Alternative key for seed keyword."),
        term: z
          .string()
          .min(1)
          .optional()
          .describe("Alternative key for seed keyword."),
        locationCode: locationCodeSchema.optional(),
        languageCode: languageCodeSchema.optional(),
      })
      .refine(
        (val) =>
          Boolean(
            (val.seed && val.seed.trim().length > 0) ||
            (val.keyword && val.keyword.trim().length > 0) ||
            (val.query && val.query.trim().length > 0) ||
            (val.term && val.term.trim().length > 0),
          ),
        { message: "Seed keyword is required" },
      ),
  ])
  .transform((val) => {
    if (typeof val === "string") {
      return { seed: val.trim() };
    }
    const raw = (val.seed ?? val.keyword ?? val.query ?? val.term)!.trim();
    return {
      seed: raw,
      locationCode: val.locationCode,
      languageCode: val.languageCode,
    };
  });

const seedsSchema = z
  .union([
    z.array(seedItemSchema).min(1),
    seedItemSchema.transform((single) => [single]),
  ])
  .transform((items) => items.slice(0, 20))
  .describe(
    "1-20 seed keywords (either plain strings or objects with seed/keyword). Each seed is researched independently and returns related keywords with volume/difficulty/CPC. Bulk-friendly.",
  );

const resultLimitSchema = z.coerce
  .number()
  .int()
  .positive()
  .max(1000)
  .optional()
  .describe(
    "Max keywords returned per seed (e.g. 50, 150, 300, 500, 1000). Defaults to 300.",
  );

const inputSchema = {
  projectId: projectIdSchema,
  seeds: seedsSchema,
  resultLimit: resultLimitSchema,
  includeClickstreamData: z
    .boolean()
    .optional()
    .describe(
      "Refine search volumes with clickstream data, which disaggregates Google Ads' grouped close-variant volumes (plurals/misspellings). Default false (standard Google-Ads-derived volumes).",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

type ResearchRow = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string;
};

// The full rows (including trend data) still ship in structuredContent; this
// table exists so MCP clients that surface only text content see every keyword
// and its metrics, not just the count summary.
const RESEARCH_COLUMNS: McpTableColumn<ResearchRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "KD", value: (row) => row.keywordDifficulty },
  { header: "CPC", value: (row) => row.cpc },
  { header: "competition", value: (row) => row.competition },
  { header: "intent", value: (row) => row.intent },
];

function snapResultLimit(limit?: number): 150 | 300 | 500 | 1000 {
  if (!limit) return 300;
  if (limit <= 150) return 150;
  if (limit <= 300) return 300;
  if (limit <= 500) return 500;
  return 1000;
}

export const researchKeywordsTool = {
  name: "research_keywords",
  config: {
    title: "Research keywords (bulk)",
    description:
      "Research keyword data (search volume, difficulty, CPC, related ideas) for up to 20 seed keywords in one call. Returns per-seed results with related keywords, volume, difficulty, and intent.",
    inputSchema,
    outputSchema: {
      results: z.array(
        z.union([
          z
            .object({
              seed: z.string(),
              ok: z.literal(true),
              rowCount: z.number(),
              source: z.string(),
              usedFallback: z.boolean(),
              rows: z.array(looseObjectOutputSchema),
            })
            .passthrough(),
          z
            .object({
              seed: z.string(),
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
    const results = await Promise.all(
      args.seeds.map(async (item) => {
        try {
          const { locationCode, languageCode } = resolveMarket(
            item,
            context.project,
          );
          assertLanguageForLocation(locationCode, languageCode);
          const data = await KeywordResearchService.research(
            {
              projectId: args.projectId,
              keywords: [item.seed],
              locationCode,
              languageCode,
              resultLimit: snapResultLimit(args.resultLimit),
              mode: "auto",
              clickstream: args.includeClickstreamData ?? false,
            },
            context.billing,
          );
          return {
            seed: item.seed,
            ok: true as const,
            rowCount: data.rows.length,
            source: data.source,
            usedFallback: data.usedFallback,
            rows: data.rows,
          };
        } catch (error) {
          return {
            seed: item.seed,
            ok: false as const,
            error: error instanceof Error ? error.message : String(error),
          };
        }
      }),
    );

    const okCount = results.filter((r) => r.ok).length;
    const failCount = results.length - okCount;
    const text =
      results
        .map((r) => {
          if (!r.ok) {
            return `## "${r.seed}" — FAILED\n${r.error}`;
          }
          const header = `## "${r.seed}" — ${r.rowCount} keywords (source: ${r.source}${r.usedFallback ? ", fallback" : ""})`;
          if (r.rowCount === 0) {
            return `${header}\n(no keywords returned)`;
          }
          return `${header}\n${formatMcpTable(r.rows, RESEARCH_COLUMNS)}`;
        })
        .join("\n\n") +
      `\n\nResearched ${okCount} of ${results.length} seeds${failCount > 0 ? ` (${failCount} failed)` : ""}. Columns: volume = monthly searches, KD = keyword difficulty (0-100), CPC in USD, competition = paid competition (0-1); "—" = unavailable.`;

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
