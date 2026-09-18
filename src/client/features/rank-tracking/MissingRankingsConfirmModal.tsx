import { useQuery } from "@tanstack/react-query";
import { Loader2, SearchX, Zap } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import { getMissingRankingsSummary } from "@/serverFunctions/rank-tracking";
import {
  estimateRankCheckCredits,
  devicesCount,
  KEYWORDS_PER_BATCH,
  SECONDS_PER_BATCH,
} from "@/shared/rank-tracking";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

/**
 * Confirmation for "Check missing rankings". The eligible count and per-bucket
 * breakdown are resolved server-side from persisted snapshot state — the same
 * query the trigger uses — so the numbers are truthful for the exact scope
 * being confirmed (selection or config-wide). Zero eligible keywords disables
 * Run Now instead of starting an empty run.
 */
export function MissingRankingsConfirmModal({
  configId,
  projectId,
  keywordIds,
  devices,
  serpDepth,
  isPending,
  onRunNow,
  onCancel,
}: {
  configId: string;
  projectId: string;
  keywordIds?: string[];
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  isPending: boolean;
  onRunNow: (eligibleCount: number, keywordIds?: string[]) => void;
  onCancel: () => void;
}) {
  const { data: summary, isLoading } = useQuery({
    queryKey: [
      "rankTrackingMissingRankings",
      projectId,
      configId,
      keywordIds ?? null,
    ],
    queryFn: () =>
      getMissingRankingsSummary({
        data: { projectId, configId, keywordIds },
      }),
  });

  const eligibleCount = summary?.eligibleCount ?? 0;
  const breakdown = summary?.breakdown;
  const selectedCount = keywordIds?.length;
  const dc = devicesCount(devices);
  const totalChecks = eligibleCount * dc;
  const cost = estimateRankCheckCredits(
    eligibleCount,
    devices,
    serpDepth,
    "live",
  );
  const liveTime =
    Math.ceil(totalChecks / KEYWORDS_PER_BATCH) * SECONDS_PER_BATCH;

  return (
    <Modal
      maxWidth="max-w-md"
      onClose={onCancel}
      labelledBy="missing-rankings-confirm-title"
    >
      <div>
        <h3
          id="missing-rankings-confirm-title"
          className="text-lg font-semibold"
        >
          Check missing rankings
        </h3>
        <p className="text-sm text-base-content/60 mt-1">
          {selectedCount !== undefined
            ? `${eligibleCount} of ${selectedCount} selected keyword${selectedCount !== 1 ? "s" : ""} need a ranking check.`
            : `${eligibleCount} keyword${eligibleCount !== 1 ? "s" : ""} need a ranking check.`}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-base-content/50" />
        </div>
      ) : (
        <>
          {breakdown && (
            <div className="rounded-lg border border-base-300 p-3 text-xs space-y-1">
              <div className="font-semibold text-base-content/70">
                Missing rankings: {eligibleCount}
              </div>
              <div className="flex justify-between text-base-content/70">
                <span>Ranking unavailable</span>
                <span className="font-mono">
                  {breakdown.ranking_unavailable}
                </span>
              </div>
              <div className="flex justify-between text-base-content/70">
                <span>Lost</span>
                <span className="font-mono">{breakdown.lost}</span>
              </div>
              <div className="flex justify-between text-base-content/70">
                <span>No ranking</span>
                <span className="font-mono">{breakdown.no_ranking}</span>
              </div>
            </div>
          )}

          <button
            className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50"
            onClick={() => onRunNow(eligibleCount, keywordIds)}
            disabled={isPending || eligibleCount === 0}
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              {eligibleCount === 0 ? (
                <SearchX className="size-5 text-base-content/40" />
              ) : (
                <Zap className="size-5 text-primary" />
              )}
            </div>
            <div className="flex-1">
              <p className="font-medium">
                {eligibleCount === 0
                  ? "No keywords need a check"
                  : `Check ${eligibleCount} keyword${eligibleCount !== 1 ? "s" : ""}`}
              </p>
              <p className="text-xs text-base-content/60">
                {eligibleCount === 0
                  ? "Every keyword in scope currently has a ranking."
                  : `Results in ~${liveTime < 60 ? `${liveTime}s` : `${Math.ceil(liveTime / 60)} min`}`}
              </p>
            </div>
            <div className="text-right">
              <p className="font-mono font-semibold">
                ~${cost.costUsd.toFixed(2)}
              </p>
              {isPending && <Loader2 className="size-3 animate-spin ml-auto" />}
            </div>
          </button>
        </>
      )}

      <button className="btn btn-ghost btn-sm self-center" onClick={onCancel}>
        Cancel
      </button>
    </Modal>
  );
}
