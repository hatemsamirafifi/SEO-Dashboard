import { Loader2 } from "lucide-react";
import * as React from "react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { GoogleAdsConnectionCard } from "./GoogleAdsConnectionCard";
import { GoogleAdsSyncStatus } from "./GoogleAdsSyncStatus";
import { GoogleAdsStateBanner } from "./GoogleAdsStateViews";
import { GoogleAdsDataView, type GoogleAdsFilters } from "./GoogleAdsDataView";
import {
  formatCount,
  resolveGoogleAdsWindow,
  toGoogleAdsPageView,
} from "./googleAdsCopy";
import { useGoogleAdsQueries } from "./useGoogleAdsQueries";

/** Google Ads page. One page view classification drives every state; the
 *  always-visible toolbar stays honest even while a query is pending. */

const INITIAL_FILTERS: GoogleAdsFilters = {
  preset: "last_28_days",
  startDate: null,
  endDate: null,
  searchTextLike: "",
  campaignResourceId: "",
};

type GoogleAdsBreakdownEnvelope<TFrame> =
  | { connected: true; breakdown: TFrame }
  | { connected: false; breakdown: null }
  | undefined;

function pickEnvelope<TFrame>(
  value: GoogleAdsBreakdownEnvelope<TFrame>,
): TFrame | null {
  return value?.connected === true ? value.breakdown : null;
}

/** Picks the per-grain breakdowns out of the query envelopes without
 *  duplicating the connected check five times inline. */
function pickBreakdowns(queries: ReturnType<typeof useGoogleAdsQueries>) {
  return {
    campaigns: pickEnvelope(queries.campaignsQuery.data),
    keywords: pickEnvelope(queries.keywordsQuery.data),
    searchTerms: pickEnvelope(queries.searchTermsQuery.data),
    devices: pickEnvelope(queries.devicesQuery.data),
    landingPages: pickEnvelope(queries.landingPagesQuery.data),
  };
}

export function GoogleAdsPage({ projectId }: { projectId: string }) {
  const [filters, setFilters] =
    React.useState<GoogleAdsFilters>(INITIAL_FILTERS);

  const window = resolveGoogleAdsWindow({
    preset: filters.preset,
    startDate: filters.startDate,
    endDate: filters.endDate,
  });

  const queries = useGoogleAdsQueries(projectId, {
    startDate: window.startDate,
    endDate: window.endDate,
    searchTextLike: filters.searchTextLike || undefined,
    campaignResourceId: filters.campaignResourceId || undefined,
  });

  const { connectionQuery, syncStatusQuery, overviewQuery } = queries;
  const connected = queries.connected;
  const syncData = syncStatusQuery.data;
  const syncState = syncData?.connected === true ? syncData.syncState : null;
  const overview =
    overviewQuery.data?.connected === true ? overviewQuery.data.overview : null;

  const view = toGoogleAdsPageView({
    connectionLoading: connectionQuery.isPending,
    connectionError: connectionQuery.isError,
    connected,
    activeRun: Boolean(syncState?.activeRun),
    latestRun: syncState?.runs[0] ?? null,
    unitsFailed: syncState?.units.failed ?? 0,
    coverageStatus: overview?.coverage.status ?? "none",
    coveredThrough: overview?.coverage.lastCoveredDate ?? null,
    rowCount: overview?.rowCount ?? null,
  });

  const dataUsable =
    overview !== null &&
    overview.coverage.status !== "uncovered" &&
    overview.coverage.status !== "covered-empty";

  const currencyCode =
    connectionQuery.data?.connected === true
      ? (connectionQuery.data.currencyCode ?? null)
      : null;

  const breakdowns = pickBreakdowns(queries);

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1">
            <h1 className="text-xl font-semibold">Google Ads</h1>
            <p className="text-sm text-base-content/60">
              Campaign spend, clicks and conversions from synced read-only data.
              Missing dates are excluded, never zeroed.
              {overview
                ? ` Window: ${overview.window.startDate} – ${overview.window.endDate} · ${formatCount(overview.rowCount)} rows`
                : ""}
            </p>
          </div>
          {connected ? (
            <div className="shrink-0 sm:mt-1">
              <GoogleAdsSyncStatus
                projectId={projectId}
                variant="header"
                connected={true}
              />
            </div>
          ) : null}
        </div>

        {view.kind === "loading" ? (
          <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" /> Loading Google Ads…
          </div>
        ) : view.kind === "error" ? (
          <div className="alert alert-error">
            <span className="text-sm">
              {getStandardErrorMessage(connectionQuery.error)}
            </span>
          </div>
        ) : view.kind === "not-connected" ? (
          <div className="max-w-2xl">
            <GoogleAdsConnectionCard projectId={projectId} />
          </div>
        ) : (view.kind === "quota-failed" ||
            view.kind === "perm-failed" ||
            view.kind === "sync-failed" ||
            view.kind === "syncing") &&
          !dataUsable ? (
          <div className="max-w-2xl space-y-4">
            <GoogleAdsStateBanner view={view} />
            <GoogleAdsSyncStatus projectId={projectId} connected={true} />
          </div>
        ) : view.kind === "no-data" ? (
          <div className="max-w-2xl space-y-4">
            <div className="rounded-xl border border-base-300 bg-base-100 p-6">
              <h2 className="font-semibold">No Google Ads data yet</h2>
              <p className="mt-1 text-sm text-base-content/60">
                Connect an account and run a sync. Zero-cost days appear as
                zeros only after their dates reach successful coverage — nothing
                is shown as fabricated values in the meantime.
              </p>
            </div>
            <GoogleAdsSyncStatus projectId={projectId} connected={true} />
          </div>
        ) : dataUsable && overview ? (
          <>
            <GoogleAdsStateBanner view={view} />
            <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
              <GoogleAdsDataView
                overview={overview}
                currencyCode={currencyCode}
                filters={filters}
                setFilters={setFilters}
                campaigns={breakdowns.campaigns}
                breakdowns={breakdowns}
                isFetching={queries.isFetchingSome}
              />
            </div>
          </>
        ) : (
          <div className="max-w-2xl space-y-4">
            <GoogleAdsStateBanner view={view} />
            <GoogleAdsSyncStatus projectId={projectId} connected={true} />
          </div>
        )}
      </div>
    </div>
  );
}
