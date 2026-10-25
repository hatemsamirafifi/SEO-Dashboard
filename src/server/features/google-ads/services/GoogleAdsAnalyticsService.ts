// Stored Google Ads analytics service: reads ONLY already-published data via
// GoogleAdsAnalyticsRepository. No transport, no provider calls, no plaintext
// payloads. Aggregation semantics live in googleAdsAnalyticsMath.
//
// IMPORTER CONTRACT: breakdown reads live in googleAdsAnalyticsBreakdowns
// and are re-exported here to keep the public surface stable.
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import type { GoogleAdsUnitScope } from "../repositories/googleAdsAnalyticsModel";
import {
  GoogleAdsSyncRepository,
  type GoogleAdsSyncRunPublic,
} from "../repositories/GoogleAdsSyncRepository";
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

export * from "./googleAdsAnalyticsBreakdowns";

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

// ---------------------------------------------------------------------------
// Sync state (durable ledger + published unit counts)
// ---------------------------------------------------------------------------

export type GoogleAdsUnitLedgerCounts = {
  total: number;
  pending: number;
  successWithData: number;
  successZeroRows: number;
  partial: number;
  failed: number;
};

export type GoogleAdsSyncState = {
  runs: GoogleAdsSyncRunPublic[];
  activeRun: GoogleAdsSyncRunPublic | null;
  units: GoogleAdsUnitLedgerCounts;
};

/** The account's durable sync state: recent runs (fingerprint/lease/grant
 *  fields never enter the public shape) plus the aggregate unit ledger the
 *  coverage cards are built from. */
export async function getSyncState(
  scope: GoogleAdsUnitScope,
): Promise<GoogleAdsSyncState> {
  const [runs, units] = await Promise.all([
    GoogleAdsSyncRepository.getRunHistory(scope, { limit: 5 }),
    GoogleAdsAnalyticsRepository.listUnits(scope, {}),
  ]);
  const counts: GoogleAdsUnitLedgerCounts = {
    total: units.length,
    pending: 0,
    successWithData: 0,
    successZeroRows: 0,
    partial: 0,
    failed: 0,
  };
  for (const unit of units) {
    switch (unit.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "success_with_data":
        counts.successWithData += 1;
        break;
      case "success_zero_rows":
        counts.successZeroRows += 1;
        break;
      case "partial":
        counts.partial += 1;
        break;
      case "failed":
        counts.failed += 1;
        break;
    }
  }
  const activeRun = runs.find(
    (run) => run.status === "pending" || run.status === "running",
  );
  return { runs, activeRun: activeRun ?? null, units: counts };
}
