import { useMemo, useState } from "react";
import { toast } from "sonner";
import { useQueryClient } from "@tanstack/react-query";
import { useCustomer } from "autumn-js/react";
import { useRankRunCancel } from "./useRankRunCancel";
import { ArrowLeft } from "lucide-react";
import { useSession } from "@/lib/auth-client";
import { getCustomerPlanStatus } from "@/client/features/billing/plan-detection";
import { captureClientEvent } from "@/client/lib/posthog";
import { FreePlanAlert } from "./FreePlanAlert";
import { ConfigAlerts } from "./ConfigAlerts";
import { RankTrackingDetailHeader } from "./RankTrackingDetailHeader";
import { RankTrackingOverview } from "./RankTrackingOverview";
import { RankTrackingTable } from "./RankTrackingTable";
import {
  createRankCheckScopeHandlers,
  notifyKeywordsAddedResult,
  type PendingRankCheck,
  RANK_DETAIL_QUERY_KEYS,
  RankTrackingDetailFooter,
  resolveDeviceVisibility,
  SeRankingProjectSyncBanner,
  useRankTrackingDetailData,
} from "./SeRankingProjectSyncBanner";
import {
  countMatrixRuns,
  RankTrackingHistoryMatrix,
} from "./RankTrackingHistoryMatrix";
import { RankTrackingTableToolbar } from "./RankTrackingTableToolbar";
import {
  exportRankTrackingCsv,
  exportRankTrackingToSheets,
} from "./RankTrackingTableParts";
import type {
  RankTrackingConfig,
  ComparePeriod,
} from "@/types/schemas/rank-tracking";
import { AddKeywordsPanel } from "./AddKeywordsPanel";
import {
  FilterPanel,
  applyFilters,
  countActiveFilters,
  EMPTY_FILTERS,
  type Filters,
} from "./RankTrackingFilters";
import { useMetricsRefresh } from "./useMetricsRefresh";
import { useRankCheckTrigger } from "./useRankCheckTrigger";
import { useRankRunPolling } from "./useRankRunPolling";

export function RankTrackingDomainDetail({
  config,
  projectId,
  onBack,
  onEdit,
}: {
  config: RankTrackingConfig;
  projectId: string;
  onBack: () => void;
  onEdit: () => void;
}) {
  const { data: session } = useSession();
  const customerQuery = useCustomer({
    queryOptions: { enabled: Boolean(session?.user?.id) },
  });
  const isFreePlan =
    !!customerQuery.data &&
    getCustomerPlanStatus(customerQuery.data) === "free";

  const queryClient = useQueryClient();
  const [showAddKeywords, setShowAddKeywords] = useState(false);
  const [showTargetsModal, setShowTargetsModal] = useState(false);
  const [selectedTargetId, setSelectedTargetId] = useState<string | undefined>(
    undefined,
  );
  const [showFilters, setShowFilters] = useState(false);
  const [filters, setFilters] = useState<Filters>(EMPTY_FILTERS);
  const [comparePeriod, setComparePeriod] = useState<ComparePeriod>(
    config.scheduleInterval === "daily"
      ? "1d"
      : config.scheduleInterval === "monthly"
        ? "30d"
        : "7d",
  );
  const [activeDevice, setActiveDevice] = useState<"desktop" | "mobile">(
    config.devices === "mobile" ? "mobile" : "desktop",
  );
  const [viewMode, setViewMode] = useState<"table" | "history">("table");

  const {
    resultsData,
    resultsLoading,
    matrixCells,
    matrixLoading,
    costEstimate,
    missingRankingsSummary,
    missingRankingsLoading,
    targets,
    targetAssignments,
    latestSyncBinding,
    retryingSync,
    onRetrySync,
  } = useRankTrackingDetailData({
    projectId,
    configId: config.id,
    comparePeriod,
    activeDevice,
    selectedTargetId,
  });

  const latestRun = useRankRunPolling(projectId, config.id);
  const { isCancelling, handleCancelRun } = useRankRunCancel(
    projectId,
    config.id,
    latestRun?.id,
  );
  const historyAvailable = countMatrixRuns(matrixCells ?? []) >= 2;

  const [pendingCheck, setPendingCheck] = useState<PendingRankCheck | null>(
    null,
  );

  const handleKeywordsAdded = (result: {
    added: number;
    checkTriggered: boolean;
  }) => {
    RANK_DETAIL_QUERY_KEYS.forEach((key) => {
      void queryClient.invalidateQueries({
        queryKey: [key, projectId, config.id],
      });
    });
    setShowAddKeywords(false);
    captureClientEvent("rank_tracking:keywords_add");
    notifyKeywordsAddedResult(result);
  };

  const isRunning =
    (latestRun?.status === "pending" || latestRun?.status === "running") &&
    !latestRun?.maybeStale;
  const { startCheck, isBusy, isPending } = useRankCheckTrigger({
    configId: config.id,
    isRunning,
    projectId,
    devices: config.devices,
    onSuccess: () => setPendingCheck(null),
  });

  const { refresh: refreshMetrics, isRefreshing: metricsRefreshing } =
    useMetricsRefresh(projectId, config.id);

  const {
    requestCheck,
    handleCheckSelected,
    handleCheckMissingSelected,
    requestMissingRankingsCheck,
    handleRetryFailed,
  } = createRankCheckScopeHandlers({ isBusy, startCheck, setPendingCheck });

  const rows = resultsData?.rows;
  const run = resultsData?.run;
  const selectedTarget = targets?.find((t) => t.id === selectedTargetId);
  const hasBothDevices = selectedTarget ? false : config.devices === "both";
  const { showDesktop, showMobile } = resolveDeviceVisibility(
    config.devices,
    activeDevice,
    selectedTarget,
  );

  const handleSelectTarget = (targetId: string | undefined) => {
    setSelectedTargetId(targetId);
    const picked = targets?.find((t) => t.id === targetId);
    if (picked) {
      setActiveDevice(picked.device);
    }
  };
  const filtered = useMemo(
    () => applyFilters(rows ?? [], filters),
    [rows, filters],
  );
  const activeFilterCount = countActiveFilters(filters);
  const defaultSortId = showDesktop ? "desktopPosition" : "mobilePosition";
  // Fall back to the table if history disappears (e.g. device switch).
  const effectiveViewMode = historyAvailable ? viewMode : "table";

  return (
    <div className="space-y-3">
      <button
        className="btn btn-ghost btn-xs gap-1 -ml-2 text-base-content/60"
        onClick={onBack}
      >
        <ArrowLeft className="size-3" />
        Back to domains
      </button>

      <ConfigAlerts
        config={config}
        latestRun={latestRun}
        onDismissStale={handleCancelRun}
        isDismissing={isCancelling}
      />

      <FreePlanAlert visible={isFreePlan} />

      {latestSyncBinding && (
        <SeRankingProjectSyncBanner
          status={latestSyncBinding.status}
          errorMessage={latestSyncBinding.errorMessage}
          retrying={retryingSync}
          onRetry={onRetrySync}
        />
      )}

      {/* Results card */}
      <div className="flex-1 flex flex-col min-w-0 border border-base-300 rounded-xl bg-base-100 overflow-hidden">
        {/* Domain header */}
        <RankTrackingDetailHeader
          config={config}
          run={run}
          targets={targets}
          selectedTargetId={selectedTargetId}
          onSelectedTargetChange={handleSelectTarget}
          onManageTargets={() => setShowTargetsModal(true)}
          costEstimate={costEstimate}
          hasBothDevices={hasBothDevices}
          activeDevice={activeDevice}
          onActiveDeviceChange={setActiveDevice}
          comparePeriod={comparePeriod}
          onComparePeriodChange={setComparePeriod}
          onEdit={onEdit}
          onToggleAddKeywords={() => setShowAddKeywords((c) => !c)}
        />

        {showAddKeywords && (
          <div className="px-4 pb-3">
            <AddKeywordsPanel
              configId={config.id}
              projectId={projectId}
              onSuccess={handleKeywordsAdded}
              onCancel={() => setShowAddKeywords(false)}
            />
          </div>
        )}

        {/* Portfolio overview */}
        {(rows?.length ?? 0) > 0 && (
          <RankTrackingOverview
            device={activeDevice}
            projectId={projectId}
            configId={config.id}
            trackingTargetId={selectedTargetId}
          />
        )}

        {/* Table toolbar */}
        <RankTrackingTableToolbar
          showFilters={showFilters}
          onToggleFilters={() => setShowFilters((c) => !c)}
          activeFilterCount={activeFilterCount}
          isRunning={isRunning}
          latestRun={latestRun}
          onCancelRun={handleCancelRun}
          isCancelling={isCancelling}
          keywordCount={filtered.length}
          viewMode={effectiveViewMode}
          onViewModeChange={setViewMode}
          historyAvailable={historyAvailable}
          onExport={() =>
            exportRankTrackingCsv(
              filtered,
              showDesktop,
              showMobile,
              config.domain,
              config.locationName,
            )
          }
          onExportToSheets={() =>
            exportRankTrackingToSheets(
              filtered,
              showDesktop,
              showMobile,
              config.locationName,
            )
          }
          onCopyKeywords={() => {
            void navigator.clipboard.writeText(
              filtered.map((r) => r.keyword).join("\n"),
            );
            toast.success("Keywords copied to clipboard");
          }}
          onCheckNow={() => {
            const count = costEstimate?.keywordCount ?? rows?.length ?? 0;
            if (count > 0) requestCheck(count);
          }}
          onCheckMissingRankings={() => requestMissingRankingsCheck()}
          missingRankingsCount={missingRankingsSummary?.eligibleCount ?? null}
          missingRankingsLoading={missingRankingsLoading}
          onRefreshMetrics={refreshMetrics}
          metricsRefreshing={metricsRefreshing}
          checkBusy={isBusy}
          checkDisabled={isFreePlan}
          hasData={filtered.length > 0}
          onRetryFailed={handleRetryFailed}
        />

        {/* Filters panel */}
        {showFilters && (
          <FilterPanel
            filters={filters}
            setFilters={setFilters}
            activeFilterCount={activeFilterCount}
            onReset={() => setFilters(EMPTY_FILTERS)}
          />
        )}

        {/* Table */}
        <div className="p-4">
          {effectiveViewMode === "history" ? (
            <RankTrackingHistoryMatrix
              cells={matrixCells ?? []}
              isLoading={matrixLoading}
              keywords={filtered.map((r) => ({
                trackingKeywordId: r.trackingKeywordId,
                keyword: r.keyword,
              }))}
            />
          ) : (
            <RankTrackingTable
              key={defaultSortId}
              totalCount={rows?.length ?? 0}
              rows={filtered}
              resultsLoading={resultsLoading}
              showDesktop={showDesktop}
              showMobile={showMobile}
              defaultSortId={defaultSortId}
              domain={config.domain}
              configId={config.id}
              projectId={projectId}
              locationCode={config.locationCode}
              locationName={config.locationName}
              serpDepth={config.serpDepth}
              trackingTargetId={selectedTargetId}
              targets={targets}
              targetIdsByKeyword={targetAssignments?.targetIdsByKeyword}
              onCheckSelected={handleCheckSelected}
              onCheckMissingSelected={handleCheckMissingSelected}
              checkSelectedBusy={isBusy}
              checkSelectedDisabled={isFreePlan}
            />
          )}
        </div>
      </div>

      <RankTrackingDetailFooter
        projectId={projectId}
        config={config}
        activeDevice={activeDevice}
        pendingCheck={pendingCheck}
        isPending={isPending}
        onRunCheck={startCheck}
        onCancelCheck={() => setPendingCheck(null)}
        showTargetsModal={showTargetsModal}
        targets={targets}
        onCloseTargetsModal={() => setShowTargetsModal(false)}
      />
    </div>
  );
}
