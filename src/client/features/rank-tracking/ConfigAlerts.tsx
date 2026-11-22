import { AlertTriangle, ShieldCheck } from "lucide-react";
import type { RankTrackingConfig } from "@/types/schemas/rank-tracking";
import { APPROVED_PILOT_CONFIG_ID } from "@/shared/rank-tracking";

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
      {config.id === APPROVED_PILOT_CONFIG_ID && config.isActive && (
        <div className="alert alert-info/10 border border-info/30 text-xs py-2.5 flex items-start gap-2.5">
          <ShieldCheck className="size-4 text-info shrink-0 mt-0.5" />
          <div className="space-y-1">
            <div className="flex flex-wrap items-center gap-1.5 font-semibold text-info">
              <span>Scheduled Read-Only Pilot Active</span>
              <span className="badge badge-xs badge-info badge-outline font-normal">
                1 keyword · 2 observation pairs
              </span>
              <span className="badge badge-xs badge-success badge-outline font-normal">
                read-only sync · 0 paid recheck POSTs
              </span>
            </div>
            <p className="text-base-content/70">
              The scheduled background runner is restricted strictly to{" "}
              <strong>1 approved keyword</strong> (
              <em>إنشاء ملاعب متعددة الأغراض</em>) across{" "}
              <strong>2 targets</strong> (Desktop &amp; Mobile, 2 observation
              pairs) via GET synchronization. Full project capacity (
              <strong>196 checks</strong>) is never executed automatically.
            </p>
          </div>
        </div>
      )}

      {config.lastSkipReason === "insufficient_credits" && (
        <div className="alert alert-warning text-sm py-2">
          <AlertTriangle className="size-4" />
          <span>
            Last scheduled check was skipped due to insufficient credits. Top up
            your balance to resume automatic tracking.
          </span>
        </div>
      )}

      {config.lastSkipReason &&
        config.lastSkipReason !== "insufficient_credits" && (
          <div className="alert alert-info text-sm py-2">
            <AlertTriangle className="size-4" />
            <span>Scheduled check notice: {config.lastSkipReason}</span>
          </div>
        )}

      {!config.isActive && (
        <div className="alert alert-warning text-sm py-2">
          <AlertTriangle className="size-4" />
          <span>Scheduled rank tracking is paused for this domain.</span>
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
