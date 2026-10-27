import { AlertTriangle } from "lucide-react";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";

type LatestRunForAlerts =
  | {
      maybeStale?: boolean;
      status?: string;
      errorMessage?: string | null;
    }
  | null
  | undefined;

/** Status banners: credit-skip warning, stale-run warning, failed-run error. */
export function ConfigAlerts({
  config,
  latestRun,
  onDismissStale,
  isDismissing,
}: {
  config: RankTrackingConfig;
  latestRun: LatestRunForAlerts;
  onDismissStale?: () => void;
  isDismissing?: boolean;
}) {
  return (
    <>
      {config.lastSkipReason === "insufficient_credits" && (
        <div className="alert alert-warning text-sm py-2">
          <AlertTriangle className="size-4" />
          <span>
            Last scheduled check was skipped due to insufficient credits. Top up
            your balance to resume automatic tracking.
          </span>
        </div>
      )}

      {latestRun?.maybeStale && (
        <div className="alert alert-warning text-sm py-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2">
            <AlertTriangle className="size-4 shrink-0" />
            <span>
              This run may be unresponsive and will be cleaned up automatically.
            </span>
          </div>
          {onDismissStale && (
            <button
              type="button"
              className="btn btn-xs btn-outline btn-warning shrink-0"
              onClick={onDismissStale}
              disabled={isDismissing}
            >
              Clear now
            </button>
          )}
        </div>
      )}

      {/* A failed run leaves rows in "Not checked" with no snapshot behind,
          which is indistinguishable from "never checked" in the table. Call
          it out explicitly so Position never stays an unexplained "-". */}
      {latestRun?.status === "failed" && (
        <div className="alert alert-error text-sm py-2">
          <AlertTriangle className="size-4" />
          <span>
            Last rank check failed
            {latestRun.errorMessage ? `: ${latestRun.errorMessage}` : "."} Open
            Settings → Debug Trace for the per-keyword breakdown.
          </span>
        </div>
      )}
    </>
  );
}
