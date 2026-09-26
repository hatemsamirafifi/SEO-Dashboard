import { useEffect, useRef, useState } from "react";
import {
  AlertCircle,
  CalendarDays,
  CheckCircle2,
  Loader2,
  SlidersHorizontal,
  Table,
} from "lucide-react";
import { SegmentedToggle } from "@/client/components/SegmentedToggle";
import { ExportMenu, MoreMenu } from "./ToolbarMenus";

export function RankTrackingTableToolbar({
  showFilters,
  onToggleFilters,
  activeFilterCount,
  isRunning,
  latestRun,
  keywordCount,
  viewMode,
  onViewModeChange,
  historyAvailable,
  onExport,
  onExportToSheets,
  onCopyKeywords,
  onCheckNow,
  onCheckMissingRankings,
  missingRankingsCount,
  missingRankingsLoading,
  onRefreshMetrics,
  metricsRefreshing,
  checkBusy,
  checkDisabled,
  hasData,
}: {
  showFilters: boolean;
  onToggleFilters: () => void;
  activeFilterCount: number;
  isRunning: boolean;
  latestRun:
    | {
        id?: string;
        status: string;
        keywordsChecked: number;
        keywordsTotal: number;
        isSubsetRun?: boolean;
      }
    | null
    | undefined;
  keywordCount: number;
  viewMode: "table" | "history";
  onViewModeChange: (v: "table" | "history") => void;
  historyAvailable: boolean;
  onExport: () => void;
  onExportToSheets: () => void;
  onCopyKeywords: () => void;
  onCheckNow: () => void;
  onCheckMissingRankings: () => void;
  missingRankingsCount: number | null;
  missingRankingsLoading: boolean;
  onRefreshMetrics: () => void;
  metricsRefreshing: boolean;
  checkBusy: boolean;
  checkDisabled: boolean;
  hasData: boolean;
}) {
  const lastRunIdRef = useRef<string | null>(null);
  const maxCheckedRef = useRef<number>(0);

  const currentRunId = latestRun?.id ?? null;
  if (currentRunId !== lastRunIdRef.current) {
    lastRunIdRef.current = currentRunId;
    maxCheckedRef.current = latestRun?.keywordsChecked ?? 0;
  } else if (latestRun) {
    maxCheckedRef.current = Math.max(
      maxCheckedRef.current,
      latestRun.keywordsChecked ?? 0,
    );
  }

  const rawChecked = latestRun?.keywordsChecked ?? 0;
  const displayChecked = Math.max(rawChecked, maxCheckedRef.current);
  const total = latestRun?.keywordsTotal ?? 0;
  const pct =
    total > 0
      ? Math.min(100, Math.round((displayChecked / total) * 100))
      : 0;

  const [completedBanner, setCompletedBanner] = useState<{
    status: string;
    total: number;
    checked: number;
    isSubsetRun?: boolean;
  } | null>(null);

  const prevIsRunningRef = useRef(isRunning);

  useEffect(() => {
    if (prevIsRunningRef.current && !isRunning && latestRun) {
      const runTotal = latestRun.keywordsTotal || maxCheckedRef.current || 0;
      const runChecked =
        latestRun.status === "completed"
          ? runTotal
          : Math.max(latestRun.keywordsChecked ?? 0, maxCheckedRef.current);

      if (runTotal > 0) {
        setCompletedBanner({
          status: latestRun.status,
          total: runTotal,
          checked: runChecked,
          isSubsetRun: latestRun.isSubsetRun,
        });

        const timer = setTimeout(() => {
          setCompletedBanner(null);
        }, 4000);

        return () => clearTimeout(timer);
      }
    }
    prevIsRunningRef.current = isRunning;
  }, [isRunning, latestRun]);

  useEffect(() => {
    if (isRunning && completedBanner) {
      setCompletedBanner(null);
    }
  }, [isRunning, completedBanner]);

  return (
    <div className="shrink-0 flex flex-wrap items-center gap-2 px-4 py-2 border-y border-base-300">
      {/* History needs at least two checks to compare; until then the toggle
          would only offer a worse copy of the Latest table. */}
      {historyAvailable && (
        <SegmentedToggle
          showLabels
          items={[
            {
              value: "table" as const,
              icon: <Table className="size-3.5" />,
              label: "Latest",
            },
            {
              value: "history" as const,
              icon: <CalendarDays className="size-3.5" />,
              label: "History",
            },
          ]}
          value={viewMode}
          onChange={onViewModeChange}
        />
      )}

      <button
        className={`btn btn-ghost btn-sm gap-1.5 ${showFilters ? "btn-active" : ""}`}
        onClick={onToggleFilters}
        title="Toggle table filters"
      >
        <SlidersHorizontal className="size-3.5" />
        Filters
        {activeFilterCount > 0 && (
          <span className="badge badge-xs badge-primary border-0 text-primary-content">
            {activeFilterCount}
          </span>
        )}
      </button>

      {isRunning && latestRun ? (
        <div className="flex items-center gap-2 text-sm text-base-content/80">
          <Loader2 className="size-3.5 animate-spin text-primary shrink-0" />
          <span>
            {latestRun.status === "pending"
              ? "Preparing..."
              : latestRun.isSubsetRun
                ? `Checking ${total || "?"} selected keyword${total !== 1 ? "s" : ""}...`
                : `Getting rankings for ${total || "?"} keyword${total !== 1 ? "s" : ""}...`}{" "}
            <span className="tabular-nums font-semibold text-base-content">
              {displayChecked}/{total || "?"}
            </span>
            {total > 0 && (
              <span className="ml-1 text-xs text-base-content/60 tabular-nums">
                ({pct}%)
              </span>
            )}
          </span>
          {total > 0 && (
            <div
              className="relative h-2 w-28 sm:w-36 overflow-hidden rounded-full bg-base-200 border border-base-300 shrink-0"
              role="progressbar"
              aria-valuenow={displayChecked}
              aria-valuemin={0}
              aria-valuemax={total}
            >
              <div
                className="h-full rounded-full bg-primary transition-all duration-300 ease-out"
                style={{ width: `${pct}%` }}
              />
            </div>
          )}
        </div>
      ) : completedBanner && completedBanner.status === "completed" ? (
        <div className="flex items-center gap-2 text-sm text-success animate-in fade-in duration-200">
          <CheckCircle2 className="size-3.5 text-success shrink-0" />
          <span>
            Completed{" "}
            <span className="tabular-nums font-semibold">
              {completedBanner.checked}/{completedBanner.total}
            </span>{" "}
            keyword{completedBanner.total !== 1 ? "s" : ""}{" "}
            <span className="text-xs font-semibold tabular-nums">(100%)</span>
          </span>
          <div
            className="relative h-2 w-28 sm:w-36 overflow-hidden rounded-full bg-success/20 border border-success/30 shrink-0"
            role="progressbar"
            aria-valuenow={completedBanner.total}
            aria-valuemin={0}
            aria-valuemax={completedBanner.total}
          >
            <div className="h-full w-full rounded-full bg-success" />
          </div>
        </div>
      ) : completedBanner && completedBanner.status === "partial" ? (
        <div className="flex items-center gap-2 text-sm text-warning animate-in fade-in duration-200">
          <AlertCircle className="size-3.5 text-warning shrink-0" />
          <span>
            Partially completed:{" "}
            <span className="tabular-nums font-semibold">
              {completedBanner.checked}/{completedBanner.total}
            </span>{" "}
            keywords checked
          </span>
        </div>
      ) : (
        <span className="text-sm text-base-content/60">
          {keywordCount} keywords
        </span>
      )}

      <div className="flex-1" />

      <ExportMenu
        onExport={onExport}
        onExportToSheets={onExportToSheets}
        onCopyKeywords={onCopyKeywords}
        hasData={hasData}
      />

      <MoreMenu
        onCheckNow={onCheckNow}
        onCheckMissingRankings={onCheckMissingRankings}
        missingRankingsCount={
          missingRankingsLoading ? null : missingRankingsCount
        }
        checkBusy={checkBusy}
        checkDisabled={checkDisabled}
        onRefreshMetrics={onRefreshMetrics}
        metricsRefreshing={metricsRefreshing}
        hasData={hasData}
      />
    </div>
  );
}
