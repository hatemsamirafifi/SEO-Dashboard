import { devicesCount, estimateRankCheckCredits } from "@/shared/rank-tracking";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

export function formatRankTrackingCost(
  config: Pick<RankTrackingConfig, "devices" | "serpDepth">,
  keywordCount: number,
) {
  // Estimates the cost of a manual "check now", which always runs live.
  const { costUsd, costCredits } = estimateRankCheckCredits(
    keywordCount,
    config.devices,
    config.serpDepth,
    "live",
  );
  return {
    costUsd,
    costCredits,
    keywordCount,
    devicesCount: devicesCount(config.devices),
  };
}
