import { Link } from "@tanstack/react-router";
import { Database, RefreshCw } from "lucide-react";
import type { getGa4SyncStatus } from "@/serverFunctions/ga4";

export type Ga4SyncStatusResult = Awaited<ReturnType<typeof getGa4SyncStatus>>;

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

export function AnalyticsHeader({
  projectId,
  syncStatus,
  connected,
  isSyncing,
  onSyncNow,
}: {
  projectId: string;
  syncStatus?: Ga4SyncStatusResult;
  connected?: boolean;
  isSyncing: boolean;
  onSyncNow: () => void;
}) {
  const isConnected = connected ?? syncStatus?.connected ?? false;
  const isRunning =
    isSyncing || (syncStatus?.connected ? syncStatus.isRunning : false);

  return (
    <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
      <div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">Analytics</h1>
          {isConnected ? (
            <span
              className="badge badge-sm gap-1 badge-success badge-outline"
              title="Reading persisted data from database"
            >
              <Database className="size-3" />
              Synchronized Dataset
            </span>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 text-xs sm:text-sm text-base-content/70 mt-1">
          <span>
            Dataset:{" "}
            <span className="font-medium text-base-content">
              Synchronized Analytics data
            </span>
          </span>
          {isConnected && syncStatus?.syncCoverage ? (
            <>
              {syncStatus.syncCoverage.startDate &&
              syncStatus.syncCoverage.endDate ? (
                <>
                  <span>·</span>
                  <span>
                    Coverage:{" "}
                    <span className="font-mono text-xs">
                      {syncStatus.syncCoverage.startDate} →{" "}
                      {syncStatus.syncCoverage.endDate}
                    </span>
                  </span>
                </>
              ) : null}
              <span>·</span>
              <span>
                Sync status:{" "}
                <span
                  className={`font-semibold ${
                    syncStatus.syncCoverage.status === "completed"
                      ? "text-success"
                      : syncStatus.syncCoverage.status === "partial"
                        ? "text-warning"
                        : "text-error"
                  }`}
                >
                  {syncStatus.syncCoverage.status === "completed"
                    ? "Complete"
                    : syncStatus.syncCoverage.status === "partial"
                      ? "Partial"
                      : "Failed"}
                </span>
              </span>
              {syncStatus.syncCoverage.status === "partial" &&
              syncStatus.syncCoverage.endDate ? (
                <>
                  <span>·</span>
                  <span className="text-base-content/70">
                    Synchronized through{" "}
                    {formatDateHuman(syncStatus.syncCoverage.endDate)} (recent
                    Google Analytics data is still being finalized by Google)
                  </span>
                </>
              ) : null}
            </>
          ) : null}
          {isConnected && syncStatus?.lastSyncedAt ? (
            <>
              <span>·</span>
              <span>
                Last sync: {formatLastUpdated(syncStatus.lastSyncedAt)}
              </span>
            </>
          ) : null}
        </div>
      </div>
      {isConnected ? (
        <div className="flex items-center gap-2 shrink-0 sm:mt-1">
          <button
            className="btn btn-outline btn-sm gap-1.5"
            disabled={isRunning}
            onClick={onSyncNow}
            title="Synchronize Google Analytics 4 data to database"
          >
            <RefreshCw
              className={`size-3.5 ${isRunning ? "animate-spin" : ""}`}
            />
            {isRunning ? "Syncing…" : "Sync now"}
          </button>
          <Link
            to="/p/$projectId/settings"
            params={{ projectId }}
            hash="google-analytics"
            className="link link-hover text-sm font-medium text-base-content/60 transition-colors hover:text-base-content"
          >
            Change property
          </Link>
        </div>
      ) : null}
    </div>
  );
}
