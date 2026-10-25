import type { ReportPayload } from "@/shared/reports";
import { PAID_SEARCH_SECTION_TITLE } from "@/shared/reports";
import {
  MetricCard,
  SectionShell,
} from "@/client/features/reports/ReportSections";

// Paid-search section, split out of ReportSections.tsx to keep counted lines
// under the max-lines budget. Pure formatters live at module scope so
// unicorn/consistent-function-scoping is satisfied.

function num(value: number | null): string {
  return value === null ? "—" : String(value);
}

function pct(value: number | null): string {
  return value === null ? "—" : `${(value * 100).toFixed(1)}%`;
}

function mult(value: number | null): string {
  return value === null ? "—" : `${value.toFixed(2)}x`;
}

export function PaidSearchSection({ payload }: { payload: ReportPayload }) {
  const paid = payload.paidSearch;
  if (!paid) return null;
  const totals = paid.totals;
  const prev = paid.previousTotals;
  const currency = paid.currencyCode;
  const money = (value: number | null) =>
    value === null ? "—" : value.toFixed(2) + (currency ? ` ${currency}` : "");
  return (
    <SectionShell title={PAID_SEARCH_SECTION_TITLE} status={paid.status}>
      {totals ? (
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          <MetricCard
            label="Impressions"
            value={num(totals.impressions)}
            previousValue={prev ? num(prev.impressions) : null}
          />
          <MetricCard
            label="Clicks"
            value={num(totals.clicks)}
            previousValue={prev ? num(prev.clicks) : null}
          />
          <MetricCard
            label="Cost"
            value={money(totals.cost)}
            previousValue={prev ? money(prev.cost) : null}
          />
          <MetricCard
            label="Conversions"
            value={num(totals.conversions)}
            previousValue={prev ? num(prev.conversions) : null}
          />
          <MetricCard
            label="Conversions value"
            value={money(totals.conversionsValue)}
            previousValue={prev ? money(prev.conversionsValue) : null}
          />
          <MetricCard
            label="CTR"
            value={pct(totals.ctr)}
            previousValue={prev ? pct(prev.ctr) : null}
          />
          <MetricCard label="CPC" value={money(totals.cpc)} />
          <MetricCard label="CPA" value={money(totals.cpa)} />
          <MetricCard label="ROAS" value={mult(totals.roas)} />
          {paid.metricDateBasis ? (
            <MetricCard
              label="Metric date basis"
              value={paid.metricDateBasis}
            />
          ) : null}
        </div>
      ) : (
        <p className="text-sm text-base-content/60">
          No paid search data in this period.
        </p>
      )}
      {paid.campaigns.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm">
          {paid.campaigns.map((campaign) => (
            <li
              key={campaign.campaignResourceId}
              className="rounded-lg border border-base-300 p-3"
            >
              <span className="badge badge-outline badge-sm">
                {campaign.status ?? "campaign"}
              </span>{" "}
              <span className="font-medium">
                {campaign.name ?? campaign.campaignResourceId}
              </span>
              <span className="block text-base-content/70">
                impressions {num(campaign.totals.impressions)} · clicks{" "}
                {num(campaign.totals.clicks)} · cost{" "}
                {money(campaign.totals.cost)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
      {paid.searchTerms.length > 0 ? (
        <ul className="mt-3 space-y-2 text-sm">
          {paid.searchTerms.map((term) => (
            <li
              key={term.searchText}
              className="rounded-lg border border-base-300 p-3"
            >
              <span className="badge badge-outline badge-sm">search term</span>{" "}
              <span className="font-medium">{term.searchText}</span>
              <span className="block text-base-content/70">
                impressions {num(term.totals.impressions)} · clicks{" "}
                {num(term.totals.clicks)} · cost {money(term.totals.cost)}
              </span>
            </li>
          ))}
        </ul>
      ) : null}
    </SectionShell>
  );
}
