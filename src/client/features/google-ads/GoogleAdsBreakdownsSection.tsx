import { Eye, AlertTriangle } from "lucide-react";
import { coverageCopy, formatAdsCurrency, formatCount } from "./googleAdsCopy";
import type {
  GoogleAdsCampaignBreakdown,
  GoogleAdsDeviceBreakdown,
  GoogleAdsKeywordBreakdown,
  GoogleAdsLandingPageBreakdown,
  GoogleAdsSearchTermBreakdown,
  GoogleAdsKpiTotals,
} from "./googleAdsTypes";

/** Breakdown tables per published grain. Each grain carries its own
 *  coverage/meta: a partial grain, a mixed metric-date-basis window, or an
 *  unknown currency is labeled on the grain itself and never presented as
 *  complete. Totals come from stored sums; missing numbers render as em
 *  dashes. */

function KpiCells({
  totals,
  currencyCode,
}: {
  totals: GoogleAdsKpiTotals;
  currencyCode: string | null;
}) {
  return (
    <>
      <td className="text-right font-mono text-xs">
        {formatCount(totals.impressions)}
      </td>
      <td className="text-right font-mono text-xs">
        {formatCount(totals.clicks)}
      </td>
      <td className="text-right font-mono text-xs">
        {formatAdsCurrency(totals.cost, currencyCode)}
      </td>
      <td className="text-right font-mono text-xs">
        {formatCount(totals.conversions)}
      </td>
      <td className="text-right font-mono text-xs">
        {formatAdsCurrency(totals.conversionsValue, currencyCode)}
      </td>
    </>
  );
}

const KPI_HEADERS = (
  <>
    <th className="text-right">Impr.</th>
    <th className="text-right">Clicks</th>
    <th className="text-right">Cost</th>
    <th className="text-right">Conv.</th>
    <th className="text-right">Conv. value</th>
  </>
);

function GrainHeader({
  title,
  breakdown,
}: {
  title: string;
  breakdown:
    | GoogleAdsCampaignBreakdown
    | GoogleAdsKeywordBreakdown
    | GoogleAdsSearchTermBreakdown
    | GoogleAdsDeviceBreakdown
    | GoogleAdsLandingPageBreakdown
    | null;
}) {
  const coverage = breakdown?.coverage ?? null;
  const copy = coverage
    ? {
        ...coverageCopy(coverage.status),
        covered: coverage.coveredDates,
        total: coverage.totalDates,
      }
    : null;
  const toneClass =
    copy?.tone === "success"
      ? "text-success"
      : copy?.tone === "warning"
        ? "text-warning"
        : copy
          ? "text-error"
          : "";
  return (
    <div className="mb-2 flex flex-wrap items-center gap-2">
      <h3 className="text-sm font-semibold">{title}</h3>
      {copy ? (
        <span className={`text-xs ${toneClass}`}>
          {copy.label} ({formatCount(copy.covered)}/{formatCount(copy.total)}{" "}
          days)
        </span>
      ) : null}
      {breakdown?.metricDateBasis ? (
        <span className="text-xs text-base-content/50">
          date basis: {breakdown.metricDateBasis}
        </span>
      ) : null}
      {breakdown?.currencyCode ? (
        <span className="text-xs text-base-content/50">
          currency: {breakdown.currencyCode}
        </span>
      ) : null}
    </div>
  );
}

function RowBadge({ value }: { value: string | null }) {
  if (!value) return null;
  return (
    <span className="badge badge-ghost badge-sm ml-1 normal-case">{value}</span>
  );
}

export function GoogleAdsBreakdownsSection({
  campaigns,
  keywords,
  searchTerms,
  devices,
  landingPages,
  currencyCode,
}: {
  campaigns: GoogleAdsCampaignBreakdown | null;
  keywords: GoogleAdsKeywordBreakdown | null;
  searchTerms: GoogleAdsSearchTermBreakdown | null;
  devices: GoogleAdsDeviceBreakdown | null;
  landingPages: GoogleAdsLandingPageBreakdown | null;
  currencyCode: string | null;
}) {
  return (
    <div className="space-y-6 p-4 sm:p-6" aria-label="Breakdowns">
      <section aria-label="Campaigns">
        <GrainHeader title="Campaigns" breakdown={campaigns} />
        <div className="overflow-x-auto">
          <table className="table table-sm min-w-[52rem]">
            <thead>
              <tr>
                <th>Campaign</th>
                {KPI_HEADERS}
              </tr>
            </thead>
            <tbody>
              {(campaigns?.campaigns ?? []).map((row) => (
                <tr key={row.campaignResourceId}>
                  <td>
                    <span className="font-medium">
                      {row.campaignName ?? row.campaignResourceId}
                    </span>
                    <RowBadge value={row.campaignStatus} />
                  </td>
                  <KpiCells totals={row.totals} currencyCode={currencyCode} />
                </tr>
              ))}
              {campaigns && campaigns.campaigns.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-base-content/60">
                    No campaign rows for this window yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Keywords">
        <GrainHeader title="Keywords" breakdown={keywords} />
        <div className="overflow-x-auto">
          <table className="table table-sm min-w-[48rem]">
            <thead>
              <tr>
                <th>Keyword</th>
                {KPI_HEADERS}
              </tr>
            </thead>
            <tbody>
              {(keywords?.keywords ?? []).map((row) => (
                <tr key={row.keywordResourceId}>
                  <td>
                    <span className="font-medium">
                      {row.keywordText ?? row.keywordResourceId}
                    </span>
                    <RowBadge value={row.keywordMatchType} />
                  </td>
                  <KpiCells totals={row.totals} currencyCode={currencyCode} />
                </tr>
              ))}
              {keywords && keywords.keywords.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-base-content/60">
                    No keyword rows for this window yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Search terms">
        <GrainHeader title="Search terms" breakdown={searchTerms} />
        {searchTerms ? (
          <div role="alert" className="alert alert-warning py-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span className="text-xs">
              Google can withhold search terms above the aggregate level. These
              numbers are a floor, not a census — rows may be missing from the
              source itself.
            </span>
          </div>
        ) : null}
        <div className="overflow-x-auto">
          <table className="table table-sm min-w-[52rem]">
            <thead>
              <tr>
                <th>Search term</th>
                <th>Matched keyword</th>
                {KPI_HEADERS}
              </tr>
            </thead>
            <tbody>
              {(searchTerms?.searchTerms ?? []).map((row, index) => (
                <tr
                  key={`${row.campaignResourceId}:${row.adGroupResourceId}:${row.searchText}:${index}`}
                >
                  <td>{row.searchText}</td>
                  <td>
                    {row.keywordText ? (
                      <>
                        {row.keywordText}
                        <RowBadge value={row.keywordMatchType} />
                      </>
                    ) : null}
                  </td>
                  <KpiCells totals={row.totals} currencyCode={currencyCode} />
                </tr>
              ))}
              {searchTerms && searchTerms.searchTerms.length === 0 ? (
                <tr>
                  <td colSpan={7} className="text-base-content/60">
                    No search-term rows for this window.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Devices">
        <GrainHeader title="Devices" breakdown={devices} />
        <div className="overflow-x-auto">
          <table className="table table-sm min-w-[40rem]">
            <thead>
              <tr>
                <th>Device</th>
                {KPI_HEADERS}
              </tr>
            </thead>
            <tbody>
              {(devices?.devices ?? []).map((row) => (
                <tr key={row.device}>
                  <td className="capitalize">{row.device}</td>
                  <KpiCells totals={row.totals} currencyCode={currencyCode} />
                </tr>
              ))}
              {devices && devices.devices.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-base-content/60">
                    No device rows for this window yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>

      <section aria-label="Landing pages">
        <GrainHeader title="Landing pages" breakdown={landingPages} />
        <div className="overflow-x-auto">
          <table className="table table-sm min-w-[52rem]">
            <thead>
              <tr>
                <th>Landing page</th>
                {KPI_HEADERS}
              </tr>
            </thead>
            <tbody>
              {(landingPages?.landingPages ?? []).map((row) => (
                <tr key={row.landingPageUrl}>
                  <td>
                    <span className="flex items-center gap-1">
                      <Eye className="size-3.5 shrink-0 text-base-content/50" />
                      <span className="truncate font-mono text-xs">
                        {row.landingPageUrl}
                      </span>
                    </span>
                  </td>
                  <KpiCells totals={row.totals} currencyCode={currencyCode} />
                </tr>
              ))}
              {landingPages && landingPages.landingPages.length === 0 ? (
                <tr>
                  <td colSpan={6} className="text-base-content/60">
                    No landing-page rows for this window yet.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
