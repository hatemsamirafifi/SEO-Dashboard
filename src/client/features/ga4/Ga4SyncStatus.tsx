import * as React from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { getGa4SyncStatus, triggerGa4Sync } from "@/serverFunctions/ga4";
import { syncStatusCopy, toSyncStatusView } from "./syncStatusCopy";

export function Ga4SyncStatus({ projectId }: { projectId: string }) {
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: ["ga4SyncStatus", projectId],
    queryFn: () => getGa4SyncStatus({ data: { projectId } }),
  });
  const trigger = useMutation({
    mutationFn: () => triggerGa4Sync({ data: { projectId } }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["ga4SyncStatus", projectId],
      });
    },
    onError: (error) => toast.error(getStandardErrorMessage(error)),
  });

  const copy = status.isLoading
    ? syncStatusCopy({ kind: "loading" })
    : status.isError
      ? syncStatusCopy({ kind: "error" })
      : syncStatusCopy(
          toSyncStatusView({
            connected: status.data?.connected ?? false,
            isRunning: status.data?.isRunning ?? false,
            latestSync: status.data?.latestSync
              ? {
                  status: status.data.latestSync.status,
                  error: status.data.latestSync.error,
                }
              : null,
            lastFullyCoveredDate: status.data?.lastFullyCoveredDate ?? null,
          }),
        );

  return (
    <div className="space-y-2 border-t border-base-300 pt-4">
      <h3 className="text-sm font-semibold">Data sync</h3>
      {status.isLoading ? (
        <span className="loading loading-spinner loading-sm" />
      ) : (
        <>
          {copy.headline ? (
            <p className="text-sm text-base-content/70">{copy.headline}</p>
          ) : null}
          <div className="flex gap-2">
            {copy.showRetry ? (
              <button
                className="btn btn-outline btn-sm"
                type="button"
                onClick={() => void status.refetch()}
              >
                Retry
              </button>
            ) : null}
            {copy.showTrigger ? (
              <button
                className="btn btn-outline btn-sm"
                type="button"
                disabled={copy.triggerDisabled || trigger.isPending}
                onClick={() => trigger.mutate()}
              >
                {trigger.isPending ? "Syncing…" : "Sync now"}
              </button>
            ) : null}
          </div>
        </>
      )}
    </div>
  );
}
