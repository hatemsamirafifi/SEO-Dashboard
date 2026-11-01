import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import type { AnalyticsRange } from "@/types/schemas/ga4";
import type { CompareMode } from "@/types/schemas/date-range-compare";
import type { DateRangeCompareValues } from "@/client/components/DateRangeCompareModal";
import { triggerGa4Sync } from "@/serverFunctions/ga4";
import { AnalyticsConnectionCard } from "@/client/features/ga4/AnalyticsConnectionCard";
import { Ga4SyncStatus } from "@/client/features/ga4/Ga4SyncStatus";
import {
  ALL,
  AnalyticsFilterToolbar,
} from "@/client/features/analytics/AnalyticsFilterToolbar";
import { AnalyticsHeader } from "./AnalyticsHeader";
import { AnalyticsContentSections } from "./AnalyticsContentSections";
import {
  toAnalyticsPageView,
  type AnalyticsPageView,
} from "@/client/features/analytics/analyticsCopy";
import { useAnalyticsQueries } from "./useAnalyticsQueries";

import type { AnalyticsOverviewResult } from "@/server/features/ga4/services/AnalyticsService";

type ConnectedAnalyticsOverview = Extract<
  AnalyticsOverviewResult,
  { connected: true }
>;

function AnalyticsBanner({
  view,
  storedCoverage,
  currentWindow,
  isSyncing,
  onSyncRange,
}: {
  view: AnalyticsPageView;
  storedCoverage?: {
    startDate?: string | null;
    endDate?: string | null;
  } | null;
  currentWindow?: { from: string; to: string } | null;
  isSyncing?: boolean;
  onSyncRange?: () => void;
}) {
  if (view.kind === "syncing") {
    return (
      <div className="alert alert-info">
        <span className="text-sm">
          Syncing Analytics data… sections below show the last synced snapshot.
        </span>
      </div>
    );
  }
  if (view.kind === "quota-failed") {
    return (
      <div className="alert alert-warning">
        <span className="text-sm">
          Analytics sync hit the Google quota and stopped early: {view.message}{" "}
          Data already synced stays visible.
        </span>
      </div>
    );
  }
  if (view.kind === "perm-failed") {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          Analytics access failed and needs attention: {view.message} Reconnect
          the property in Settings.
        </span>
      </div>
    );
  }
  if (view.kind === "sync-failed") {
    return (
      <div className="alert alert-error">
        <span className="text-sm">
          Last Analytics sync failed: {view.message} Previously synced data
          stays visible.
        </span>
      </div>
    );
  }
  if (view.kind === "partial") {
    const isMissingHistorical = Boolean(
      storedCoverage?.startDate &&
      currentWindow?.from &&
      currentWindow.from < storedCoverage.startDate,
    );

    return (
      <div className="alert alert-warning flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3 py-2.5">
        <span className="text-sm">
          {isMissingHistorical
            ? `Partial Analytics data: Stored data begins from ${storedCoverage?.startDate}. Earlier dates in this range (${currentWindow?.from} → ${storedCoverage?.startDate}) are not synchronized yet.`
            : `Partial Analytics data${view.coveredThrough ? ` through ${view.coveredThrough}` : ""}. Missing dates are excluded, never zeroed.`}
        </span>
        {onSyncRange ? (
          <button
            type="button"
            className="btn btn-xs btn-primary gap-1 shrink-0 self-start sm:self-auto"
            disabled={isSyncing}
            onClick={onSyncRange}
          >
            <RefreshCw
              className={`size-3 ${isSyncing ? "animate-spin" : ""}`}
            />
            Sync this range
          </button>
        ) : null}
      </div>
    );
  }
  return null;
}

function AnalyticsEmptyFallback({
  view,
  projectId,
}: {
  view: AnalyticsPageView;
  projectId: string;
}) {
  let message = "";
  let alertClass = "alert alert-error";

  if (view.kind === "syncing") {
    message = "Syncing Analytics data… This may take a few moments.";
    alertClass = "alert alert-info";
  } else if (view.kind === "quota-failed") {
    message = `Analytics sync hit the Google quota and stopped early: ${view.message}`;
    alertClass = "alert alert-warning";
  } else if (view.kind === "perm-failed") {
    message = `Analytics access failed and needs attention: ${view.message} Reconnect the property in Settings.`;
  } else if (view.kind === "sync-failed") {
    message = `Analytics sync failed: ${view.message}`;
  }

  return (
    <div className="max-w-2xl space-y-4">
      {message ? (
        <div className={alertClass}>
          <span className="text-sm">{message}</span>
        </div>
      ) : null}
      <Ga4SyncStatus projectId={projectId} />
    </div>
  );
}

export function AnalyticsPage({ projectId }: { projectId: string }) {
  const [range, setRange] = useState<AnalyticsRange>("last_28_days");
  const [startDate, setStartDate] = useState<string | undefined>();
  const [endDate, setEndDate] = useState<string | undefined>();
  const [compareMode, setCompareMode] =
    useState<CompareMode>("previous_period");
  const [compareStartDate, setCompareStartDate] = useState<
    string | undefined
  >();
  const [compareEndDate, setCompareEndDate] = useState<string | undefined>();

  const [channel, setChannel] = useState("");
  const [device, setDevice] = useState<string>(ALL);
  const [country, setCountry] = useState("");
  // Spec 010: goal filter for the conversions view. Empty = all conversions.
  const [goalId, setGoalId] = useState("");
  const [techDimension, setTechDimension] = useState<
    "device" | "browser" | "os"
  >("device");

  const handleDateRangeChange = (values: DateRangeCompareValues) => {
    setRange(values.range);
    setStartDate(values.startDate);
    setEndDate(values.endDate);
    setCompareMode(values.compareMode);
    setCompareStartDate(values.compareStartDate);
    setCompareEndDate(values.compareEndDate);
  };

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
    geoQuery,
    prevGeoQuery,
    techQuery,
    prevTechQuery,
    gscPagesQuery,
    isFetching,
  } = useAnalyticsQueries(
    projectId,
    {
      range,
      startDate,
      endDate,
      compareMode,
      compareStartDate,
      compareEndDate,
      channel,
      device,
      country,
      goalId,
    },
    techDimension,
  );

  const queryClient = useQueryClient();
  const syncMutation = useMutation({
    mutationFn: (variables?: {
      startDate?: string;
      endDate?: string;
      force?: boolean;
    }) =>
      triggerGa4Sync({
        data: {
          projectId,
          syncType: "manual",
          startDate: variables?.startDate,
          endDate: variables?.endDate,
          force: variables?.force,
        },
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["ga4SyncStatus", projectId],
      });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[1] === projectId &&
          typeof query.queryKey[0] === "string" &&
          (query.queryKey[0].startsWith("analytics") ||
            query.queryKey[0].startsWith("ga4")),
      });
      toast.success("Analytics data synced successfully.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const isSyncing =
    syncMutation.isPending || (syncQuery.data?.isRunning ?? false);

  const overview = overviewQuery.data;
  const connectedOverview: ConnectedAnalyticsOverview | null =
    overview?.connected ? (overview as ConnectedAnalyticsOverview) : null;
  const currentWindow = connectedOverview?.windows.current;
  const hasRows =
    connectedOverview !== null &&
    (connectedOverview.totals.sessions.current > 0 ||
      connectedOverview.trends.length > 0);
  const view = toAnalyticsPageView({
    connectionLoading:
      connectionQuery.isPending ||
      (connectionQuery.data?.connected === true && syncQuery.isPending),
    syncLoading: false,
    connectionError: connectionQuery.error !== null,
    syncError: syncQuery.error !== null,
    connected,
    isRunning: syncQuery.data?.connected
      ? (syncQuery.data.isRunning ?? false)
      : false,
    latestSyncError:
      syncQuery.data?.connected && syncQuery.data.latestSync
        ? (syncQuery.data.latestSync.error ?? null)
        : null,
    coverageStatus: connectedOverview
      ? connectedOverview.coverage.status
      : "none",
    hasRows,
    coveredThrough: connectedOverview
      ? connectedOverview.coverage.coveredThrough
      : null,
  });

  const handleSyncRange = () => {
    if (!currentWindow) {
      syncMutation.mutate(undefined);
      return;
    }
    toast.info(
      `Starting synchronization for ${currentWindow.from} → ${currentWindow.to}…`,
    );
    syncMutation.mutate({
      startDate: currentWindow.from,
      endDate: currentWindow.to,
      force: false,
    });
  };

  const handleSyncNow = () => {
    if (view.kind === "partial" && currentWindow) {
      handleSyncRange();
    } else {
      toast.info("Starting Analytics synchronization…");
      syncMutation.mutate(undefined);
    }
  };

  return (
    <div className="overflow-auto px-4 py-4 pb-24 md:px-6 md:py-6 md:pb-8">
      <div className="mx-auto max-w-7xl space-y-4">
        <AnalyticsHeader
          projectId={projectId}
          connected={connected}
          syncStatus={syncQuery.data}
          isSyncing={isSyncing}
          onSyncNow={handleSyncNow}
        />

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
        ) : (view.kind === "syncing" ||
            view.kind === "sync-failed" ||
            view.kind === "quota-failed" ||
            view.kind === "perm-failed") &&
          !hasRows ? (
          <AnalyticsEmptyFallback view={view} projectId={projectId} />
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
            <AnalyticsBanner
              view={view}
              storedCoverage={syncQuery.data?.syncCoverage}
              currentWindow={currentWindow}
              isSyncing={isSyncing}
              onSyncRange={handleSyncRange}
            />
            <div className="overflow-hidden rounded-xl border border-base-300 bg-base-100">
              <AnalyticsFilterToolbar
                range={range}
                startDate={startDate}
                endDate={endDate}
                compareMode={compareMode}
                compareStartDate={compareStartDate}
                compareEndDate={compareEndDate}
                onDateRangeChange={handleDateRangeChange}
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
              <AnalyticsContentSections
                projectId={projectId}
                overviewQuery={overviewQuery}
                acquisitionQuery={acquisitionQuery}
                organicQuery={organicQuery}
                landingQuery={landingQuery}
                gscPagesQuery={gscPagesQuery}
                eventsQuery={eventsQuery}
                conversionsQuery={conversionsQuery}
                ecommerceQuery={ecommerceQuery}
                audienceQuery={audienceQuery}
                geoQuery={geoQuery}
                prevGeoQuery={prevGeoQuery}
                techQuery={techQuery}
                prevTechQuery={prevTechQuery}
                techDimension={techDimension}
                setTechDimension={setTechDimension}
              />
            </div>
          </>
        )}
      </div>
    </div>
  );
}
