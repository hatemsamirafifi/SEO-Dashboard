import { Loader2, Zap } from "lucide-react";
import { Modal } from "@/client/components/Modal";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import {
  estimateRankCheckCredits,
  devicesCount,
  KEYWORDS_PER_BATCH,
  QUEUED_RESULTS_WINDOW_TEXT,
  resolveRankCheckMethod,
  SECONDS_PER_BATCH,
} from "@/shared/rank-tracking";

/**
 * The copy under the "Run Now" button: an instant-results ETA only for a
 * single-keyword live check; queued bulk checks never show instant time.
 * Exported for unit tests so the cost/time/method contract stays pinned.
 */
export function runNowCopy(input: {
  keywordCount: number;
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
}): { costUsd: number; method: "live" | "queued"; etaText: string } {
  const method = resolveRankCheckMethod("manual", input.keywordCount);
  const { costUsd } = estimateRankCheckCredits(
    input.keywordCount,
    input.devices,
    input.serpDepth,
    method,
  );
  if (method === "queued") {
    return { costUsd, method, etaText: QUEUED_RESULTS_WINDOW_TEXT };
  }
  const totalChecks = input.keywordCount * devicesCount(input.devices);
  const liveTime =
    Math.ceil(totalChecks / KEYWORDS_PER_BATCH) * SECONDS_PER_BATCH;
  return {
    costUsd,
    method,
    etaText:
      liveTime < 60
        ? `Results in ~${liveTime}s`
        : `Results in ~${Math.ceil(liveTime / 60)} min`,
  };
}

export function CheckConfirmModal({
  keywordCount,
  devices,
  serpDepth,
  isPending,
  onRunNow,
  onCancel,
}: {
  keywordCount: number;
  devices: RankTrackingConfig["devices"];
  serpDepth: number;
  isPending: boolean;
  onRunNow: () => void;
  onCancel: () => void;
}) {
  const { costUsd, etaText, method } = runNowCopy({
    keywordCount,
    devices,
    serpDepth,
  });
  const dc = devicesCount(devices);
  const totalChecks = keywordCount * dc;

  return (
    <Modal
      maxWidth="max-w-md"
      onClose={onCancel}
      labelledBy="rank-check-confirm-title"
    >
      <div>
        <h3 id="rank-check-confirm-title" className="text-lg font-semibold">
          Check {keywordCount} keyword
          {keywordCount !== 1 ? "s" : ""}
        </h3>
        <p className="text-sm text-base-content/60 mt-1">
          {keywordCount} keywords &times; {dc} device
          {dc !== 1 ? "s" : ""} = {totalChecks} SERP checks
        </p>
      </div>

      <button
        className="flex w-full items-center gap-4 rounded-xl border-2 border-base-300 p-4 text-left transition-colors hover:border-primary hover:bg-primary/5"
        onClick={onRunNow}
        disabled={isPending}
      >
        <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary/10">
          <Zap className="size-5 text-primary" />
        </div>
        <div className="flex-1">
          <p className="font-medium">
            Run Now
            {method === "queued" && (
              <span className="ml-1.5 text-xs font-normal text-base-content/50">
                (queued)
              </span>
            )}
          </p>
          <p className="text-xs text-base-content/60">{etaText}</p>
        </div>
        <div className="text-right">
          <p className="font-mono font-semibold">~${costUsd.toFixed(2)}</p>
          {isPending && <Loader2 className="size-3 animate-spin ml-auto" />}
        </div>
      </button>

      <button className="btn btn-ghost btn-sm self-center" onClick={onCancel}>
        Cancel
      </button>
    </Modal>
  );
}
