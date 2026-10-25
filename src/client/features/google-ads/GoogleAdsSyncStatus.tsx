import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getGoogleAdsSyncStatus,
  triggerGoogleAdsSync,
} from "@/serverFunctions/google-ads";
import type { GoogleAdsSyncState } from "./googleAdsTypes";
import {
  googleAdsFailureMessage,
  googleAdsSyncFailureKind,
} from "./googleAdsCopy";

/** Sync status controls for the Google Ads page: which sync ran last, what
 *  the durable unit ledger says, and a manual "Sync now" trigger. Distinct
 *  failure classes stay distinct: quota outages, access problems and other
 *  sync failures copy differently. Uses the same query key as the page's
 *  analytics reads so the cache stays shared. */

export function useTriggerGoogleAdsSync(projectId: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () => triggerGoogleAdsSync({ data: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["googleAdsSyncStatus", projectId],
      });
      void queryClient.invalidateQueries({
        predicate: (query) =>
          Array.isArray(query.queryKey) &&
          query.queryKey[1] === projectId &&
          typeof query.queryKey[0] === "string" &&
          query.queryKey[0].startsWith("googleAds"),
      });
      toast.success("Google Ads sync started.");
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });
}

export function googleAdsSyncHeadline(
  connected: boolean,
  syncState: GoogleAdsSyncState | null | undefined,
): { text: string; failure: "quota" | "perm" | "sync" | null } {
  if (!connected || !syncState) {
    return { text: "Connect Google Ads to start syncing data.", failure: null };
  }
  if (syncState.activeRun) {
    return { text: "Sync is running now…", failure: null };
  }
  const latest = syncState.runs[0];
  if (latest?.status === "running") {
    return { text: "Sync is running now…", failure: null };
  }
  if (latest?.status === "failed") {
    const kind = googleAdsSyncFailureKind(
      latest.errorClass,
      latest.errorMessage,
    );
    return {
      text: `Last sync failed: ${googleAdsFailureMessage(
        latest.errorClass,
        latest.errorMessage,
      )}`,
      failure:
        kind === "quota-failed"
          ? "quota"
          : kind === "perm-failed"
            ? "perm"
            : "sync",
    };
  }
  if (!latest) {
    return { text: "No Google Ads sync has run yet.", failure: null };
  }
  const partial = latest.status === "partial" ? "with partial coverage " : "";
  const completed = latest.completedAt ? ` on ${latest.completedAt}` : "";
  return {
    text: `Last sync completed ${partial}${completed}`.trim() + ".",
    failure: null,
  };
}

function UnitCoverageLine({ syncState }: { syncState: GoogleAdsSyncState }) {
  const u = syncState.units;
  const dayUnits = u.successWithData + u.successZeroRows;
  return (
    <p className="text-xs text-base-content/50">
      Day-units: {dayUnits} with data · {u.partial} partial · {u.failed} failed
      {u.pending > 0 ? ` · ${u.pending} queued` : ""}
    </p>
  );
}

export function GoogleAdsSyncStatus({
  projectId,
  className,
  variant = "default",
  connected,
}: {
  projectId: string;
  className?: string;
  variant?: "default" | "header";
  connected: boolean;
}) {
  const status = useQuery({
    queryKey: ["googleAdsSyncStatus", projectId],
    queryFn: () => getGoogleAdsSyncStatus({ data: { projectId } }),
    enabled: connected,
  });
  const trigger = useTriggerGoogleAdsSync(projectId);

  const syncState =
    status.data?.connected === true ? status.data.syncState : null;
  const headline = googleAdsSyncHeadline(connected, syncState);
  const isSyncing = trigger.isPending || Boolean(syncState?.activeRun);

  const buttons = (
    <div className="flex gap-2">
      <button
        className="btn btn-outline btn-sm gap-1.5"
        type="button"
        disabled={!connected || isSyncing}
        onClick={() => trigger.mutate()}
        title="Synchronize Google Ads data to database"
      >
        <RefreshCw className={`size-3.5 ${isSyncing ? "animate-spin" : ""}`} />
        {isSyncing ? "Syncing…" : "Sync now"}
      </button>
      {status.isError ? (
        <button
          className="btn btn-ghost btn-sm"
          type="button"
          onClick={() => void status.refetch()}
        >
          Retry
        </button>
      ) : null}
    </div>
  );

  if (variant === "header") {
    return (
      <div className={`flex flex-wrap items-center gap-3 ${className ?? ""}`}>
        <span className="text-xs text-base-content/70 sm:text-sm">
          {headline.text}
        </span>
        {buttons}
      </div>
    );
  }

  return (
    <div
      className={`space-y-2 border-t border-base-300 pt-4 ${className ?? ""}`}
    >
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-semibold">Data sync</h3>
        {buttons}
      </div>
      <p className="text-sm text-base-content/70">{headline.text}</p>
      {syncState ? <UnitCoverageLine syncState={syncState} /> : null}
    </div>
  );
}
