// Stored Google Ads analytics service: reads ONLY already-published data via
// GoogleAdsAnalyticsRepository. No transport, no provider calls, no plaintext
// payloads. Aggregation semantics live in googleAdsAnalyticsMath.
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import type { GoogleAdsUnitScope } from "../repositories/googleAdsAnalyticsModel";
import {
  assertGoogleAdsWindow,
  googleAdsCompareGate,
  googleAdsCoverageFromUnits,
  googleAdsKpiDeltas,
  kpisFromSums,
  precedingGoogleAdsWindow,
  type GoogleAdsCoverage,
  type GoogleAdsKpiTotals,
  type GoogleAdsWindow,
} from "./googleAdsAnalyticsMath";

export const GOOGLE_ADS_OVERVIEW_GRAIN = "account" as const;

export type GoogleAdsAnalyticsOverviewInput = {
  scope: GoogleAdsUnitScope;
  window: GoogleAdsWindow;
  /** When set, adds an equal-length preceding-window comparison gated on
   *  full coverage + a single metricDateBasis (see googleAdsCompareGate). */
  compare?: boolean;
};

export type GoogleAdsAnalyticsDailyPoint = {
  date: string;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsCompareGateReason =
  | "ready"
  | "unequal_windows"
  | "partial_coverage"
  | "mixed_metric_date_basis";

export type GoogleAdsAnalyticsCompare = {
  window: GoogleAdsWindow | null;
  gate: GoogleAdsCompareGateReason;
  deltas: ReturnType<typeof googleAdsKpiDeltas> | null;
};

export type GoogleAdsAnalyticsOverview = {
  window: GoogleAdsWindow;
  coverage: GoogleAdsCoverage;
  totals: GoogleAdsKpiTotals;
  rowCount: number;
  daily: GoogleAdsAnalyticsDailyPoint[];
  compare: GoogleAdsAnalyticsCompare;
};

/** Overview reads are computed against the account grain only: other grains
 *  (per-campaign, per-keyword, …) keep their own sums functions. */
function accountUnitsIn(
  units: readonly {
    date: string;
    grain: string;
    status: string;
    publishedGenerationId: string | null;
    metricDateBasis: string | null;
  }[],
  window: GoogleAdsWindow,
) {
  return units.filter(
    (unit) =>
      unit.grain === GOOGLE_ADS_OVERVIEW_GRAIN &&
      unit.date >= window.startDate &&
      unit.date <= window.endDate,
  );
}

export async function getOverview(
  input: GoogleAdsAnalyticsOverviewInput,
): Promise<GoogleAdsAnalyticsOverview> {
  assertGoogleAdsWindow(input.window);
  const window: GoogleAdsWindow = {
    startDate: input.window.startDate,
    endDate: input.window.endDate,
  };

  const currentUnits = accountUnitsIn(
    await GoogleAdsAnalyticsRepository.listUnits(input.scope, {
      grains: [GOOGLE_ADS_OVERVIEW_GRAIN],
      startDate: window.startDate,
      endDate: window.endDate,
    }),
    window,
  );
  const coverage = googleAdsCoverageFromUnits(currentUnits, window);
  const currentSums = await GoogleAdsAnalyticsRepository.sumAccountWindow(
    input.scope,
    window,
  );
  const totals = kpisFromSums(currentSums);

  let compare: GoogleAdsAnalyticsCompare = {
    window: null,
    gate: "partial_coverage",
    deltas: null,
  };
  if (input.compare === true) {
    const previousWindow = precedingGoogleAdsWindow(window);
    const previousUnits = accountUnitsIn(
      await GoogleAdsAnalyticsRepository.listUnits(input.scope, {
        grains: [GOOGLE_ADS_OVERVIEW_GRAIN],
        startDate: previousWindow.startDate,
        endDate: previousWindow.endDate,
      }),
      previousWindow,
    );
    const gate = googleAdsCompareGate(
      currentUnits,
      previousUnits,
      window,
      previousWindow,
    );
    if (gate.gate === "ready") {
      const previousSums = await GoogleAdsAnalyticsRepository.sumAccountWindow(
        input.scope,
        previousWindow,
      );
      compare = {
        window: previousWindow,
        gate: "ready",
        deltas: googleAdsKpiDeltas(totals, kpisFromSums(previousSums)),
      };
    } else {
      compare = {
        window: previousWindow,
        gate: gate.gate === "unavailable" ? gate.reason : "partial_coverage",
        deltas: null,
      };
    }
  }

  const daily = await GoogleAdsAnalyticsRepository.sumAccountByDate(
    input.scope,
    window,
  );
  return {
    window,
    coverage,
    totals,
    rowCount: currentSums.rowCount,
    daily: daily.map((point) => ({
      date: point.date,
      totals: kpisFromSums(point.sums),
    })),
    compare,
  };
}
