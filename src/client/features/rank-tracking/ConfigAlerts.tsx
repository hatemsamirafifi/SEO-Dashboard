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
}: {
  config: RankTrackingConfig;
  latestRun: LatestRunForAlerts;
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
        <div className="alert alert-warning text-sm py-2">
          <AlertTriangle className="size-4" />
          <span>
            This run may be unresponsive and will be cleaned up automatically.
          </span>
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
