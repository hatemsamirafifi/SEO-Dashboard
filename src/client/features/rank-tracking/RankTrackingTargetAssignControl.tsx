import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Loader2 } from "lucide-react";
import { toast } from "sonner";
import { Modal } from "@/client/components/Modal";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { setKeywordTargetAssignmentsFn } from "@/serverFunctions/rank-tracking-targets";
import type { RankTrackingTarget } from "@/types/schemas/rank-tracking";

export function RemoveKeywordsConfirmModal({
  selectedCount,
  isPending,
  onConfirm,
  onClose,
}: {
  selectedCount: number;
  isPending: boolean;
  onConfirm: () => void;
  onClose: () => void;
}) {
  return (
    <Modal onClose={onClose} labelledBy="remove-keywords-title">
      <h3 id="remove-keywords-title" className="text-lg font-semibold">
        Remove keywords?
      </h3>
      <p className="text-sm text-base-content/70">
        This will stop tracking {selectedCount} keyword
        {selectedCount !== 1 ? "s" : ""}. Historical ranking data is preserved
        but won&apos;t appear in the table.
      </p>
      <div className="flex justify-end gap-2">
        <button className="btn btn-ghost btn-sm" onClick={onClose}>
          Cancel
        </button>
        <button
          className="btn btn-error btn-sm gap-1"
          onClick={onConfirm}
          disabled={isPending}
        >
          {isPending && <Loader2 className="size-3 animate-spin" />}
          Remove {selectedCount} keyword{selectedCount !== 1 ? "s" : ""}
        </button>
      </div>
    </Modal>
  );
}

export function BulkTargetAssignControl({
  projectId,
  targets,
  selectedKeywordIds,
}: {
  projectId: string;
  targets?: RankTrackingTarget[];
  selectedKeywordIds: string[];
}) {
  const queryClient = useQueryClient();
  const [bulkTargetId, setBulkTargetId] = useState("");
  const activeTargets = (targets ?? []).filter((t) => t.enabled);
  const effectiveTargetId = bulkTargetId || activeTargets[0]?.id || "";

  const mutation = useMutation({
    mutationFn: ({
      targetId,
      enabled,
    }: {
      targetId: string;
      enabled: boolean;
    }) =>
      setKeywordTargetAssignmentsFn({
        data: {
          projectId,
          targetId,
          keywordIds: selectedKeywordIds,
          enabled,
        },
      }),
    onSuccess: async (_res, vars) => {
      await queryClient.invalidateQueries({
        queryKey: ["rankKeywordTargetAssignments", projectId],
      });
      toast.success(
        vars.enabled
          ? `Assigned ${selectedKeywordIds.length} keyword(s) to target`
          : `Unassigned ${selectedKeywordIds.length} keyword(s) from target`,
      );
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Failed to assign keywords to target"),
      );
    },
  });

  if (activeTargets.length === 0) return null;

  return (
    <div className="inline-flex items-center gap-1 pl-1.5 border-l border-base-300 ml-1">
      <select
        aria-label="Target for selected keywords"
        className="select select-bordered select-xs h-7 text-[11px]"
        value={effectiveTargetId}
        onChange={(e) => setBulkTargetId(e.target.value)}
      >
        {activeTargets.map((t) => (
          <option key={t.id} value={t.id}>
            {t.countryCode.toUpperCase()}
            {t.cityName ? ` · ${t.cityName}` : ""} ({t.languageCode} ·{" "}
            {t.device})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn btn-xs h-7 btn-ghost border border-base-300"
        disabled={mutation.isPending || !effectiveTargetId}
        onClick={() =>
          mutation.mutate({ targetId: effectiveTargetId, enabled: true })
        }
      >
        Assign
      </button>
    </div>
  );
}

export function KeywordTargetAssignPills({
  projectId,
  keywordId,
  targets,
  assignedTargetIds,
}: {
  projectId: string;
  keywordId: string;
  targets?: RankTrackingTarget[];
  assignedTargetIds?: string[];
}) {
  const queryClient = useQueryClient();
  const toggleMutation = useMutation({
    mutationFn: ({
      targetId,
      enabled,
    }: {
      targetId: string;
      enabled: boolean;
    }) =>
      setKeywordTargetAssignmentsFn({
        data: { projectId, targetId, keywordIds: [keywordId], enabled },
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: ["rankKeywordTargetAssignments", projectId],
      });
    },
    onError: (error) => {
      toast.error(
        getStandardErrorMessage(error, "Failed to update target assignment"),
      );
    },
  });

  const activeTargets = (targets ?? []).filter((t) => t.enabled);
  if (activeTargets.length === 0) return null;

  return (
    <div className="flex flex-wrap items-center gap-1.5 rounded-md bg-base-200/40 px-2.5 py-2">
      <span className="text-[11px] font-medium text-base-content/60 mr-1">
        Assigned targets:
      </span>
      {activeTargets.map((t) => {
        const isAssigned = (assignedTargetIds ?? []).includes(t.id);
        return (
          <button
            key={t.id}
            type="button"
            disabled={toggleMutation.isPending}
            className={`btn btn-xs h-5 min-h-0 px-2 text-[10px] ${
              isAssigned ? "btn-primary" : "btn-ghost border border-base-300"
            }`}
            onClick={() =>
              toggleMutation.mutate({ targetId: t.id, enabled: !isAssigned })
            }
          >
            {t.countryCode.toUpperCase()}
            {t.cityName ? `·${t.cityName}` : ""} ({t.languageCode} · {t.device})
          </button>
        );
      })}
    </div>
  );
}
