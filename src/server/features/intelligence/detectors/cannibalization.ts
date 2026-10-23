import {
  canonicalCannibalizationPair,
  canonicalUrl,
} from "@/shared/intelligence";
import {
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";
import {
  cannibalizationExplanation,
  classifyCannibalization,
} from "./cannibalizationClassification";

/**
 * `cannibalization` (final-plan §4): ≥2 URLs earning impressions for the
 * same query in an overlapping window (GSC query_page grain, or rank
 * overlap). Always worded "potential": overlap is observed, intent is not.
 * GA4 absence carries no penalty.
 *
 * Spec 018 extends the detector (never rebuilds it) with an explicit tier per
 * candidate and a comparison against the immediately preceding window of the
 * same length. Tiers describe what was observed; they never claim intent.
 */

export type CannibalizationCandidate = {
  query: string;
  /** Impression-descending URLs with parallel impression counts. */
  urls: string[];
  urlImpressions: number[];
  queryImpressions: number;
  topShare: number;
  factIds: string[];
  /** True when the pair comes from rank overlap without GSC facts. */
  rankWitnessOnly: boolean;
  /**
   * Observed query-set overlap between the two top URLs (0-1): the share of
   * the smaller query set both URLs serve. 1 means identical query spaces.
   */
  urlQueryOverlap: number;
  /** Distinct queries observed for each of the two top URLs. */
  urlQueryCounts: [number, number];
  /** URLs that served this query in the preceding window. */
  priorUrls: string[];
  /** True when the preceding window is covered (synced, or enough fact days). */
  priorCovered: boolean;
  /** URLs serving the query now but not before, and before but not now. */
  shiftedIn: string[];
  shiftedOut: string[];
};

export type CannibalizationInput = {
  periodFrom: string;
  periodTo: string;
  periodFromPrior: string;
  periodToPrior: string;
  candidates: CannibalizationCandidate[];
  thresholds: Record<string, string | number | boolean>;
};

export function isCannibalizationInput(
  value: unknown,
): value is CannibalizationInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "candidates" in value &&
    Array.isArray(value.candidates) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "periodFromPrior" in value &&
    typeof value.periodFromPrior === "string" &&
    "periodToPrior" in value &&
    typeof value.periodToPrior === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export function normalizedPage(url: string | null): string | null {
  if (!url) return null;
  // One shared helper for grouping, keys, joins, and opportunities.
  return canonicalUrl(url);
}

export function detectCannibalization(
  ctx: DetectorContext,
  input: CannibalizationInput,
): FindingDraft[] {
  const minUrls = thresholdNumber(ctx.thresholds, "minUrls");
  const minImpressions = thresholdNumber(ctx.thresholds, "minImpressions");
  const dominantShare = thresholdNumber(ctx.thresholds, "dominantShare");
  const intentOverlapMax = thresholdNumber(ctx.thresholds, "intentOverlapMax");
  const findings: FindingDraft[] = [];
  for (const candidate of input.candidates) {
    // Both URLs above the impression floor. Rank-only witnesses carry no
    // GSC impressions — they still qualify as "potential" when the URL
    // count holds, labeled via partialData.
    const qualified = candidate.urls.filter(
      (_, index) =>
        candidate.rankWitnessOnly ||
        (candidate.urlImpressions[index] ?? 0) >= minImpressions,
    );
    if (qualified.length < minUrls) continue;
    const [first, second] = qualified.slice(0, 2);
    if (!first || !second) continue;
    const entityKey = canonicalCannibalizationPair(
      first,
      second,
      candidate.query,
    );
    const classification = classifyCannibalization(
      {
        rankWitnessOnly: candidate.rankWitnessOnly,
        priorCovered: candidate.priorCovered,
        shiftedInCount: candidate.shiftedIn.length,
        shiftedOutCount: candidate.shiftedOut.length,
        urlQueryOverlap: candidate.urlQueryOverlap,
        topShare: candidate.topShare,
      },
      { dominantShare, intentOverlapMax },
    );
    findings.push({
      entityKey,
      entity: {
        query: candidate.query,
        urlA: first,
        urlB: second,
        classification: classification.tier,
      },
      explanationFact: cannibalizationExplanation(classification.tier, {
        query: candidate.query,
        first,
        second,
        window: `${input.periodFrom}..${input.periodTo}`,
        priorWindow: `${input.periodFromPrior}..${input.periodToPrior}`,
        urlQueryOverlap: candidate.urlQueryOverlap,
        topShare: candidate.topShare,
      }),
      evidence: {
        metrics: {
          queryImpressions: candidate.queryImpressions,
          urlCount: candidate.urls.length,
          topShare: candidate.topShare,
          classification: classification.tier,
          urlQueryOverlap: Number(candidate.urlQueryOverlap.toFixed(3)),
          priorUrlCount: candidate.priorUrls.length,
          shiftedUrlCount:
            candidate.shiftedIn.length + candidate.shiftedOut.length,
        },
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: candidate.factIds.length > 0 ? ["gsc", "rank"] : ["rank"],
        sourceRefs: { gscFactIds: candidate.factIds },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: classification.partialData,
        confidenceInputs: {
          urlCount: candidate.urls.length,
          rankWitnessOnly: candidate.rankWitnessOnly,
          urlQueryOverlap: Number(candidate.urlQueryOverlap.toFixed(3)),
          priorCovered: candidate.priorCovered,
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: classification.confidence,
      coverageFlags: {
        queryPageCoverage: true,
        priorWindowCovered: candidate.priorCovered,
        classification: classification.tier,
      },
    });
  }
  return findings;
}

export const cannibalizationDetector: DetectorDef = {
  detectorKey: "cannibalization",
  version: 2,
  requiredSources: ["gsc"],
  optionalCorroborators: ["rank"],
  minConfidenceToEmit: 40,
  coverage: [{ source: "gsc", grains: ["query_page"], minCoverageRatio: 0.8 }],
  detect: (ctx, input) => {
    if (!isCannibalizationInput(input)) {
      throw new Error("cannibalization: mistyped input");
    }
    return detectCannibalization(ctx, input);
  },
};
