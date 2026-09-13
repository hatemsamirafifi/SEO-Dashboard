import { Link } from "@tanstack/react-router";
import { Cloud, Database, RefreshCw } from "lucide-react";
import type { getSearchPerformanceReport } from "@/serverFunctions/searchPerformance";

export type SearchPerformanceReportResult = Awaited<
  ReturnType<typeof getSearchPerformanceReport>
>;

function formatLastUpdated(isoString: string): string {
  try {
    const d = new Date(isoString);
    return `${d.toLocaleDateString()} ${d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
  } catch {
    return isoString;
  }
}

function formatDateHuman(dateString?: string | null): string {
  if (!dateString) return "";
  try {
    const [y, m, d] = dateString.split("-").map(Number);
    if (!y || !m || !d) return dateString;
    const date = new Date(Date.UTC(y, m - 1, d));
    return date.toLocaleDateString("en-US", {
      month: "short",
      day: "numeric",
      year: "numeric",
      timeZone: "UTC",
    });
  } catch {
    return dateString;
  }
}

export function SearchPerformanceHeader({
  projectId,
  report,
  isSyncing,
  onSyncNow,
  onSyncRange,
}: {
  projectId: string;
  report?: SearchPerformanceReportResult;
  isSyncing: boolean;
  onSyncNow: () => void;
  onSyncRange?: () => void;
}) {
  return (
    <>
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold">Search Performance</h1>
            {report?.connected ? (
              <span
                className={`badge badge-sm gap-1 ${
                  report.source === "database"
                    ? "badge-success badge-outline"
                    : "badge-warning badge-outline"
                }`}
                title={
                  report.source === "database"
                    ? "Reading persisted data from database"
                    : "Showing live GSC API data (not synchronized in DB yet)"
                }
              >
                {report.source === "database" ? (
                  <Database className="size-3" />
                ) : (
                  <Cloud className="size-3" />
                )}
                {report.source === "database"
                  ? "Synchronized Dataset"
                  : "Live GSC"}
              </span>
            ) : null}
          </div>
          <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-base-content/70 mt-1">
            <span>
              Dataset:{" "}
              <span className="font-medium text-base-content">
                Synchronized Search Console data
              </span>
            </span>
            {report?.connected && report.syncCoverage ? (
              <>
                <span>·</span>
                <span>
                  Coverage:{" "}
                  <span className="font-mono text-xs">
                    {report.syncCoverage.startDate} →{" "}
                    {report.syncCoverage.endDate}
                  </span>
                </span>
                <span>·</span>
                <span>
                  Sync status:{" "}
                  <span
                    className={`font-semibold ${
                      report.syncCoverage.status === "completed"
                        ? "text-success"
                        : report.syncCoverage.status === "partial"
                          ? "text-warning"
                          : "text-error"
                    }`}
                  >
                    {report.syncCoverage.status === "completed"
                      ? "Complete"
                      : report.syncCoverage.status === "partial"
                        ? "Partial"
                        : "Failed"}
                  </span>
                </span>
                {report.syncCoverage.status === "partial" &&
                report.syncCoverage.endDate ? (
                  <>
                    <span>·</span>
                    <span className="text-base-content/70">
                      Synchronized through{" "}
                      {formatDateHuman(report.syncCoverage.endDate)} (recent
                      Google Search Console data is still being finalized by
                      Google)
                    </span>
                  </>
                ) : null}
              </>
            ) : null}
            {report?.connected && report.lastSyncedAt ? (
              <>
                <span>·</span>
                <span>Last sync: {formatLastUpdated(report.lastSyncedAt)}</span>
              </>
            ) : null}
          </div>
        </div>
        {report?.connected ? (
          <div className="flex items-center gap-2 shrink-0 sm:mt-1">
            <button
              className="btn btn-outline btn-sm gap-1.5"
              disabled={isSyncing || report.isSyncRunning}
              onClick={onSyncNow}
              title="Synchronize Google Search Console data to database"
            >
              <RefreshCw
                className={`size-3.5 ${isSyncing || report.isSyncRunning ? "animate-spin" : ""}`}
              />
              {isSyncing || report.isSyncRunning ? "Syncing…" : "Sync now"}
            </button>
            <Link
              to="/p/$projectId/settings"
              params={{ projectId }}
              hash="search-console"
              className="link link-hover text-sm font-medium text-base-content/60 transition-colors hover:text-base-content"
            >
              Change property
            </Link>
          </div>
        ) : null}
      </div>

      {report?.connected && !report.coverage ? (
        <div className="alert alert-info py-2.5">
          <Cloud className="size-4 shrink-0" />
          <span className="text-xs sm:text-sm">
            {report.syncCoverage?.endDate
              ? `Recent data is being shown live from Google Search Console. Stored data is synchronized through ${formatDateHuman(report.syncCoverage.endDate)}. Newer dates will be added when they become available.`
              : "This date range is not synchronized in the database yet. Currently showing live Google Search Console data."}
          </span>
          <button
            className="btn btn-xs btn-primary gap-1 ml-auto shrink-0"
            disabled={isSyncing || report.isSyncRunning}
            onClick={onSyncRange ?? onSyncNow}
          >
            <RefreshCw
              className={`size-3 ${isSyncing || report.isSyncRunning ? "animate-spin" : ""}`}
            />
            Sync this range
          </button>
        </div>
      ) : null}
    </>
  );
}
