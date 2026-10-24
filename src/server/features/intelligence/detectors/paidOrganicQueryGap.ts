import { canonicalKeyword } from "@/shared/intelligence";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  GoogleAdsAnalyticsRepository,
  type GoogleAdsSearchTermTotals,
} from "@/server/features/google-ads/repositories/GoogleAdsAnalyticsRepository";
import {
  googleAdsUnitRefs,
  loadGoogleAdsCoverage,
  type GoogleAdsCoverageLoad,
} from "./googleAdsCoverage";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * `paid_organic_query_gap` (master plan phase 5): paid search terms with
 * stored cost/conversion evidence whose organic visibility is weak — no GSC
 * facts, a striking-distance position (>= 11), or impressions below the
 * floor. Set-tier aggregate keyed by canonical term, like striking_distance.
 * Paid and organic figures stay on distinct fields: cost is raw base micros
 * in the account currency (mirrored), never a converted rate, and paid
 * metrics sit on the unit-declared metric-date basis.
 */

export type PaidQueryGapTerm = {
  query: string;
  /** Raw base micros summed from search-term facts (account currency). */
  paidCostMicros: number;
  paidClicks: number;
  /** null = rows with missing conversion components (unknown, never 0). */
  paidConversions: number | null;
  organicClicks: number;
  organicImpressions: number;
  organicAvgPosition: number | null;
  hasOrganicFacts: boolean;
};

export type PaidQueryGapInput = {
  periodFrom: string;
  periodTo: string;
  currencyCode: string | null;
  metricDateBasis: string | null;
  coverageRatio: number;
  googleAdsUnitIds: string[];
  terms: PaidQueryGapTerm[];
  thresholds: Record<string, string | number | boolean>;
};

export function isPaidQueryGapInput(
  value: unknown,
): value is PaidQueryGapInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "terms" in value &&
    Array.isArray(value.terms) &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

/**
 * Strong paid engagement signal: stored conversions meet the floor, or cost
 * is at or above the floor (undetected-conversion rows still count on cost).
 */
export function hasPaidSignal(
  paid: { paidCostMicros: number; paidConversions: number | null },
  minCostMicros: number,
  minConversions: number,
): boolean {
  if (paid.paidConversions !== null && paid.paidConversions >= minConversions) {
    return true;
  }
  return paid.paidCostMicros >= minCostMicros;
}

/**
 * Organic weakness: absent from GSC, striking-distance position (>= the
 * band floor), or below the impression floor — the same canonical bands the
 * striking_distance detector treats as workable organic demand.
 */
export function isOrganicallyWeak(
  term: {
    hasOrganicFacts: boolean;
    organicAvgPosition: number | null;
    organicImpressions: number;
  },
  minImpressions: number,
  minPosition: number,
): boolean {
  if (!term.hasOrganicFacts) return true;
  if (
    term.organicAvgPosition !== null &&
    term.organicAvgPosition >= minPosition
  ) {
    return true;
  }
  return term.organicImpressions < minImpressions;
}

/** Windowed sum of one paid search-term aggregate kept currency-agnostic. */
function sumPaidTerm(sums: GoogleAdsSearchTermTotals["sums"]): {
  costMicros: number;
  clicks: number;
  conversions: number | null;
} {
  // Incomplete totals stay unknown — never presented as complete numeric
  // totals (repository invariant), so conversions only surface when every
  // summed row reported them.
  const conversions =
    sums.conversions === null || sums.conversions.hasMissingComponents
      ? null
      : sums.conversions.total;
  return {
    costMicros: sums.costMicros.total ?? 0,
    clicks: sums.clicks.total ?? 0,
    conversions,
  };
}

function describeOrganicWeakness(
  term: PaidQueryGapTerm,
  thresholds: PaidQueryGapInput["thresholds"],
): string[] {
  const states: string[] = [];
  if (!term.hasOrganicFacts) {
    states.push("has no search-console facts in the same window");
  } else {
    const minOrganicPosition = thresholdNumber(
      thresholds,
      "minOrganicPosition",
    );
    const minOrganicImpressions = thresholdNumber(
      thresholds,
      "minOrganicImpressions",
    );
    if (
      term.organicAvgPosition !== null &&
      term.organicAvgPosition >= minOrganicPosition
    ) {
      states.push(
        `holds an organic average position of ${term.organicAvgPosition.toFixed(1)}`,
      );
    }
    if (term.organicImpressions < minOrganicImpressions) {
      states.push(
        `earned only ${term.organicImpressions.toLocaleString("en-US")} organic impressions`,
      );
    }
  }
  return states;
}

export async function fetchPaidOrganicQueryGapInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<PaidQueryGapInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const minPaidCostMicros = thresholdNumber(
    ctx.thresholds,
    "minPaidCostMicros",
  );
  const minPaidConversions = thresholdNumber(
    ctx.thresholds,
    "minPaidConversions",
  );
  const minOrganicImpressions = thresholdNumber(
    ctx.thresholds,
    "minOrganicImpressions",
  );
  const minOrganicPosition = thresholdNumber(
    ctx.thresholds,
    "minOrganicPosition",
  );

  // GSC anchors the window (deterministic, never wall clock) and gates
  // cheaply before any Ads read.
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "query",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "paid_organic_query_gap: no GSC query facts",
    );
  }
  const coverage: GoogleAdsCoverageLoad = await loadGoogleAdsCoverage({
    projectId,
    organizationId: ctx.organizationId,
    grains: ["search_term"],
    windowDays,
    minCoverageRatio: minCoverage,
    anchorDate: latestDate,
  });
  const [gscRows, paidTerms] = await Promise.all([
    GscSearchPerformanceRepository.getDailyGrainFacts(
      projectId,
      "query",
      coverage.window.from,
      coverage.window.to,
    ),
    GoogleAdsAnalyticsRepository.sumSearchTermWindow(coverage.scope, {
      startDate: coverage.window.from,
      endDate: coverage.window.to,
    }),
  ]);

  const organicByTerm = new Map<
    string,
    { clicks: number; impressions: number; positionWeighted: number }
  >();
  for (const row of gscRows) {
    if (!row.query) continue;
    const term = canonicalKeyword(row.query);
    const entry = organicByTerm.get(term) ?? {
      clicks: 0,
      impressions: 0,
      positionWeighted: 0,
    };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    entry.positionWeighted += row.impressions * (row.position ?? 0);
    organicByTerm.set(term, entry);
  }

  const terms: PaidQueryGapTerm[] = [];
  for (const paid of paidTerms) {
    const query = canonicalKeyword(paid.searchText);
    const paidTotals = sumPaidTerm(paid.sums);
    if (
      !hasPaidSignal(
        {
          paidCostMicros: paidTotals.costMicros,
          paidConversions: paidTotals.conversions,
        },
        minPaidCostMicros,
        minPaidConversions,
      )
    ) {
      continue;
    }
    const organic = organicByTerm.get(query);
    const organicImpressions = organic?.impressions ?? 0;
    const organicClicks = organic?.clicks ?? 0;
    const organicAvgPosition =
      organic && organicImpressions > 0
        ? organic.positionWeighted / organicImpressions
        : null;
    const gapTerm: PaidQueryGapTerm = {
      query,
      paidCostMicros: paidTotals.costMicros,
      paidClicks: paidTotals.clicks,
      paidConversions: paidTotals.conversions,
      organicClicks,
      organicImpressions,
      organicAvgPosition,
      hasOrganicFacts: organic !== undefined,
    };
    if (isOrganicallyWeak(gapTerm, minOrganicImpressions, minOrganicPosition)) {
      terms.push(gapTerm);
    }
  }
  terms.sort((a, b) => (a.query < b.query ? -1 : 1));

  return {
    periodFrom: coverage.window.from,
    periodTo: coverage.window.to,
    currencyCode: coverage.currencyCode,
    metricDateBasis: coverage.metricDateBasis,
    coverageRatio: coverage.coverageRatio,
    googleAdsUnitIds: googleAdsUnitRefs(coverage, ["search_term"]),
    terms,
    thresholds: {
      minWindowDays: windowDays,
      minCoverageRatio: minCoverage,
      minPaidCostMicros,
      minPaidConversions,
      minOrganicImpressions,
      minOrganicPosition,
    },
  };
}

function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export function detectPaidOrganicQueryGap(
  _ctx: DetectorContext,
  input: PaidQueryGapInput,
): FindingDraft[] {
  return input.terms.map((term) => ({
    entityKey: term.query,
    entity: { query: term.query },
    // Currency and metric-date basis are mirrors of stored account/unit
    // state, never derived conversions — cost stays raw base micros.
    explanationFact:
      `Paid search covered "${term.query}" with ` +
      `${term.paidCostMicros.toLocaleString("en-US")} micros of spend` +
      (term.paidConversions === null
        ? ""
        : ` and ${term.paidConversions.toLocaleString("en-US")} conversions`) +
      ` while organic ${describeOrganicWeakness(term, input.thresholds).join(" and ")}.`,
    evidence: {
      metrics: {
        paidCostMicros: term.paidCostMicros,
        paidClicks: term.paidClicks,
        ...(term.paidConversions !== null
          ? { paidConversions: term.paidConversions }
          : { paidConversionsUnreported: true }),
        organicImpressions: term.organicImpressions,
        organicClicks: term.organicClicks,
        hasOrganicFacts: term.hasOrganicFacts,
        ...(term.organicAvgPosition !== null
          ? { organicAvgPosition: round6(term.organicAvgPosition) }
          : {}),
      },
      periods: { from: input.periodFrom, to: input.periodTo },
      sources: ["google_ads", "gsc"],
      // Stored-evidence unit pointers, curated at fetch time.
      sourceRefs: { googleAdsUnitIds: input.googleAdsUnitIds },
      thresholdsApplied: input.thresholds,
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: {
        hasPaidSignal: true,
        hasOrganicFacts: term.hasOrganicFacts,
      },
    },
    detectedAt: new Date().toISOString(),
    confidenceScore: term.hasOrganicFacts ? 72 : 70,
    coverageFlags: {
      paidQueryCoverage: input.coverageRatio,
      organicQueryAlignment: true,
      currencyCode: input.currencyCode ?? "",
      metricDateBasis: input.metricDateBasis ?? "",
    },
  }));
}

export const paidOrganicQueryGapDetector: DetectorDef = {
  detectorKey: "paid_organic_query_gap",
  version: 1,
  requiredSources: ["google_ads", "gsc"],
  optionalCorroborators: [],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "google_ads", grains: ["search_term"], minCoverageRatio: 0.8 },
    { source: "gsc", grains: ["query"], minCoverageRatio: 1 },
  ],
  detect: (ctx, input) => {
    if (!isPaidQueryGapInput(input)) {
      throw new Error("paid_organic_query_gap: mistyped input");
    }
    return detectPaidOrganicQueryGap(ctx, input);
  },
};
