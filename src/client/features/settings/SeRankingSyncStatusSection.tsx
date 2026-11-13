import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  getSeRankingSyncStatusFn,
  migrateSeRankingAccountFn,
  retrySeRankingProjectSyncFn,
} from "@/serverFunctions/rank-tracking-targets";

const STATUS_BADGE: Record<string, string> = {
  connected: "badge-success",
  active: "badge-success",
  syncing: "badge-info",
  pending: "badge-ghost",
  paused: "badge-warning",
  migration_required: "badge-warning",
  failed: "badge-error",
};

export function SeRankingSyncStatusSection({
  configured,
  projectId,
}: {
  configured: boolean;
  projectId?: string;
}) {
  const queryClient = useQueryClient();
  const statusQueryKey = ["seRankingSyncStatus", projectId ?? null];

  const syncQuery = useQuery({
    queryKey: statusQueryKey,
    queryFn: () => getSeRankingSyncStatusFn({ data: { projectId } }),
  });

  const migrateMutation = useMutation({
    mutationFn: () => migrateSeRankingAccountFn({ data: { projectId } }),
    onSuccess: async (res) => {
      await queryClient.invalidateQueries({
        queryKey: ["seRankingSyncStatus"],
      });
      toast.success(
        res.ok
          ? `Reconciled ${res.migratedProjectsCount} SE Ranking project(s)`
          : "Reconciliation completed with retryable warnings",
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(
          error,
          "Failed to reconcile SE Ranking account projects",
        ),
      );
    },
  });

  const retryProjectMutation = useMutation({
    mutationFn: (localProjectId: string) =>
      retrySeRankingProjectSyncFn({ data: { projectId: localProjectId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["seRankingSyncStatus"],
      });
      toast.success("Project synced with SE Ranking");
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Failed to retry project sync"),
      );
    },
  });

  const data = syncQuery.data;
  const projectsList = data?.projects ?? [];
  const activeAccount = data?.accounts[0];

  if (!configured && projectsList.length === 0 && !activeAccount) {
    return null;
  }

  return (
    <div className="space-y-3 border-t border-base-200 pt-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-xs font-semibold uppercase tracking-wide text-base-content/70">
            Account Migration & Project Sync State
          </h3>
          <p className="text-[11px] text-base-content/55">
            Project bindings reconcile non-destructively across credential
            updates. Old SE Ranking projects and historical OpenSEO snapshots
            are never deleted.
          </p>
        </div>
        {configured && (
          <button
            type="button"
            className="btn btn-outline btn-xs gap-1"
            disabled={migrateMutation.isPending}
            onClick={() => migrateMutation.mutate()}
          >
            {migrateMutation.isPending ? (
              <Loader2 className="size-3 animate-spin" />
            ) : (
              <RefreshCw className="size-3" />
            )}
            Reconcile & Migrate Projects
          </button>
        )}
      </div>

      {data && (data.needsMigrationCount > 0 || data.failedSyncCount > 0) && (
        <div className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
          <AlertTriangle className="size-4 shrink-0 mt-0.5" />
          <span>
            {data.needsMigrationCount > 0 &&
              `${data.needsMigrationCount} project binding(s) require migration reconciliation. `}
            {data.failedSyncCount > 0 &&
              `${data.failedSyncCount} project(s) have paused/failed syncs and can be retried below.`}
          </span>
        </div>
      )}

      {activeAccount && (
        <div className="flex flex-wrap items-center gap-3 rounded-md bg-base-200/50 px-3 py-2 text-[11px]">
          <span className="text-base-content/60">Account Binding:</span>
          <span
            className={`badge badge-xs ${
              STATUS_BADGE[activeAccount.status] ?? "badge-ghost"
            }`}
          >
            {activeAccount.status.replaceAll("_", " ")}
          </span>
          {activeAccount.lastValidatedAt && (
            <span className="text-base-content/60">
              Validated{" "}
              {new Date(activeAccount.lastValidatedAt).toLocaleString()}
            </span>
          )}
        </div>
      )}

      {projectsList.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-base-300">
          <table className="table table-xs">
            <thead>
              <tr>
                <th>Project</th>
                <th>Remote Site</th>
                <th>Targets / Keywords</th>
                <th>Sync Status</th>
                <th className="text-right">Action</th>
              </tr>
            </thead>
            <tbody>
              {projectsList.map((item) => (
                <tr key={item.projectBindingId}>
                  <td>
                    <div className="font-medium text-xs">
                      {item.projectName}
                    </div>
                    {item.projectDomain && (
                      <div className="text-[11px] text-base-content/50">
                        {item.projectDomain}
                      </div>
                    )}
                    {item.errorMessage && (
                      <div className="text-[11px] text-error max-w-xs truncate">
                        {item.errorMessage}
                      </div>
                    )}
                  </td>
                  <td className="font-mono text-xs">
                    {item.remoteSiteId ? `#${item.remoteSiteId}` : "Pending"}
                  </td>
                  <td className="text-xs text-base-content/70">
                    {item.engineBindingsCount} eng · {item.keywordMappingsCount}{" "}
                    kw
                  </td>
                  <td>
                    <span
                      className={`badge badge-xs ${
                        STATUS_BADGE[item.status] ?? "badge-ghost"
                      }`}
                    >
                      {item.status.replaceAll("_", " ")}
                    </span>
                    {!item.isLatestForProject && (
                      <span className="ml-1 text-[10px] text-base-content/45">
                        (history)
                      </span>
                    )}
                  </td>
                  <td className="text-right">
                    {item.isLatestForProject && configured && (
                      <button
                        type="button"
                        className="btn btn-ghost btn-xs gap-1"
                        disabled={retryProjectMutation.isPending}
                        onClick={() =>
                          retryProjectMutation.mutate(item.localProjectId)
                        }
                      >
                        {retryProjectMutation.isPending ? (
                          <Loader2 className="size-3 animate-spin" />
                        ) : (
                          <RefreshCw className="size-3" />
                        )}
                        Retry Sync
                      </button>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
