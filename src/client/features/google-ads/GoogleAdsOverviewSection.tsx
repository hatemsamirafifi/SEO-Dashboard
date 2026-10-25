import {
  compareGateCopy,
  coverageCopy,
  formatAdsCurrency,
  formatCount,
  formatDelta,
  formatPctChange,
  formatPercentRatio,
  formatRoas,
} from "./googleAdsCopy";
import type {
  GoogleAdsAnalyticsOverview,
  GoogleAdsMetricDeltaLike,
} from "./googleAdsTypes";

/** Overview section: KPI cards, the equal-length preceding-period comparison,
 *  the daily trend, and the coverage / freshness badge. All values come from
 *  the stored overview; missing metrics render as em dashes, never as
 *  fabricated zeros. */

export type GoogleAdsKpiKey =
  | "cost"
  | "impressions"
  | "clicks"
  | "ctr"
  | "cpc"
  | "conversions"
  | "conversionsValue"
  | "cpa"
  | "roas";

const KPI_DEFS: Array<{ label: string; key: GoogleAdsKpiKey }> = [
  { label: "Spend", key: "cost" },
  { label: "Impressions", key: "impressions" },
  { label: "Clicks", key: "clicks" },
  { label: "CTR", key: "ctr" },
  { label: "Avg CPC", key: "cpc" },
  { label: "Conversions", key: "conversions" },
  { label: "Conv. value", key: "conversionsValue" },
  { label: "CPA", key: "cpa" },
  { label: "ROAS", key: "roas" },
];

const DELTA_KEYS: GoogleAdsMetricDeltaLike["metric"][] = [
  "cost",
  "impressions",
  "clicks",
  "conversions",
  "conversionsValue",
];

function formatKpiValue(
  key: GoogleAdsKpiKey,
  value: number | null,
  currencyCode: string | null,
): string {
  if (key === "ctr") return formatPercentRatio(value);
  if (key === "roas") return formatRoas(value);
  if (
    key === "cost" ||
    key === "cpc" ||
    key === "cpa" ||
    key === "conversionsValue"
  ) {
    return formatAdsCurrency(value, currencyCode);
  }
  return formatCount(value);
}

/** Delta chips exist only for the five base metrics the comparison carries;
 *  derived ratios (CTR, CPC, CPA, ROAS) have no server-computed delta. */
export function googleAdsKpiDeltaFor(
  deltas: readonly GoogleAdsMetricDeltaLike[] | null,
  key: GoogleAdsKpiKey,
): GoogleAdsMetricDeltaLike | null {
  if (!deltas) return null;
  const metric = DELTA_KEYS.find((candidate) => candidate === key);
  return metric
    ? (deltas.find((delta) => delta.metric === metric) ?? null)
    : null;
}

function DeltaChip({
  delta,
  currencyCode,
}: {
  delta: GoogleAdsMetricDeltaLike;
  currencyCode: string | null;
}) {
  const isMoney =
    delta.metric === "cost" || delta.metric === "conversionsValue";
  const format = (value: number) =>
    isMoney ? formatAdsCurrency(value, currencyCode) : formatCount(value);
  return (
    <span className="mt-1 block text-xs text-base-content/70">
      vs{" "}
      <span className="font-medium text-base-content/90">
        {format(delta.previous ?? 0)}
      </span>{" "}
      <span
        className={
          (delta.absoluteChange ?? 0) >= 0 ? "text-success" : "text-error"
        }
      >
        ({formatDelta(delta.absoluteChange, format)},{" "}
        {formatPctChange(delta.pctChange)})
      </span>
    </span>
  );
}

function CoverageBadge({
  coverage,
  currencyCode,
  metricDateBasis,
}: {
  coverage: GoogleAdsAnalyticsOverview["coverage"];
  currencyCode: string | null;
  metricDateBasis: string | null;
}) {
  const copy = coverageCopy(coverage.status);
  const toneClass =
    copy.tone === "success"
      ? "border-success/30 bg-success/10 text-success"
      : copy.tone === "warning"
        ? "border-warning/30 bg-warning/10 text-warning"
        : "border-error/30 bg-error/10 text-error";
  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      <span
        className={`inline-flex items-center rounded-full border px-2.5 py-1 font-medium ${toneClass}`}
      >
        {copy.label}
      </span>
      <span className="text-base-content/60">
        {formatCount(coverage.coveredDates)}/{formatCount(coverage.totalDates)}{" "}
        days · Metric date basis: {metricDateBasis ?? "unknown"} · Currency:{" "}
        {currencyCode ?? "unknown"}
      </span>
    </div>
  );
}

function DailyTrend({
  daily,
  currencyCode,
}: {
  daily: GoogleAdsAnalyticsOverview["daily"];
  currencyCode: string | null;
}) {
  return (
    <div className="overflow-x-auto pt-1">
      <h3 className="mb-2 text-sm font-semibold">Daily spend & conversions</h3>
      <table className="table table-sm min-w-[26rem]">
        <thead>
          <tr>
            <th>Date</th>
            <th className="text-right">Spend</th>
            <th className="text-right">Conversions</th>
          </tr>
        </thead>
        <tbody>
          {daily.map((point) => (
            <tr key={point.date}>
              <td>{point.date}</td>
              <td className="text-right font-mono text-xs">
                {formatAdsCurrency(point.totals.cost, currencyCode)}
              </td>
              <td className="text-right font-mono text-xs">
                {formatCount(point.totals.conversions)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function GoogleAdsOverviewSection({
  overview,
  currencyCode,
  metricDateBasis,
}: {
  overview: GoogleAdsAnalyticsOverview;
  currencyCode: string | null;
  metricDateBasis?: string | null;
}) {
  const gateNote = compareGateCopy(overview.compare.gate);
  return (
    <section className="space-y-4 px-4 pt-4 sm:px-6" aria-label="Overview">
      <div className="flex flex-wrap items-center gap-3">
        <h2 className="text-base font-semibold">Overview</h2>
        <CoverageBadge
          coverage={overview.coverage}
          currencyCode={currencyCode}
          metricDateBasis={metricDateBasis ?? null}
        />
      </div>
      {gateNote ? (
        <div className="space-y-1">
          <p className="text-xs text-base-content/60">{gateNote}</p>
          {overview.compare.window ? (
            <p className="text-xs text-base-content/50">
              Preceding equal-length window: {overview.compare.window.startDate}{" "}
              – {overview.compare.window.endDate}
            </p>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-3">
        {KPI_DEFS.map((kpi) => {
          const value = overview.totals[kpi.key] ?? null;
          const delta =
            overview.compare.gate === "ready"
              ? googleAdsKpiDeltaFor(overview.compare.deltas, kpi.key)
              : null;
          return (
            <div
              key={kpi.key}
              className="rounded-xl border border-base-300 bg-base-100 px-4 py-3"
            >
              <div className="text-xs text-base-content/60">{kpi.label}</div>
              <div className="text-xl font-bold">
                {formatKpiValue(kpi.key, value, currencyCode)}
              </div>
              {delta ? (
                <DeltaChip delta={delta} currencyCode={currencyCode} />
              ) : null}
            </div>
          );
        })}
      </div>
      <DailyTrend daily={overview.daily} currencyCode={currencyCode} />
    </section>
  );
}
