import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Loader2, SearchX, Zap } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import { getMissingRankingsSummary } from "@/serverFunctions/rank-tracking";
import {
  estimateRankCheckCredits,
  devicesCount,
  KEYWORDS_PER_BATCH,
  SECONDS_PER_BATCH,
  type MissingRankingBucket,
  type MissingRankingsBreakdown,
} from "@/shared/rank-tracking";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

export function calculateActiveCount(
  breakdown: MissingRankingsBreakdown | undefined,
  selectedStates: readonly MissingRankingBucket[],
): number {
  if (!breakdown) return 0;
  let count = 0;
  if (selectedStates.includes("ranking_unavailable")) {
    count += breakdown.ranking_unavailable;
  }
  if (selectedStates.includes("lost")) {
    count += breakdown.lost;
  }
  if (selectedStates.includes("no_ranking")) {
    count += breakdown.no_ranking;
  }
  return count;
}

export function calculateEtaSeconds(
  count: number,
  devices: RankTrackingConfig["devices"],
): number {
  const dc = devicesCount(devices);
  const totalChecks = count * dc;
  return Math.ceil(totalChecks / KEYWORDS_PER_BATCH) * SECONDS_PER_BATCH;
}

export function formatEta(seconds: number): string {
  if (seconds === 0) return "0s";
  return seconds < 60 ? `${seconds}s` : `${Math.ceil(seconds / 60)} min`;
}

export function isRunButtonDisabled(
  isPending: boolean,
  activeCount: number,
): boolean {
  return isPending || activeCount === 0;
}

export const STATE_OPTIONS: Array<{
  key: MissingRankingBucket;
  label: string;
}> = [
  { key: "ranking_unavailable", label: "Ranking unavailable" },
  { key: "lost", label: "Lost" },
  { key: "no_ranking", label: "No ranking" },
];

/**
 * Confirmation for "Check missing rankings". The eligible count and per-bucket
 * breakdown are resolved server-side from persisted snapshot state — the same
 * query the trigger uses — so the numbers are truthful for the exact scope
 * being confirmed (selection or config-wide).
 *
 * Users can choose any combination of the three missing-ranking states
 * (Ranking unavailable, Lost, No ranking). Keyword count, estimated cost,
 * and ETA update immediately.
 *
 * Zero eligible/selected keywords disables Run Now instead of starting an empty run.
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
  onRunNow: (
    eligibleCount: number,
    keywordIds?: string[],
    missingRankingStates?: MissingRankingBucket[],
  ) => void;
  onCancel: () => void;
}) {
  const [selectedStates, setSelectedStates] = useState<MissingRankingBucket[]>([
    "ranking_unavailable",
    "lost",
    "no_ranking",
  ]);

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

  const totalEligibleCount = summary?.eligibleCount ?? 0;
  const breakdown = summary?.breakdown;
  const requestedCount = keywordIds?.length;

  const activeCount = useMemo(
    () => calculateActiveCount(breakdown, selectedStates),
    [breakdown, selectedStates],
  );

  const cost = estimateRankCheckCredits(
    activeCount,
    devices,
    serpDepth,
    "live",
  );
  const liveTime = calculateEtaSeconds(activeCount, devices);
  const etaText = formatEta(activeCount === 0 ? 0 : liveTime);

  const toggleState = (state: MissingRankingBucket) => {
    setSelectedStates((prev) =>
      prev.includes(state) ? prev.filter((s) => s !== state) : [...prev, state],
    );
  };

  const handleSelectAll = () => {
    setSelectedStates(["ranking_unavailable", "lost", "no_ranking"]);
  };

  const handleClearAll = () => {
    setSelectedStates([]);
  };

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
          {requestedCount !== undefined
            ? `${totalEligibleCount} of ${requestedCount} selected keyword${requestedCount !== 1 ? "s" : ""} need a ranking check.`
            : `${totalEligibleCount} keyword${totalEligibleCount !== 1 ? "s" : ""} need a ranking check.`}
        </p>
      </div>

      {isLoading ? (
        <div className="flex items-center justify-center py-6">
          <Loader2 className="size-5 animate-spin text-base-content/50" />
        </div>
      ) : (
        <>
          {breakdown && (
            <div className="space-y-2">
              <div className="flex items-center justify-between text-xs text-base-content/60">
                <span>Select which ranking states to check:</span>
                <div className="flex items-center gap-1.5 font-medium">
                  <button
                    type="button"
                    onClick={handleSelectAll}
                    className="hover:text-primary transition-colors cursor-pointer"
                  >
                    Select all
                  </button>
                  <span className="text-base-content/30">|</span>
                  <button
                    type="button"
                    onClick={handleClearAll}
                    className="hover:text-primary transition-colors cursor-pointer"
                  >
                    Clear all
                  </button>
                </div>
              </div>

              <div className="space-y-1.5">
                {STATE_OPTIONS.map(({ key, label }) => {
                  const isChecked = selectedStates.includes(key);
                  const count = breakdown[key];
                  return (
                    <label
                      key={key}
                      className={`flex items-center justify-between px-3 py-2 rounded-lg border transition-colors cursor-pointer ${
                        isChecked
                          ? "border-primary/40 bg-primary/5 text-base-content"
                          : "border-base-200 hover:border-base-300 text-base-content/70"
                      }`}
                    >
                      <div className="flex items-center gap-2.5">
                        <input
                          type="checkbox"
                          className="checkbox checkbox-primary checkbox-sm rounded"
                          checked={isChecked}
                          onChange={() => toggleState(key)}
                        />
                        <span className="text-xs font-medium">{label}</span>
                      </div>
                      <span className="font-mono text-xs text-base-content/70">
                        {count}
                      </span>
                    </label>
                  );
                })}
              </div>

              <div className="flex items-center justify-between pt-1 text-xs text-base-content/70 border-t border-base-200">
                <span className="font-semibold">Selected for check:</span>
                <span className="font-mono font-semibold text-base-content">
                  {activeCount} {activeCount === 1 ? "keyword" : "keywords"}
                </span>
              </div>
            </div>
          )}

          <button
            className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5 disabled:opacity-50 disabled:hover:border-base-300 disabled:hover:bg-transparent"
            onClick={() => onRunNow(activeCount, keywordIds, selectedStates)}
            disabled={isPending || activeCount === 0}
          >
            <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
              {activeCount === 0 ? (
                <SearchX className="size-5 text-base-content/40" />
              ) : (
                <Zap className="size-5 text-primary" />
              )}
            </div>
            <div className="flex-1">
              <p className="font-medium">
                {activeCount === 0
                  ? "No keywords selected"
                  : `Check ${activeCount} keyword${activeCount !== 1 ? "s" : ""}`}
              </p>
              <p className="text-xs text-base-content/60">
                {activeCount === 0
                  ? "Select at least one ranking state to check."
                  : `Results in ~${etaText}`}
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
