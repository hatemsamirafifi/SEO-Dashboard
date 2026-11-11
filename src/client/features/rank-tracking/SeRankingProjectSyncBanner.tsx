import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, Loader2, RefreshCw } from "lucide-react";
import { toast } from "sonner";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  estimateRankCheckCost,
  getLatestRankResults,
  getMissingRankingsSummary,
  getRankPositionMatrix,
} from "@/serverFunctions/rank-tracking";
import {
  getKeywordTargetAssignments,
  getRankTrackingTargets,
  getSeRankingSyncStatusFn,
  retrySeRankingProjectSyncFn,
} from "@/serverFunctions/rank-tracking-targets";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import type { MissingRankingBucket } from "@/shared/rank-tracking";
import type {
  ComparePeriod,
  RankTrackingConfig,
  RankTrackingTarget,
} from "@/types/schemas/rank-tracking";
import { SerpClustersSection } from "@/client/features/serp-clustering/SerpClustersSection";
import { RankCheckModals } from "./RankCheckModals";
import { RankTrackingTargetsModal } from "./RankTrackingTargetsModal";

export interface PendingRankCheck {
  count: number;
  keywordIds?: string[];
  missingRankings?: boolean;
  initialStates?: MissingRankingBucket[];
}

export function createRankCheckScopeHandlers(params: {
  isBusy: boolean;
  startCheck: (opts: { keywordIds?: string[] }) => void;
  setPendingCheck: (next: PendingRankCheck | null) => void;
}) {
  const { isBusy, startCheck, setPendingCheck } = params;

  const requestCheck = (count: number, keywordIds?: string[]) => {
    if (count < 50) {
      startCheck({ keywordIds });
      return;
    }

    if (isBusy) {
      toast.info("A rank check is already running");
      return;
    }
    setPendingCheck({ count, keywordIds });
  };

  return {
    requestCheck,
    handleCheckSelected: (keywordIds: string[]) => {
      if (keywordIds.length > 0) requestCheck(keywordIds.length, keywordIds);
    },
    handleCheckMissingSelected: (keywordIds: string[]) => {
      if (keywordIds.length === 0) return;
      setPendingCheck({
        count: keywordIds.length,
        keywordIds,
        missingRankings: true,
      });
    },
    requestMissingRankingsCheck: (
      keywordIds?: string[],
      initialStates?: MissingRankingBucket[],
    ) =>
      setPendingCheck({
        count: keywordIds?.length ?? 0,
        keywordIds,
        missingRankings: true,
        initialStates,
      }),
    handleRetryFailed: () =>
      setPendingCheck({
        count: 0,
        missingRankings: true,
        initialStates: ["ranking_unavailable"],
      }),
  };
}

export const RANK_DETAIL_QUERY_KEYS = [
  "rankTrackingCostEstimate",
  "rankTrackingResults",
  "rankTrackingLatestRun",
  "rankConfigTrend",
  "rankPositionMatrix",
  "rankTrackingMissingRankings",
] as const;

export function notifyKeywordsAddedResult(result: {
  added: number;
  checkTriggered: boolean;
}) {
  toast.success(
    `${result.added} keyword${result.added !== 1 ? "s" : ""} added`,
  );
  if (!result.checkTriggered && result.added > 0) {
    toast.info("Use 'Check Now' to check these keywords");
  }
}

export function resolveDeviceVisibility(
  devices: RankTrackingConfig["devices"],
  activeDevice: "desktop" | "mobile",
  selectedTarget?: RankTrackingTarget,
): { showDesktop: boolean; showMobile: boolean } {
  if (selectedTarget) {
    return {
      showDesktop: selectedTarget.device === "desktop",
      showMobile: selectedTarget.device === "mobile",
    };
  }
  if (devices === "both") {
    return {
      showDesktop: activeDevice === "desktop",
      showMobile: activeDevice === "mobile",
    };
  }
  return {
    showDesktop: devices !== "mobile",
    showMobile: devices !== "desktop",
  };
}

export function RankTrackingDetailFooter({
  projectId,
  config,
  activeDevice,
  pendingCheck,
  isPending,
  onRunCheck,
  onCancelCheck,
  showTargetsModal,
  targets,
  onCloseTargetsModal,
}: {
  projectId: string;
  config: RankTrackingConfig;
  activeDevice: "desktop" | "mobile";
  pendingCheck: PendingRankCheck | null;
  isPending: boolean;
  onRunCheck: (opts: {
    keywordIds?: string[];
    missingRankings?: boolean;
    missingRankingStates?: MissingRankingBucket[];
  }) => void;
  onCancelCheck: () => void;
  showTargetsModal: boolean;
  targets?: RankTrackingTarget[];
  onCloseTargetsModal: () => void;
}) {
  return (
    <>
      <SerpClustersSection
        projectId={projectId}
        configId={config.id}
        device={activeDevice}
      />

      <RankCheckModals
        pendingCheck={pendingCheck}
        config={config}
        projectId={projectId}
        isPending={isPending}
        onRunCheck={onRunCheck}
        onCancel={onCancelCheck}
      />

      {showTargetsModal && (
        <RankTrackingTargetsModal
          projectId={projectId}
          configId={config.id}
          targets={targets ?? []}
          defaultCountryCode={getIsoCountryCode(config.locationCode)}
          defaultLanguageCode={config.languageCode}
          onClose={onCloseTargetsModal}
        />
      )}
    </>
  );
}

export function useRankTrackingDetailData(params: {
  projectId: string;
  configId: string;
  comparePeriod: ComparePeriod;
  activeDevice: "desktop" | "mobile";
  selectedTargetId?: string;
}) {
  const { projectId, configId, comparePeriod, activeDevice, selectedTargetId } =
    params;
  const queryClient = useQueryClient();

  const { data: resultsData, isLoading: resultsLoading } = useQuery({
    queryKey: [
      "rankTrackingResults",
      projectId,
      configId,
      comparePeriod,
      selectedTargetId ?? null,
    ],
    queryFn: () =>
      getLatestRankResults({
        data: {
          projectId,
          configId,
          comparePeriod,
          trackingTargetId: selectedTargetId,
        },
      }),
  });

  const { data: matrixCells, isLoading: matrixLoading } = useQuery({
    queryKey: [
      "rankPositionMatrix",
      projectId,
      configId,
      activeDevice,
      selectedTargetId ?? null,
    ],
    queryFn: () =>
      getRankPositionMatrix({
        data: {
          projectId,
          configId,
          device: activeDevice,
          trackingTargetId: selectedTargetId,
        },
      }),
  });

  const { data: costEstimate } = useQuery({
    queryKey: ["rankTrackingCostEstimate", projectId, configId],
    queryFn: () => estimateRankCheckCost({ data: { projectId, configId } }),
  });

  const { data: missingRankingsSummary, isLoading: missingRankingsLoading } =
    useQuery({
      queryKey: ["rankTrackingMissingRankings", projectId, configId],
      queryFn: () =>
        getMissingRankingsSummary({ data: { projectId, configId } }),
    });

  const { data: targets } = useQuery({
    queryKey: ["rankTrackingTargets", projectId],
    queryFn: () => getRankTrackingTargets({ data: { projectId } }),
  });

  const { data: targetAssignments } = useQuery({
    queryKey: ["rankKeywordTargetAssignments", projectId],
    queryFn: () => getKeywordTargetAssignments({ data: { projectId } }),
  });

  const { data: seSyncStatus } = useQuery({
    queryKey: ["seRankingSyncStatus", projectId],
    queryFn: () => getSeRankingSyncStatusFn({ data: { projectId } }),
  });

  const retrySyncMutation = useMutation({
    mutationFn: () =>
      retrySeRankingProjectSyncFn({ data: { projectId, configId } }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["seRankingSyncStatus"],
      });
      toast.success("SE Ranking sync completed");
    },
    onError: (error) => {
      toast.error(getStandardErrorMessage(error, "Failed to retry sync"));
    },
  });

  const latestSyncBinding = seSyncStatus?.projects.find(
    (p) => p.isLatestForProject,
  );
  const syncNeedsAttention =
    latestSyncBinding != null &&
    (latestSyncBinding.status === "failed" ||
      latestSyncBinding.status === "paused" ||
      latestSyncBinding.status === "migration_required");

  return {
    resultsData,
    resultsLoading,
    matrixCells,
    matrixLoading,
    costEstimate,
    missingRankingsSummary,
    missingRankingsLoading,
    targets,
    targetAssignments,
    latestSyncBinding: syncNeedsAttention ? latestSyncBinding : null,
    retryingSync: retrySyncMutation.isPending,
    onRetrySync: () => retrySyncMutation.mutate(),
  };
}

export function SeRankingProjectSyncBanner({
  status,
  errorMessage,
  retrying,
  onRetry,
}: {
  status: string;
  errorMessage: string | null;
  retrying: boolean;
  onRetry: () => void;
}) {
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-warning">
      <div className="flex items-center gap-2 min-w-0">
        <AlertTriangle className="size-4 shrink-0" />
        <span className="truncate">
          SE Ranking sync ({status.replaceAll("_", " ")}):{" "}
          {errorMessage || "Remote targets or keywords need synchronization."}
        </span>
      </div>
      <button
        type="button"
        className="btn btn-xs btn-warning btn-outline gap-1 shrink-0"
        disabled={retrying}
        onClick={onRetry}
      >
        {retrying ? (
          <Loader2 className="size-3 animate-spin" />
        ) : (
          <RefreshCw className="size-3" />
        )}
        Retry Sync
      </button>
    </div>
  );
}
