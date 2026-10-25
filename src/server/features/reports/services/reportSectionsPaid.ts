import {
  GoogleAdsAnalyticsRepository,
  type GoogleAdsCampaignTotals,
  type GoogleAdsSearchTermTotals,
  type GoogleAdsSums,
} from "@/server/features/google-ads/repositories/GoogleAdsAnalyticsRepository";
import { GoogleAdsConnectionRepository } from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";
import type { GoogleAdsMetricTotal } from "@/server/features/google-ads/repositories/googleAdsAnalyticsModel";
import {
  googleAdsCompareGate,
  googleAdsCoverageFromUnits,
  googleAdsKpiDeltas,
  kpisFromSums,
  precedingGoogleAdsWindow,
  type GoogleAdsKpiTotals,
  type GoogleAdsWindow,
} from "@/server/features/google-ads/services/googleAdsAnalyticsMath";
import type { PaidSearchPayload } from "@/shared/reports";

type Availability = { available: boolean; reason: string | null };

function unavailable(reason: string): Availability {
  return { available: false, reason };
}

const READY: Availability = { available: true, reason: null };

// ---------------------------------------------------------------------------
// Paid search (Google Ads) — DB-stored analytics only (master plan phase 6).
// ---------------------------------------------------------------------------

const ADS_COVERING_STATUSES = new Set([
  "success_with_data",
  "success_zero_rows",
]);

const TOP_PAID_ROWS = 5;

function paidUnavailable(reason: string): PaidSearchPayload {
  return {
    status: unavailable(reason),
    currencyCode: null,
    metricDateBasis: null,
    totals: null,
    previousTotals: null,
    deltas: [],
    campaigns: [],
    searchTerms: [],
  };
}

/** One value when every covering account unit in the window agrees on its
 *  metric date basis; null when mixed or absent. */
function observedMetricDateBasis(
  units: readonly {
    date: string;
    status: string;
    publishedGenerationId: string | null;
    metricDateBasis: string | null;
  }[],
  window: GoogleAdsWindow,
): string | null {
  const bases = new Set<string | null>();
  for (const unit of units) {
    if (
      unit.date >= window.startDate &&
      unit.date <= window.endDate &&
      ADS_COVERING_STATUSES.has(unit.status) &&
      unit.publishedGenerationId !== null
    ) {
      bases.add(unit.metricDateBasis);
    }
  }
  const values = [...bases];
  return values.length === 1 ? (values[0] ?? null) : null;
}

/** Additive aggregation across per-ad-group sums. A component missing in
 *  any group stays null — combined rows never guess — so derived ratios are
 *  null for the group as well. */
function combineSums(groups: readonly GoogleAdsSums[]): GoogleAdsSums {
  const combine = (
    pick: (sums: GoogleAdsSums) => GoogleAdsMetricTotal,
  ): GoogleAdsMetricTotal => {
    const selected = groups.map(pick);
    return {
      total:
        selected.some((entry) => entry.hasMissingComponents) ||
        selected.every((entry) => entry.total === null)
          ? null
          : selected.reduce<number>(
              (acc, entry) => acc + (entry.total ?? 0),
              0,
            ),
      hasMissingComponents: selected.some(
        (entry) => entry.hasMissingComponents,
      ),
    };
  };
  return {
    rowCount: groups.reduce((acc, group) => acc + group.rowCount, 0),
    impressions: combine((sums) => sums.impressions),
    clicks: combine((sums) => sums.clicks),
    costMicros: combine((sums) => sums.costMicros),
    conversions: combine((sums) => sums.conversions),
    conversionsValue: combine((sums) => sums.conversionsValue),
  };
}

/** By cost (micros) descending, nulls last, then resource id asc. */
function rankPaidCampaigns(
  rows: readonly GoogleAdsCampaignTotals[],
): PaidSearchPayload["campaigns"] {
  return rows
    .toSorted(
      (a, b) =>
        (b.sums.costMicros.total ?? -1) - (a.sums.costMicros.total ?? -1) ||
        (a.campaignResourceId < b.campaignResourceId
          ? -1
          : a.campaignResourceId > b.campaignResourceId
            ? 1
            : 0),
    )
    .slice(0, TOP_PAID_ROWS)
    .map((row) => ({
      campaignResourceId: row.campaignResourceId,
      name: row.campaignName,
      status: row.campaignStatus,
      totals: kpisFromSums(row.sums),
    }));
}

function rankPaidSearchTerms(
  rows: readonly GoogleAdsSearchTermTotals[],
): PaidSearchPayload["searchTerms"] {
  const byTerm = new Map<string, GoogleAdsSums[]>();
  for (const row of rows) {
    const groups = byTerm.get(row.searchText) ?? [];
    groups.push(row.sums);
    byTerm.set(row.searchText, groups);
  }
  return [...byTerm.entries()]
    .map(([searchText, groups]) => ({ searchText, sums: combineSums(groups) }))
    .toSorted(
      (a, b) =>
        (b.sums.costMicros.total ?? -1) - (a.sums.costMicros.total ?? -1) ||
        (a.searchText < b.searchText
          ? -1
          : a.searchText > b.searchText
            ? 1
            : 0),
    )
    .slice(0, TOP_PAID_ROWS)
    .map((entry) => ({
      searchText: entry.searchText,
      totals: kpisFromSums(entry.sums),
    }));
}

/** A window where every metric is null carries no data — render it as the
 *  covered-empty note instead of nine dashed rows. */
function hasAnyPaidMetric(totals: GoogleAdsKpiTotals): boolean {
  return (
    totals.impressions !== null ||
    totals.clicks !== null ||
    totals.cost !== null ||
    totals.conversions !== null ||
    totals.conversionsValue !== null
  );
}

/** Frozen paid-search section payload (stored-ads reader only): headline
 *  totals plus an equal-length preceding comparison measured only when BOTH
 *  windows are fully covered on a single metric date basis. */
export async function collectPaidSearch(
  projectId: string,
  organizationId: string,
  from: string,
  to: string,
): Promise<PaidSearchPayload> {
  const down = paidUnavailable("provider_failed");
  let previousTotals: GoogleAdsKpiTotals | null = null;
  try {
    const connection = await GoogleAdsConnectionRepository.getByProjectId(
      projectId,
      organizationId,
    );
    if (!connection) return paidUnavailable("not_connected");
    const scope = {
      projectId,
      organizationId,
      customerId: connection.customerId,
    };
    const window: GoogleAdsWindow = { startDate: from, endDate: to };
    const previousWindow = precedingGoogleAdsWindow(window);
    const [units, previousUnits] = await Promise.all([
      GoogleAdsAnalyticsRepository.listUnits(scope, {
        grains: ["account"],
        startDate: window.startDate,
        endDate: window.endDate,
      }),
      GoogleAdsAnalyticsRepository.listUnits(scope, {
        grains: ["account"],
        startDate: previousWindow.startDate,
        endDate: previousWindow.endDate,
      }),
    ]);
    const metricDateBasis = observedMetricDateBasis(units, window);
    const coverage = googleAdsCoverageFromUnits(units, window);
    if (coverage.status === "uncovered" || coverage.status === "partial") {
      return {
        ...paidUnavailable("no_coverage"),
        currencyCode: connection.currencyCode,
        metricDateBasis,
      };
    }
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(
      scope,
      window,
    );
    const totals = kpisFromSums(sums);
    if (!hasAnyPaidMetric(totals)) {
      return {
        status: READY,
        currencyCode: connection.currencyCode,
        metricDateBasis,
        totals: null,
        previousTotals: null,
        deltas: [],
        campaigns: [],
        searchTerms: [],
      };
    }
    const gate = googleAdsCompareGate(
      units,
      previousUnits,
      window,
      previousWindow,
    );
    if (gate.gate === "ready") {
      const previousSums = await GoogleAdsAnalyticsRepository.sumAccountWindow(
        scope,
        previousWindow,
      );
      previousTotals = kpisFromSums(previousSums);
    }
    return {
      status: READY,
      currencyCode: connection.currencyCode,
      metricDateBasis,
      totals,
      previousTotals,
      deltas:
        previousTotals === null
          ? []
          : googleAdsKpiDeltas(totals, previousTotals),
      campaigns: rankPaidCampaigns(
        await GoogleAdsAnalyticsRepository.sumCampaignWindow(scope, window),
      ),
      searchTerms: rankPaidSearchTerms(
        await GoogleAdsAnalyticsRepository.sumSearchTermWindow(scope, window),
      ),
    };
  } catch {
    return down;
  }
}

export type PaidMonthlyEnvelope = {
  status: Availability;
  totals: GoogleAdsKpiTotals | null;
};

export type PaidMonthlyEvidence = {
  month: PaidMonthlyEnvelope;
  prior: PaidMonthlyEnvelope;
  currencyCode: string | null;
};

/** Two-window paid totals for autopilot comparisons. Compared only when the
 *  equal-length editor gate is ready; absent for projects without a
 *  Google Ads connection (null, not an empty zero). */
export async function collectPaidMonthlyEvidence(
  projectId: string,
  organizationId: string,
  month: { from: string; to: string },
  prior: { from: string; to: string },
): Promise<PaidMonthlyEvidence | null> {
  const downEnvelope: PaidMonthlyEnvelope = {
    status: unavailable("provider_failed"),
    totals: null,
  };
  try {
    const connection = await GoogleAdsConnectionRepository.getByProjectId(
      projectId,
      organizationId,
    );
    if (!connection) return null;
    const scope = {
      projectId,
      organizationId,
      customerId: connection.customerId,
    };
    const monthWindow: GoogleAdsWindow = {
      startDate: month.from,
      endDate: month.to,
    };
    const priorWindow: GoogleAdsWindow = {
      startDate: prior.from,
      endDate: prior.to,
    };
    const [monthUnits, priorUnits] = await Promise.all([
      GoogleAdsAnalyticsRepository.listUnits(scope, {
        grains: ["account"],
        startDate: monthWindow.startDate,
        endDate: monthWindow.endDate,
      }),
      GoogleAdsAnalyticsRepository.listUnits(scope, {
        grains: ["account"],
        startDate: priorWindow.startDate,
        endDate: priorWindow.endDate,
      }),
    ]);
    const gate = googleAdsCompareGate(
      monthUnits,
      priorUnits,
      monthWindow,
      priorWindow,
    );
    if (gate.gate === "unavailable") {
      return {
        month: { status: unavailable(gate.reason), totals: null },
        prior: { status: unavailable(gate.reason), totals: null },
        currencyCode: connection.currencyCode,
      };
    }
    const [monthSums, priorSums] = await Promise.all([
      GoogleAdsAnalyticsRepository.sumAccountWindow(scope, monthWindow),
      GoogleAdsAnalyticsRepository.sumAccountWindow(scope, priorWindow),
    ]);
    const monthTotals = kpisFromSums(monthSums);
    const priorTotals = kpisFromSums(priorSums);
    const monthEmpty = !hasAnyPaidMetric(monthTotals);
    const priorEmpty = !hasAnyPaidMetric(priorTotals);
    return {
      month: {
        status: READY,
        totals: monthEmpty ? null : monthTotals,
      },
      prior: {
        status: READY,
        totals: priorEmpty ? null : priorTotals,
      },
      currencyCode: connection.currencyCode,
    };
  } catch {
    return {
      month: downEnvelope,
      prior: downEnvelope,
      currencyCode: null,
    };
  }
}
