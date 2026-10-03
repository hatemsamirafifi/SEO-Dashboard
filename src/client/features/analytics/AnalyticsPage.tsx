import { useState } from "react";
import { Loader2 } from "lucide-react";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { AnalyticsRange } from "@/types/schemas/ga4";
import { AnalyticsConnectionCard } from "@/client/features/ga4/AnalyticsConnectionCard";
import { Ga4SyncStatus } from "@/client/features/ga4/Ga4SyncStatus";
import {
  ALL,
  AnalyticsFilterToolbar,
} from "@/client/features/analytics/AnalyticsFilterToolbar";
import {
  AcquisitionSection,
  CoverageBadge,
  LandingSection,
  OverviewSection,
} from "@/client/features/analytics/AnalyticsSections";
import {
  AudienceSection,
  ConversionsSection,
  EcommerceSection,
  EventsSection,
} from "@/client/features/analytics/AnalyticsExtendedSections";
import { toAnalyticsPageView } from "@/client/features/analytics/analyticsCopy";
import { GoalsManager } from "@/client/features/analytics/GoalsManager";
import { useAnalyticsQueries } from "./useAnalyticsQueries";

export function AnalyticsPage({ projectId }: { projectId: string }) {
  const [range, setRange] = useState<AnalyticsRange>("last_28_days");
  const [channel, setChannel] = useState("");
  const [device, setDevice] = useState<string>(ALL);
  const [country, setCountry] = useState("");
  // Spec 010: goal filter for the conversions view. Empty = all conversions.
  const [goalId, setGoalId] = useState("");

  const {
    connected,
    goalsState,
    connectionQuery,
    syncQuery,
    overviewQuery,
    acquisitionQuery,
    organicQuery,
    landingQuery,
    eventsQuery,
    conversionsQuery,
    ecommerceQuery,
    audienceQuery,
    isFetching,
  } = useAnalyticsQueries(projectId, {
    range,
    channel,
    device,
    country,
    goalId,
  });

  const overview = overviewQuery.data;
  const view = toAnalyticsPageView({    connectionLoading:
      connectionQuery.isPending ||
      (connectionQuery.data?.connected === true && syncQuery.isPending),
    syncLoading: false,
    connectionError: connectionQuery.isError,
    syncError: syncQuery.isError,
    connected,
    isRunning: syncQuery.data?.connected
      ? (syncQuery.data.isRunning ?? false)
      : false,
    latestSyncError:
      syncQuery.data?.connected && syncQuery.data.latestSync
        ? (syncQuery.data.latestSync.error ?? null)
        : null,
    coverageStatus:
      overview?.connected === true ? overview.coverage.status : "none",
    hasRows:
      overview?.connected === true &&
      (overview.totals.sessions.current > 0 || overview.trends.length > 0),
    coveredThrough:
      overview?.connected === true ? overview.coverage.coveredThrough : null,
  });

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <div>
          <h1 className="text-xl font-semibold">Analytics</h1>
          <p className="text-sm text-base-content/60">
            Google Analytics 4 traffic, read from synced data. DB-first with a
            freshness badge; provider failure is shown, never silently zeroed.
          </p>
        </div>

        {view.kind === "loading" ? (
          <div className="flex items-center gap-2 p-8 text-sm text-base-content/60">
            <Loader2 className="size-4 animate-spin" /> Loading Analytics…
          </div>
        ) : view.kind === "error" ? (
          <div className="alert alert-error">
            <span className="text-sm">
              {getStandardErrorMessage(
                connectionQuery.error ?? syncQuery.error,
              )}
            </span>
          </div>
        ) : view.kind === "not-connected" ? (
          <div className="max-w-2xl">
            <AnalyticsConnectionCard projectId={projectId} />
          </div>
        ) : view.kind === "syncing" ? (
          <div className="alert alert-info">
            <span className="text-sm">
              Syncing Analytics data… sections below show the last synced
              snapshot.
            </span>
          </div>
        ) : view.kind === "quota-failed" ? (
          <div className="alert alert-warning">
            <span className="text-sm">
              Analytics sync hit the Google quota and stopped early:{" "}
              {view.message} Data already synced stays visible.
            </span>
          </div>
        ) : view.kind === "perm-failed" ? (
          <div className="alert alert-error">
            <span className="text-sm">
              Analytics access failed and needs attention: {view.message}{" "}
              Reconnect the property in Settings.
            </span>
          </div>
        ) : view.kind === "sync-failed" ? (
          <div className="alert alert-error">
            <span className="text-sm">
              Last Analytics sync failed: {view.message} Previously synced data
              stays visible.
            </span>
          </div>
        ) : view.kind === "no-data" ? (
          <div className="max-w-2xl space-y-4">
            <div className="rounded-xl border border-base-300 bg-base-100 p-6">
              <h2 className="font-semibold">No Analytics data yet</h2>
              <p className="mt-1 text-sm text-base-content/60">
                Connect a property and run a sync. Zero-traffic days appear as
                zeros only after their dates reach successful coverage.
              </p>
            </div>
            <Ga4SyncStatus projectId={projectId} />
          </div>
        ) : (
          <>
            {view.kind === "partial" ? (
              <div className="alert alert-warning">
                <span className="text-sm">
                  Partial Analytics data
                  {view.coveredThrough ? ` through ${view.coveredThrough}` : ""}
                  . Missing dates are excluded, never zeroed.
                </span>
              </div>
            ) : null}
            <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
              <AnalyticsFilterToolbar
                range={range}
                setRange={setRange}
                channel={channel}
                setChannel={setChannel}
                device={device}
                setDevice={setDevice}
                country={country}
                setCountry={setCountry}
                goalId={goalId}
                setGoalId={setGoalId}
                goalsState={goalsState}
                isFetching={isFetching && !overviewQuery.isPending}
              />
              <div className="space-y-6 p-4">
                <section aria-label="Overview">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="font-semibold">Overview</h2>
                    <CoverageBadge result={overview} />
                  </div>
                  <OverviewSection
                    result={overview}
                    pending={overviewQuery.isPending}
                    queryError={
                      overviewQuery.isError ? overviewQuery.error : null
                    }
                  />
                </section>

                <section aria-label="Acquisition">
                  <h2 className="mb-2 font-semibold">Acquisition</h2>
                  <AcquisitionSection
                    result={acquisitionQuery.data}
                    pending={acquisitionQuery.isPending}
                    queryError={
                      acquisitionQuery.isError ? acquisitionQuery.error : null
                    }
                    title="Acquisition"
                    emptyNote="No acquisition rows in this period."
                  />
                </section>

                <section aria-label="Organic">
                  <h2 className="mb-2 font-semibold">Organic</h2>
                  <AcquisitionSection
                    result={organicQuery.data}
                    pending={organicQuery.isPending}
                    queryError={
                      organicQuery.isError ? organicQuery.error : null
                    }
                    title="Organic acquisition"
                    emptyNote="No organic rows in this period."
                  />
                </section>

                <section aria-label="Landing pages">
                  <h2 className="mb-2 font-semibold">Landing pages</h2>
                  <LandingSection
                    projectId={projectId}
                    result={landingQuery.data}
                    pending={landingQuery.isPending}
                    queryError={
                      landingQuery.isError ? landingQuery.error : null
                    }
                  />
                </section>

                <section aria-label="Events">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="font-semibold">Events</h2>
                    <CoverageBadge result={eventsQuery.data} />
                  </div>
                  <EventsSection
                    result={eventsQuery.data}
                    pending={eventsQuery.isPending}
                    queryError={eventsQuery.isError ? eventsQuery.error : null}
                  />
                </section>

                <section aria-label="Conversions">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="font-semibold">Conversions</h2>
                    <CoverageBadge result={conversionsQuery.data} />
                  </div>
                  <ConversionsSection
                    result={conversionsQuery.data}
                    pending={conversionsQuery.isPending}
                    queryError={
                      conversionsQuery.isError ? conversionsQuery.error : null
                    }
                  />
                </section>

                <section aria-label="Ecommerce">
                  <h2 className="mb-2 font-semibold">Ecommerce</h2>
                  <EcommerceSection
                    result={ecommerceQuery.data}
                    pending={ecommerceQuery.isPending}
                    queryError={
                      ecommerceQuery.isError ? ecommerceQuery.error : null
                    }
                  />
                </section>

                <section aria-label="Audience">
                  <div className="mb-2 flex items-center gap-2">
                    <h2 className="font-semibold">Audience</h2>
                    <CoverageBadge result={audienceQuery.data} />
                  </div>
                  <AudienceSection
                    result={audienceQuery.data}
                    pending={audienceQuery.isPending}
                    queryError={
                      audienceQuery.isError ? audienceQuery.error : null
                    }
                  />
                </section>

                <GoalsManager projectId={projectId} />
              </div>
            </div>
            <Ga4SyncStatus projectId={projectId} />
          </>
        )}
      </div>
    </div>
  );
}
