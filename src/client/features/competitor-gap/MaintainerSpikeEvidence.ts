// Spec 014: Evidence formatting and display data types for Maintainer Spike UI
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapVerdict,
} from "@/shared/competitorGap";
import type { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";

export type VerdictStatusDisplayData = {
  verdict: CompetitorGapVerdict | null;
  gateState: "NO_VERDICT" | "BLOCKED" | "READY";
  verdictId?: string;
  recordedAt?: string;
  evidence?: CompetitorGapSpikeEvidence;
  thresholds?: typeof FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds;
  previousVerdict?: {
    verdict: CompetitorGapVerdict;
    verdictId: string;
    recordedAt: string;
  } | null;
};

/** Helper to extract and format the required dimensions from evidence */
export function formatSpikeEvidence(evidence?: CompetitorGapSpikeEvidence) {
  if (!evidence) return null;

  const quality = evidence.quality;
  const coverage = evidence.coverage;
  const cost = evidence.cost;
  const identity = evidence.identity;
  const cache = evidence.cache;

  const unavailableDimensions: string[] = [];
  if (quality.status === "unavailable") {
    unavailableDimensions.push(`Quality (${quality.reason})`);
  }
  if (coverage.status === "unavailable") {
    unavailableDimensions.push(`Coverage (${coverage.reason})`);
  }
  if (cost.status === "unavailable") {
    unavailableDimensions.push(`Cost (${cost.reason})`);
  }
  if (identity.status === "unavailable") {
    unavailableDimensions.push(`Identity (${identity.reason})`);
  }
  if (cache.status === "unavailable") {
    unavailableDimensions.push(`Cache (${cache.reason})`);
  }

  return {
    keywordCoverageRatio:
      quality.status === "measured"
        ? `${(quality.value.keywordCoverageRatio * 100).toFixed(1)}%`
        : "unavailable",
    firstPartyCoverageRatio:
      coverage.status === "measured"
        ? `${(coverage.value.firstPartyCoverageRatio * 100).toFixed(1)}%`
        : "unavailable",
    costPerAnalysisCredits:
      cost.status === "measured"
        ? `${cost.value.measuredCreditsPerAnalysis} credits`
        : "unavailable",
    repeatCacheHitRate:
      cache.status === "measured"
        ? `${(cache.value.repeatCacheHitRate * 100).toFixed(1)}%`
        : "unavailable",
    repeatAnalysisPaidCalls:
      cache.status === "measured"
        ? String(cache.value.repeatAnalysisPaidCalls)
        : "unavailable",
    identityCollisions:
      identity.status === "measured"
        ? String(identity.value.collisionsObserved)
        : "unavailable",
    identityDeterministic:
      identity.status === "measured"
        ? identity.value.nonDeterministicMappings === 0
          ? "YES"
          : "NO"
        : "unavailable",
    unavailableDimensions:
      unavailableDimensions.length > 0
        ? unavailableDimensions.join(", ")
        : "None (all dimensions measured)",
  };
}
