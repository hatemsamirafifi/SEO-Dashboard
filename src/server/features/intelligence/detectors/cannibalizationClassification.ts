import type { CannibalizationClassification } from "@/shared/intelligence";

/**
 * Spec 018: the cannibalization verdict for one candidate. Every tier is a
 * label for what was observed in stored facts - never a claim about intent
 * that was not observed, and never a causal statement.
 */

type CannibalizationClassificationInput = {
  /** True when the pair comes from rank overlap without GSC facts. */
  rankWitnessOnly: boolean;
  /** True when the preceding window is covered (synced, or enough fact days). */
  priorCovered: boolean;
  /** URLs serving the query now but not before. */
  shiftedInCount: number;
  /** URLs serving the query before but not now. */
  shiftedOutCount: number;
  /** Overlap coefficient of the two URLs' observed query sets (0-1). */
  urlQueryOverlap: number;
  /** Share of the query's observed impressions held by the top URL. */
  topShare: number;
};

type CannibalizationClassificationResult = {
  tier: CannibalizationClassification;
  confidence: number;
  partialData: string[];
};

const CANNIBALIZATION_CONFIDENCE: Record<
  CannibalizationClassification,
  number
> = {
  POSSIBLE_CANNIBALIZATION: 70,
  NEEDS_REVIEW: 55,
  INSUFFICIENT_DATA: 45,
  INTENT_DISTINCT: 40,
  NORMAL_URL_DIVERSITY: 40,
};

/**
 * Tier for one candidate, from observed facts only:
 * - rank-only witness: no GSC facts, nothing to classify;
 * - serving URLs changed between windows: the overlap is new or unstable;
 * - observed query sets barely overlap: the URLs serve different intents;
 * - one URL carries the query: normal URL diversity, not a conflict;
 * - otherwise: a possible cannibalization candidate.
 */
export function classifyCannibalization(
  input: CannibalizationClassificationInput,
  thresholds: { dominantShare: number; intentOverlapMax: number },
): CannibalizationClassificationResult {
  if (input.rankWitnessOnly) {
    return {
      tier: "INSUFFICIENT_DATA",
      confidence: CANNIBALIZATION_CONFIDENCE.INSUFFICIENT_DATA,
      partialData: ["rank_witness_only"],
    };
  }
  const partialData: string[] = [];
  if (!input.priorCovered) {
    partialData.push("prior_window_not_covered");
  }
  const shifted = input.shiftedInCount > 0 || input.shiftedOutCount > 0;
  if (input.priorCovered && shifted) {
    return {
      tier: "NEEDS_REVIEW",
      confidence: CANNIBALIZATION_CONFIDENCE.NEEDS_REVIEW,
      partialData: [...partialData, "query_page_shift"],
    };
  }
  if (input.urlQueryOverlap <= thresholds.intentOverlapMax) {
    return {
      tier: "INTENT_DISTINCT",
      confidence: CANNIBALIZATION_CONFIDENCE.INTENT_DISTINCT,
      partialData,
    };
  }
  if (input.topShare >= thresholds.dominantShare) {
    return {
      tier: "NORMAL_URL_DIVERSITY",
      confidence: CANNIBALIZATION_CONFIDENCE.NORMAL_URL_DIVERSITY,
      partialData,
    };
  }
  return {
    tier: "POSSIBLE_CANNIBALIZATION",
    confidence: CANNIBALIZATION_CONFIDENCE.POSSIBLE_CANNIBALIZATION,
    partialData,
  };
}

type CannibalizationExplanationParams = {
  query: string;
  first: string;
  second: string;
  window: string;
  priorWindow: string;
  urlQueryOverlap: number;
  topShare: number;
};

/** Tier-specific, fact-only prose. No causal verbs, no invented intent. */
export function cannibalizationExplanation(
  tier: CannibalizationClassification,
  params: CannibalizationExplanationParams,
): string {
  switch (tier) {
    case "POSSIBLE_CANNIBALIZATION":
      return (
        `Potential cannibalization: "${params.query}" is served by both ` +
        `${params.first} and ${params.second} in ${params.window} ` +
        `(overlap observed; intent not determined).`
      );
    case "INTENT_DISTINCT":
      return (
        `"${params.query}" is served by both ${params.first} and ` +
        `${params.second} in ${params.window}; their observed query sets ` +
        `overlap ${params.urlQueryOverlap.toFixed(2)}.`
      );
    case "NORMAL_URL_DIVERSITY":
      return (
        `"${params.query}" is served by both ${params.first} and ` +
        `${params.second} in ${params.window}; one URL holds ` +
        `${(params.topShare * 100).toFixed(0)}% of the observed impressions.`
      );
    case "NEEDS_REVIEW":
      return (
        `"${params.query}" is served by both ${params.first} and ` +
        `${params.second} in ${params.window}; the set of URLs serving this ` +
        `query differs from ${params.priorWindow}.`
      );
    case "INSUFFICIENT_DATA":
      return (
        `"${params.query}" is served by both ${params.first} and ` +
        `${params.second} in ${params.window}; the stored data does not ` +
        `classify this overlap.`
      );
  }
}
