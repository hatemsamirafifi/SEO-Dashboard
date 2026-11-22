import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { AlertTriangle, CloudUpload, Loader2 } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import {
  confirmSeRankingSelectiveSync,
  type getSeRankingKeywordSyncStatusesFn,
  previewSeRankingSelectiveSync,
} from "@/serverFunctions/seranking-selective-sync";
import {
  computeSelectiveSyncPlan,
  normalizeKeywordIdentity,
  selectKeywordsWithWork,
  type SeRankingEngineMode,
  type SeRankingSelectiveSyncPlan,
} from "@/shared/seranking-selective-sync";

import { SyncOutcome, SyncPreview } from "./SeRankingSelectiveSyncCards";

export type SeRankingSelectiveSyncScope =
  | { type: "selected"; keywordIds: string[] }
  | { type: "allMissing" };

type PreviewResponse = Awaited<
  ReturnType<typeof previewSeRankingSelectiveSync>
>;
type ConfirmResult = Awaited<ReturnType<typeof confirmSeRankingSelectiveSync>>;

/**
 * Rebuilds the shared plan input from the preview payload so engine-mode
 * changes recompute counts client-side without another provider read.
 */
function buildPlanForMode(
  preview: PreviewResponse,
  engineMode: SeRankingEngineMode,
): SeRankingSelectiveSyncPlan | null {
  if (!preview.linked || !preview.inventory || !preview.engineBindings) {
    return null;
  }

  const byIdentity = new Map<string, { id: string; keyword: string }>();
  const engineMembership = new Map<number, Set<string>>();
  const mappings = new Map<
    string,
    { remoteKeywordId: string; status: string }
  >();
  const localKeywords = preview.keywords.map((k) => {
    const identity = normalizeKeywordIdentity(k.keyword);
    if (k.remoteKeywordId) {
      byIdentity.set(identity, { id: k.remoteKeywordId, keyword: k.keyword });
      if (k.mappedLocally) {
        mappings.set(k.trackingKeywordId, {
          remoteKeywordId: k.remoteKeywordId,
          status: k.mappingStatus ?? "synced",
        });
      }
      for (const [engineId, member] of Object.entries(k.engineMembership)) {
        if (!member) continue;
        const engineKey = Number(engineId);
        let members = engineMembership.get(engineKey);
        if (!members) {
          members = new Set<string>();
          engineMembership.set(engineKey, members);
        }
        members.add(k.remoteKeywordId);
      }
    }
    return {
      id: k.trackingKeywordId,
      keyword: k.keyword,
      assignedTargetIds: k.assignedTargetIds,
      hasExplicitAssignments: k.hasExplicitAssignments,
    };
  });

  return computeSelectiveSyncPlan({
    localKeywords,
    inventory: {
      status: preview.inventory.status,
      byIdentity,
      engineMembership,
      enginesWithUnknownMembership:
        preview.inventory.enginesWithUnknownMembership,
    },
    mappings,
    engineBindings: preview.engineBindings,
    engineMode,
    configDevices: preview.configDevices,
  });
}

export function SeRankingSelectiveSyncModal({
  projectId,
  configId,
  scope,
  onClose,
}: {
  projectId: string;
  configId: string;
  scope: SeRankingSelectiveSyncScope;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [engineMode, setEngineMode] =
    useState<SeRankingEngineMode>("assignments");
  const [confirmResult, setConfirmResult] = useState<ConfirmResult | null>(
    null,
  );

  const scopeKey =
    scope.type === "selected"
      ? `selected:${scope.keywordIds.toSorted().join(",")}`
      : "allMissing";

  const previewQuery = useQuery({
    queryKey: ["seRankingSelectiveSyncPreview", projectId, configId, scopeKey],
    queryFn: () =>
      previewSeRankingSelectiveSync({
        data: {
          projectId,
          configId,
          ...(scope.type === "selected"
            ? { keywordIds: scope.keywordIds }
            : { syncAllMissing: true }),
        },
      }),
  });

  const preview = previewQuery.data;
  const plan = useMemo(
    () => (preview ? buildPlanForMode(preview, engineMode) : null),
    [preview, engineMode],
  );

  const confirmMutation = useMutation({
    mutationFn: (input: {
      approvedKeywordIds: string[];
      engineMode: SeRankingEngineMode;
      expectedSiteId: number;
      expectedKeywords: Record<
        string,
        { engineIds: number[]; remoteKeywordId: string | null }
      >;
    }) =>
      confirmSeRankingSelectiveSync({
        data: {
          projectId,
          configId,
          ...(scope.type === "selected"
            ? { keywordIds: scope.keywordIds }
            : { syncAllMissing: true }),
          approvedKeywordIds: input.approvedKeywordIds,
          engineMode: input.engineMode,
          expectedSiteId: input.expectedSiteId,
          expectedKeywords: input.expectedKeywords,
        },
      }),
    onSuccess: async (result) => {
      setConfirmResult(result);
      // Refresh frontend queries; historical ranking observations are never
      // touched by the sync.
      const statusKey = ["seRankingKeywordSyncStatuses", projectId, configId];
      await queryClient.invalidateQueries({ queryKey: statusKey });
      const failedStatuses = Object.fromEntries(
        Object.entries(result.finalStatuses).filter(
          ([, status]) => status === "failed" || status === "unknown",
        ),
      );
      queryClient.setQueryData<
        Awaited<ReturnType<typeof getSeRankingKeywordSyncStatusesFn>>
      >(
        statusKey,
        (current) =>
          current && {
            ...current,
            statuses: { ...current.statuses, ...failedStatuses },
          },
      );
      await queryClient.invalidateQueries({
        queryKey: ["seRankingSyncStatus", projectId],
      });
      await queryClient.invalidateQueries({
        queryKey: ["rankTrackingCostEstimate", projectId, configId],
      });
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "SE Ranking keyword sync failed"),
      );
    },
  });

  const approvedKeywordIds = plan ? selectKeywordsWithWork(plan) : [];
  const approved = new Set(approvedKeywordIds);
  const expectedKeywords = Object.fromEntries(
    plan?.keywords
      .filter((keyword) => approved.has(keyword.trackingKeywordId))
      .map((keyword) => [
        keyword.trackingKeywordId,
        {
          engineIds: keyword.requiredEngineIds,
          remoteKeywordId: keyword.remoteKeywordId,
        },
      ]) ?? [],
  );

  const confirmDisabled =
    !plan ||
    approvedKeywordIds.length === 0 ||
    confirmMutation.isPending ||
    previewQuery.isFetching;

  return (
    <Modal
      maxWidth="max-w-2xl"
      onClose={confirmMutation.isPending ? undefined : onClose}
      labelledBy="seranking-selective-sync-title"
    >
      <div className="space-y-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h3
              id="seranking-selective-sync-title"
              className="text-lg font-semibold flex items-center gap-2"
            >
              <CloudUpload className="size-5 text-primary" />
              Add keywords to SE Ranking
            </h3>
            <p className="text-xs text-base-content/60 mt-0.5">
              {scope.type === "selected"
                ? `Sync ${scope.keywordIds.length} selected keyword${scope.keywordIds.length !== 1 ? "s" : ""} to the linked SE Ranking project`
                : "Sync all keywords missing from the linked SE Ranking project"}
            </p>
          </div>
          <button
            type="button"
            className="btn btn-ghost btn-xs btn-square"
            onClick={onClose}
            aria-label="Close"
            disabled={confirmMutation.isPending}
          >
            ✕
          </button>
        </div>

        {previewQuery.isPending && (
          <div className="flex items-center gap-2 text-sm text-base-content/60 py-8 justify-center">
            <Loader2 className="size-4 animate-spin" />
            Reading remote project state…
          </div>
        )}

        {previewQuery.isError && (
          <div className="alert alert-error text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              {getStandardErrorMessage(
                previewQuery.error,
                "Could not read the SE Ranking project",
              )}
            </span>
          </div>
        )}

        {preview && !preview.linked && (
          <div className="alert alert-warning text-sm">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              {preview.reason ?? "This project is not linked to SE Ranking."}
            </span>
          </div>
        )}

        {preview?.linked && !confirmResult && plan && (
          <SyncPreview
            preview={preview}
            plan={plan}
            engineMode={engineMode}
            onEngineModeChange={setEngineMode}
            onClose={onClose}
            pending={confirmMutation.isPending}
            disabled={confirmDisabled}
            onConfirm={() => {
              if (!preview.remoteProject) return;
              confirmMutation.mutate({
                approvedKeywordIds,
                engineMode,
                expectedSiteId: preview.remoteProject.siteId,
                expectedKeywords,
              });
            }}
          />
        )}

        {confirmResult && (
          <SyncOutcome
            confirmResult={confirmResult}
            onClose={onClose}
            onBack={() => {
              setConfirmResult(null);
              void previewQuery.refetch();
            }}
          />
        )}
      </div>
    </Modal>
  );
}
