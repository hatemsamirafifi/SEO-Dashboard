export type Ga4SyncStatusView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not-connected" }
  | { kind: "syncing" }
  | { kind: "never-synced" }
  | {
      kind: "last-result";
      status: "completed" | "partial" | "failed";
      error: string | null;
      lastFullyCoveredDate: string | null;
    };

export type Ga4SyncStatusCopy = {
  headline: string | null;
  showTrigger: boolean;
  triggerDisabled: boolean;
  showRetry: boolean;
};

/** Pure presentation mapping for the GA4 sync status block. Every branch is
 *  a distinct UX state (final-plan §17): loading / error / not-connected /
 *  syncing / never-synced / last-result. Provider failure is always an
 *  explicit failure line, never a zero-data line. */
export function syncStatusCopy(view: Ga4SyncStatusView): Ga4SyncStatusCopy {
  switch (view.kind) {
    case "loading":
      return {
        headline: null,
        showTrigger: false,
        triggerDisabled: false,
        showRetry: false,
      };
    case "error":
      return {
        headline: "Could not load the Analytics sync status.",
        showTrigger: false,
        triggerDisabled: false,
        showRetry: true,
      };
    case "not-connected":
      return {
        headline: null,
        showTrigger: false,
        triggerDisabled: false,
        showRetry: false,
      };
    case "syncing":
      return {
        headline: "Syncing Analytics data…",
        showTrigger: false,
        triggerDisabled: true,
        showRetry: false,
      };
    case "never-synced":
      return {
        headline: "No Analytics data synced yet.",
        showTrigger: true,
        triggerDisabled: false,
        showRetry: false,
      };
    case "last-result":
      if (view.status === "failed") {
        return {
          headline: view.error
            ? `Last sync failed: ${view.error}`
            : "Last sync failed.",
          showTrigger: true,
          triggerDisabled: false,
          showRetry: false,
        };
      }
      if (view.status === "partial") {
        return {
          headline: view.lastFullyCoveredDate
            ? `Last sync partially completed. Data through ${view.lastFullyCoveredDate}.`
            : "Last sync partially completed.",
          showTrigger: true,
          triggerDisabled: false,
          showRetry: false,
        };
      }
      return {
        headline: view.lastFullyCoveredDate
          ? `Analytics data through ${view.lastFullyCoveredDate}.`
          : "Analytics data is up to date.",
        showTrigger: true,
        triggerDisabled: false,
        showRetry: false,
      };
  }
}

/** Fold a getGa4SyncStatus payload into a view. Unknown latest-sync states
 *  degrade to never-synced rather than inventing a status. */
export function toSyncStatusView(input: {
  connected: boolean;
  isRunning: boolean;
  latestSync: { status: string; error?: string | null } | null;
  lastFullyCoveredDate: string | null;
}): Ga4SyncStatusView {
  if (!input.connected) return { kind: "not-connected" };
  if (input.isRunning) return { kind: "syncing" };
  if (!input.latestSync) return { kind: "never-synced" };
  if (
    input.latestSync.status === "completed" ||
    input.latestSync.status === "partial" ||
    input.latestSync.status === "failed"
  ) {
    return {
      kind: "last-result",
      status: input.latestSync.status,
      error: input.latestSync.error ?? null,
      lastFullyCoveredDate: input.lastFullyCoveredDate,
    };
  }
  return { kind: "never-synced" };
}
