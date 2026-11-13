import {
  devicesCount,
  estimateRankCheckCredits,
  resolveRankCheckMethod,
  type RankCheckMethod,
} from "@/shared/rank-tracking";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

export function formatRankTrackingCost(
  config: Pick<RankTrackingConfig, "devices" | "serpDepth">,
  keywordCount: number,
) {
  // Estimates the cost of a manual "check now" for the config's full keyword
  // set. The method is resolved from the SAME rule the workflow uses
  // (resolveRankCheckMethod): a single keyword runs live, anything larger
  // runs through the cheaper Standard Queue.
  const method: RankCheckMethod = resolveRankCheckMethod(
    "manual",
    keywordCount,
  );
  const { costUsd, costCredits } = estimateRankCheckCredits(
    keywordCount,
    config.devices,
    config.serpDepth,
    method,
  );
  return {
    costUsd,
    costCredits,
    keywordCount,
    devicesCount: devicesCount(config.devices),
    method,
  };
}
