import { z } from "zod";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import {
  looseObjectOutputSchema,
  optionalMetaOutputSchema,
} from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { formatMcpTable } from "@/server/mcp/table";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  comparePeriodSchema,
  type ComparePeriod,
} from "@/types/schemas/rank-tracking";
import {
  enrichRankResults,
  formatTargetLabel,
  RANK_RESULT_COLUMNS,
  toFlattenedRankRows,
  type TargetRow,
} from "./get-rank-tracker-format";

const inputSchema = {
  projectId: projectIdSchema,
  trackerId: z
    .string()
    .optional()
    .describe(
      "Rank tracker config ID. If omitted, lists all rank trackers in the project.",
    ),
  targetId: z
    .string()
    .uuid()
    .optional()
    .describe(
      "Optional tracking target ID (country/city/language/device) to scope results when trackerId is provided.",
    ),
  comparePeriod: comparePeriodSchema
    .optional()
    .describe(
      "Comparison period. Defaults to 'previous' (immediately preceding comparable same-provider, same-target observation). Use '7d', '30d', or '90d' only when an explicit multi-day historical baseline is requested.",
    ),
} as const;

type Args = z.infer<z.ZodObject<typeof inputSchema>>;

export const getRankTrackerTool = {
  name: "get_rank_tracker",
  config: {
    title: "Get rank tracker",
    description:
      "Read-only access to rank tracker configs and their latest results. With `trackerId`, returns config, targets, and the latest observation per keyword/device alongside its previous comparable same-provider, same-target observation (`previousComparablePosition`, `previousObservationDate`, `positionChange` where positive = improvement and negative = decline). SE Ranking's `providerChange` is kept separate from OpenSEO's `positionChange`. Period baselines (`periodBaselinePosition`) are separate from the immediately previous observation. Uses no credits — reads from OpenSEO state, no DataForSEO or paid SE Ranking call. To trigger a new check, use the dashboard.",
    inputSchema,
    outputSchema: z
      .object({
        configs: z.array(looseObjectOutputSchema).optional(),
        config: looseObjectOutputSchema.optional(),
        targets: z.array(looseObjectOutputSchema).optional(),
        results: looseObjectOutputSchema.optional(),
        targetResults: z.array(looseObjectOutputSchema).optional(),
        ...optionalMetaOutputSchema,
      })
      .passthrough(),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(async (args: Args, context) => {
    const targets = await RankTrackingTargetRepository.getTargetsForProject(
      args.projectId,
      true,
    );

    if (!args.trackerId) {
      const configs = await RankTrackingRepository.getConfigsForProject(
        args.projectId,
      );
      const targetsSummary =
        targets.length > 0
          ? `\nTracking Targets (${targets.length}):\n` +
            targets.map((t) => `- ${t.id}  ${formatTargetLabel(t)}`).join("\n")
          : "";

      const text =
        configs.length === 0
          ? "No rank trackers configured for this project."
          : `Rank trackers (${configs.length}):\n` +
            configs
              .map(
                (c) =>
                  `- ${c.id}  ${c.domain}  loc:${c.locationCode}  schedule:${c.scheduleInterval}`,
              )
              .join("\n") +
            targetsSummary;

      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/rank-tracking`,
        ),
        structuredContent: { configs, targets },
      });
    }

    const config = await RankTrackingRepository.getConfigById({
      configId: args.trackerId,
      projectId: args.projectId,
    });
    if (!config) {
      return mcpResponse({
        text: `Rank tracker ${args.trackerId} not found in project ${args.projectId}.`,
        meta: buildProjectMeta(context, args.projectId),
      });
    }

    const effectiveComparePeriod: ComparePeriod =
      args.comparePeriod ?? "previous";
    const configTargets = targets.filter(
      (t) => !t.trackingConfigId || t.trackingConfigId === config.id,
    );
    const targetById = new Map(targets.map((t) => [t.id, t]));
    const desktopTargets = configTargets.filter((t) => t.device === "desktop");
    const mobileTargets = configTargets.filter((t) => t.device === "mobile");
    const singleTargetByDevice: Partial<
      Record<"desktop" | "mobile", TargetRow>
    > = {
      desktop: desktopTargets.length === 1 ? desktopTargets[0] : undefined,
      mobile: mobileTargets.length === 1 ? mobileTargets[0] : undefined,
    };

    const hasMultipleTargetsSameDevice =
      !args.targetId && (desktopTargets.length > 1 || mobileTargets.length > 1);

    if (hasMultipleTargetsSameDevice) {
      const perTarget = await Promise.all(
        configTargets.map(async (target) => {
          const raw = await getLatestResults(
            args.trackerId!,
            args.projectId,
            effectiveComparePeriod,
            target.id,
          );
          const enriched = enrichRankResults(raw, targetById, {
            [target.device]: target,
          });
          return {
            target,
            results: enriched,
            flattened: toFlattenedRankRows(enriched.rows, target.device),
          };
        }),
      );

      const primaryResults = perTarget[0]?.results ?? { rows: [], run: null };
      const allFlattened = perTarget.flatMap((entry) => entry.flattened);
      const text = [
        `Tracker ${config.id} (${config.domain}):`,
        `Schedule: ${config.scheduleInterval}, devices: ${config.devices}, depth: ${config.serpDepth}, comparison: ${effectiveComparePeriod}`,
        `Latest run: ${primaryResults.run?.lastCheckedAt ?? "never"}`,
        `Targets: ${configTargets.map((t) => formatTargetLabel(t)).join(", ")}`,
        `Observations (${allFlattened.length}):`,
        allFlattened.length === 0
          ? "No keywords tracked yet."
          : formatMcpTable(allFlattened, RANK_RESULT_COLUMNS),
      ]
        .filter(Boolean)
        .join("\n");

      return mcpResponse({
        text,
        meta: buildProjectMeta(
          context,
          args.projectId,
          `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
        ),
        structuredContent: {
          config,
          targets: configTargets,
          results: primaryResults,
          targetResults: perTarget.map((p) => ({
            target: p.target,
            results: p.results,
          })),
        },
      });
    }

    const rawResults = args.targetId
      ? await getLatestResults(
          args.trackerId,
          args.projectId,
          effectiveComparePeriod,
          args.targetId,
        )
      : await getLatestResults(
          args.trackerId,
          args.projectId,
          effectiveComparePeriod,
        );

    const results = enrichRankResults(
      rawResults,
      targetById,
      singleTargetByDevice,
    );
    const scopedTarget = args.targetId
      ? targetById.get(args.targetId)
      : undefined;
    const flattened = toFlattenedRankRows(results.rows, scopedTarget?.device);
    const displayTargets = configTargets.length > 0 ? configTargets : targets;

    const text = [
      `Tracker ${config.id} (${config.domain}):`,
      `Schedule: ${config.scheduleInterval}, devices: ${config.devices}, depth: ${config.serpDepth}, comparison: ${effectiveComparePeriod}`,
      `Latest run: ${results.run?.lastCheckedAt ?? "never"}`,
      displayTargets.length > 0
        ? `Targets: ${displayTargets.map((t) => formatTargetLabel(t)).join(", ")}`
        : null,
      `Keywords (${results.rows.length}):`,
      flattened.length === 0
        ? "No keywords tracked yet."
        : formatMcpTable(flattened, RANK_RESULT_COLUMNS),
    ]
      .filter(Boolean)
      .join("\n");

    return mcpResponse({
      text,
      meta: buildProjectMeta(
        context,
        args.projectId,
        `/p/${args.projectId}/rank-tracking/${args.trackerId}`,
      ),
      structuredContent: { config, targets: displayTargets, results },
    });
  }),
};
