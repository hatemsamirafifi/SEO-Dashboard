// Pure arithmetic for stored Google Ads analytics: no I/O, no provider
// calls. Ratios are only derived from COMPLETE metric components — a
// partially-covered component reports null instead of a guessed ratio.
import type { GoogleAdsSums } from "../repositories/GoogleAdsAnalyticsRepository";
import type { GoogleAdsMetricTotal } from "../repositories/googleAdsAnalyticsModel";

/** Queries are capped so a runaway custom window cannot pull the whole
 *  account history (37 months matches the Google Ads API range cap). */
export const GOOGLE_ADS_MAX_WINDOW_MONTHS = 37;

export type GoogleAdsKpiMetric =
  | "impressions"
  | "clicks"
  | "cost"
  | "conversions"
  | "conversionsValue";

export type GoogleAdsKpiTotals = {
  impressions: number | null;
  clicks: number | null;
  /** account currency units; costMicros / 1e6 */
  cost: number | null;
  conversions: number | null;
  conversionsValue: number | null;
  /** clicks / impressions; only from complete components */
  ctr: number | null;
  /** cost / clicks */
  cpc: number | null;
  /** cost / conversions */
  cpa: number | null;
  /** conversionsValue / cost */
  roas: number | null;
};

export type GoogleAdsWindow = { startDate: string; endDate: string };

export function costFromMicros(micros: number | null): number | null {
  return micros === null ? null : micros / 1_000_000;
}

function totalOf(total: GoogleAdsMetricTotal): number | null {
  return total.total;
}

/** Divides two metric totals ONLY when both components are complete
 *  (present and free of missing sub-components). Zero denominators report
 *  null, never Infinity. */
export function ratioOrNull(
  numerator: GoogleAdsMetricTotal,
  denominator: GoogleAdsMetricTotal,
): number | null {
  if (numerator.total === null || denominator.total === null) return null;
  if (numerator.hasMissingComponents || denominator.hasMissingComponents) {
    return null;
  }
  if (denominator.total === 0) return null;
  return numerator.total / denominator.total;
}

export function kpisFromSums(sums: GoogleAdsSums): GoogleAdsKpiTotals {
  const cost = costFromMicros(totalOf(sums.costMicros));
  const ctr = ratioOrNull(sums.clicks, sums.impressions);
  const cpc =
    cost === null
      ? null
      : ratioOrNull2(
          cost,
          totalOf(sums.clicks),
          sums.clicks.hasMissingComponents,
        );
  // Conversions/value + cost ratios below follow the same completeness rule.
  const cpa =
    cost === null ||
    sums.conversions.hasMissingComponents ||
    sums.conversions.total === null
      ? null
      : sums.conversions.total === 0
        ? null
        : cost / sums.conversions.total;
  const roas =
    cost === null ||
    sums.conversionsValue.hasMissingComponents ||
    sums.conversionsValue.total === null ||
    cost === 0
      ? null
      : sums.conversionsValue.total / cost;
  return {
    impressions: totalOf(sums.impressions),
    clicks: totalOf(sums.clicks),
    cost,
    conversions: totalOf(sums.conversions),
    conversionsValue: totalOf(sums.conversionsValue),
    ctr,
    cpc,
    cpa,
    roas,
  };
}

function ratioOrNull2(
  cost: number,
  denominator: number | null,
  denominatorIncomplete: boolean,
): number | null {
  if (denominator === null || denominatorIncomplete || denominator === 0) {
    return null;
  }
  return cost / denominator;
}

function isGoogleAdsIsoDate(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(value);
}

function monthsSpan(window: GoogleAdsWindow): number {
  const [startYear, startMonth] = window.startDate.split("-").map(Number);
  const [endYear, endMonth] = window.endDate.split("-").map(Number);
  return endYear * 12 + endMonth - (startYear * 12 + startMonth) + 1;
}

/** Validates an ISO window and caps it at GOOGLE_ADS_MAX_WINDOW_MONTHS. */
export function assertGoogleAdsWindow(window: GoogleAdsWindow): void {
  if (
    !isGoogleAdsIsoDate(window.startDate) ||
    !isGoogleAdsIsoDate(window.endDate)
  ) {
    throw new Error("Expected ISO YYYY-MM-DD Google Ads window dates");
  }
  if (window.startDate > window.endDate) {
    throw new Error(
      "Google Ads window start date must not be after the end date",
    );
  }
  if (monthsSpan(window) > GOOGLE_ADS_MAX_WINDOW_MONTHS) {
    throw new Error(
      `Google Ads windows are capped at ${GOOGLE_ADS_MAX_WINDOW_MONTHS} months`,
    );
  }
}

export function googleAdsWindowDayCount(window: GoogleAdsWindow): number {
  const start = Date.parse(`${window.startDate}T00:00:00.000Z`);
  const end = Date.parse(`${window.endDate}T00:00:00.000Z`);
  return Math.round((end - start) / 86_400_000) + 1;
}

/** Equal-length window immediately preceding `window`. */
export function precedingGoogleAdsWindow(
  window: GoogleAdsWindow,
): GoogleAdsWindow {
  const days = googleAdsWindowDayCount(window);
  const prevTo = new Date(
    Date.parse(`${window.startDate}T00:00:00.000Z`) - 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const prevFrom = new Date(
    Date.parse(`${prevTo}T00:00:00.000Z`) - (days - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { startDate: prevFrom, endDate: prevTo };
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

export type GoogleAdsCoverageStatus =
  | "uncovered"
  | "covered-empty"
  | "covered"
  | "partial";

export type GoogleAdsCoverage = {
  status: GoogleAdsCoverageStatus;
  coveredDates: number;
  totalDates: number;
  firstCoveredDate: string | null;
  lastCoveredDate: string | null;
};

const COVERING_STATUSES = new Set(["success_with_data", "success_zero_rows"]);

export function googleAdsCoverageFromUnits(
  units: readonly {
    date: string;
    status: string;
    publishedGenerationId: string | null;
  }[],
  window: GoogleAdsWindow,
): GoogleAdsCoverage {
  const totalDates = googleAdsWindowDayCount(window);
  const coveredDates = new Set<string>();
  for (const unit of units) {
    if (
      unit.date >= window.startDate &&
      unit.date <= window.endDate &&
      COVERING_STATUSES.has(unit.status) &&
      unit.publishedGenerationId !== null
    ) {
      coveredDates.add(unit.date);
    }
  }
  const sorted = [...coveredDates].toSorted();
  let status: GoogleAdsCoverageStatus;
  if (coveredDates.size === 0) {
    status = "uncovered";
  } else if (coveredDates.size === totalDates) {
    status = units.some(
      (unit) =>
        COVERING_STATUSES.has(unit.status) &&
        unit.publishedGenerationId !== null &&
        unit.status === "success_with_data",
    )
      ? "covered"
      : "covered-empty";
  } else {
    status = "partial";
  }
  return {
    status,
    coveredDates: coveredDates.size,
    totalDates,
    firstCoveredDate: sorted.length ? sorted[0] : null,
    lastCoveredDate: sorted.length ? sorted[sorted.length - 1] : null,
  };
}

// ---------------------------------------------------------------------------
// Equal-length preceding comparison gate
// ---------------------------------------------------------------------------

export type GoogleAdsCompareGate =
  | { gate: "ready" }
  | {
      gate: "unavailable";
      reason:
        | "unequal_windows"
        | "partial_coverage"
        | "mixed_metric_date_basis";
    };

/** The preceding-window comparison is only meaningful when BOTH windows are
 *  FULLY covered (every day published) and everything runs on a single
 *  metricDateBasis (or none is recorded at all). */
export function googleAdsCompareGate(
  currentUnits: readonly {
    date: string;
    status: string;
    publishedGenerationId: string | null;
    metricDateBasis: string | null;
  }[],
  previousUnits: readonly {
    date: string;
    status: string;
    publishedGenerationId: string | null;
    metricDateBasis: string | null;
  }[],
  currentWindow: GoogleAdsWindow,
  previousWindow: GoogleAdsWindow,
): GoogleAdsCompareGate {
  if (
    googleAdsWindowDayCount(currentWindow) !==
    googleAdsWindowDayCount(previousWindow)
  ) {
    return { gate: "unavailable", reason: "unequal_windows" };
  }
  for (const [units, window] of [
    [currentUnits, currentWindow],
    [previousUnits, previousWindow],
  ] as const) {
    const coverage = googleAdsCoverageFromUnits(units, window);
    if (coverage.status !== "covered" && coverage.status !== "covered-empty") {
      return { gate: "unavailable", reason: "partial_coverage" };
    }
  }
  const bases = new Set<string | null>();
  for (const unit of [...currentUnits, ...previousUnits]) {
    if (
      COVERING_STATUSES.has(unit.status) &&
      unit.publishedGenerationId !== null
    ) {
      bases.add(unit.metricDateBasis);
      if (bases.size > 1) {
        return { gate: "unavailable", reason: "mixed_metric_date_basis" };
      }
    }
  }
  return { gate: "ready" };
}

export type GoogleAdsMetricDelta = {
  metric: GoogleAdsKpiMetric;
  current: number | null;
  previous: number | null;
  absoluteChange: number | null;
  pctChange: number | null;
};

function delta(
  metric: GoogleAdsKpiMetric,
  current: number | null,
  previous: number | null,
): GoogleAdsMetricDelta {
  const absoluteChange =
    current === null || previous === null ? null : current - previous;
  const pctChange =
    absoluteChange === null || previous === null || previous === 0
      ? null
      : (absoluteChange / previous) * 100;
  return { metric, current, previous, absoluteChange, pctChange };
}

export function googleAdsKpiDeltas(
  current: GoogleAdsKpiTotals,
  previous: GoogleAdsKpiTotals,
): GoogleAdsMetricDelta[] {
  return [
    delta("impressions", current.impressions, previous.impressions),
    delta("clicks", current.clicks, previous.clicks),
    delta("cost", current.cost, previous.cost),
    delta("conversions", current.conversions, previous.conversions),
    delta(
      "conversionsValue",
      current.conversionsValue,
      previous.conversionsValue,
    ),
  ];
}
