import { BidiText } from "@/client/components/chat/bidiText";
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Clock,
  FileSearch,
  History,
  Hourglass,
  MessageSquare,
  Play,
  RotateCcw,
} from "lucide-react";
import type { SeoActionStatus } from "@/shared/samSeoAnalyst";
import type { ActionItemRow } from "./SamActionModals";

export interface VerificationDisplayState {
  statusLabel: string;
  isAwaitingNewerData: boolean;
  verificationAttempted: boolean;
  evidenceSufficient: boolean | null;
  outcomeBadgeLabel: string | null;
  outcomeTone: "success" | "warning" | "error" | "pending" | null;
  canVerify: boolean;
}

export function getVerificationDisplayState(
  item: Pick<ActionItemRow, "status" | "verificationOutcome">,
): VerificationDisplayState {
  const outcome = item.verificationOutcome ?? null;
  const verificationAttempted = outcome !== null;
  const isInsufficient = outcome === "insufficient_data";
  const evidenceSufficient = verificationAttempted ? !isInsufficient : null;

  // Never present insufficient_data as verified SEO improvement, even on legacy rows.
  const isAwaitingNewerData =
    item.status === "verification_pending" || isInsufficient;

  let statusLabel: string;
  if (item.status === "completed") {
    statusLabel = "Implementation Completed";
  } else if (item.status === "verification_pending") {
    statusLabel = "Verification Pending";
  } else if (item.status === "verified" && isInsufficient) {
    statusLabel = "Verification Pending";
  } else if (item.status === "verified") {
    statusLabel = "Verified";
  } else {
    statusLabel = item.status.replace(/_/g, " ");
  }

  let outcomeBadgeLabel: string | null = null;
  let outcomeTone: VerificationDisplayState["outcomeTone"] = null;

  if (outcome === "implemented_improved") {
    outcomeBadgeLabel = "Sufficient Evidence · Outcome: Improved";
    outcomeTone = "success";
  } else if (outcome === "implemented_unchanged") {
    outcomeBadgeLabel = "Sufficient Evidence · Outcome: Unchanged";
    outcomeTone = "warning";
  } else if (outcome === "implemented_declined") {
    outcomeBadgeLabel = "Sufficient Evidence · Outcome: Declined";
    outcomeTone = "error";
  } else if (outcome === "insufficient_data") {
    outcomeBadgeLabel =
      "Verification Attempted · Insufficient Evidence (Awaiting Newer Data)";
    outcomeTone = "pending";
  } else if (item.status === "verification_pending") {
    outcomeBadgeLabel = "Verification Pending · Awaiting Newer Data";
    outcomeTone = "pending";
  }

  const canVerify =
    item.status === "completed" ||
    item.status === "verification_pending" ||
    (item.status === "verified" && isInsufficient);

  return {
    statusLabel,
    isAwaitingNewerData,
    verificationAttempted,
    evidenceSufficient,
    outcomeBadgeLabel,
    outcomeTone,
    canVerify,
  };
}

export function ActionCard({
  item,
  isPending,
  onTransition,
  onVerify,
  onOpenNotes,
  onOpenHistory,
  onOpenEvidence,
}: {
  item: ActionItemRow;
  isPending: boolean;
  onTransition: (targetStatus: SeoActionStatus, notes?: string) => void;
  onVerify: () => void;
  onOpenNotes: () => void;
  onOpenHistory: () => void;
  onOpenEvidence: () => void;
}) {
  const verification = getVerificationDisplayState(item);

  return (
    <div
      data-testid="seo-action-card"
      className="rounded-xl border border-base-300 bg-base-100 p-5 shadow-sm transition-all hover:border-base-content/20"
    >
      <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`badge badge-sm font-semibold ${
                item.priority === "Critical"
                  ? "badge-error"
                  : item.priority === "High"
                    ? "badge-warning"
                    : item.priority === "Medium"
                      ? "badge-info"
                      : "badge-ghost"
              }`}
            >
              {item.priority}
            </span>
            <span
              data-testid="seo-action-status-badge"
              className={`badge badge-sm capitalize ${
                verification.isAwaitingNewerData
                  ? "badge-warning badge-outline"
                  : item.status === "verified"
                    ? "badge-info badge-outline"
                    : item.status === "completed"
                      ? "badge-success badge-outline"
                      : "badge-outline"
              }`}
            >
              {verification.statusLabel}
            </span>
            <span dir="ltr" className="text-xs text-base-content/50">
              Category: {item.category.replace(/_/g, " ")}
            </span>
          </div>
          <h3
            dir="auto"
            className="wrap-anywhere text-base font-semibold text-base-content"
          >
            <BidiText text={item.title} />
          </h3>
        </div>

        {verification.outcomeBadgeLabel ? (
          <div
            data-testid="seo-action-verification-badge"
            className={`inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-semibold ${
              verification.outcomeTone === "success"
                ? "bg-success/15 text-success"
                : verification.outcomeTone === "warning"
                  ? "bg-warning/15 text-warning"
                  : verification.outcomeTone === "error"
                    ? "bg-error/15 text-error"
                    : "bg-warning/10 text-warning border border-warning/30"
            }`}
          >
            {verification.outcomeTone === "success" ? (
              <CheckCircle2 className="size-3.5 shrink-0" />
            ) : verification.outcomeTone === "warning" ? (
              <Clock className="size-3.5 shrink-0" />
            ) : verification.outcomeTone === "error" ? (
              <AlertTriangle className="size-3.5 shrink-0" />
            ) : (
              <Hourglass className="size-3.5 shrink-0" />
            )}
            <span>{verification.outcomeBadgeLabel}</span>
          </div>
        ) : null}
      </div>

      {item.description ? (
        <p
          dir="auto"
          className="mt-2 wrap-anywhere text-sm text-base-content/70"
        >
          <BidiText text={item.description} />
        </p>
      ) : null}

      <div className="mt-3 rounded-lg bg-base-200/50 p-3 text-xs space-y-1.5">
        <div>
          <span dir="ltr" className="font-semibold text-base-content/80">
            Recommended Action:
          </span>{" "}
          <bdi className="wrap-anywhere text-base-content/90">
            <BidiText text={item.recommendedAction ?? ""} />
          </bdi>
        </div>
        <div className="flex flex-wrap gap-x-4 gap-y-1 text-base-content/70">
          {item.targetKeyword ? (
            <div>
              <span dir="ltr" className="font-medium">
                Target Keyword:
              </span>{" "}
              <bdi className="wrap-anywhere text-primary">
                {item.targetKeyword}
              </bdi>
            </div>
          ) : null}
          {item.targetUrl ? (
            <div>
              <span dir="ltr" className="font-medium">
                Target URL:
              </span>{" "}
              <bdi dir="ltr" className="wrap-anywhere font-mono text-primary">
                {item.targetUrl}
              </bdi>
            </div>
          ) : null}
          {item.baselineValue ? (
            <div>
              <span dir="ltr" className="font-medium">
                Baseline:
              </span>{" "}
              <bdi>{item.baselineValue}</bdi>
            </div>
          ) : null}
          <div>
            <span dir="ltr" className="font-medium">
              Validation Metric:
            </span>{" "}
            <bdi>{item.validationMetric}</bdi>
          </div>
        </div>
        {item.verificationNotes ? (
          <div className="pt-1 text-xs text-base-content/80 border-t border-base-300">
            <span dir="ltr" className="font-semibold">
              {verification.evidenceSufficient === false
                ? "Verification Attempt (Awaiting Newer Data):"
                : "Verification Notes:"}
            </span>{" "}
            <bdi>
              <BidiText text={item.verificationNotes} />
            </bdi>
          </div>
        ) : null}
      </div>

      <div className="mt-4 flex flex-wrap items-center justify-between gap-2 border-t border-base-200 pt-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={onOpenEvidence}
            className="btn btn-ghost btn-xs gap-1 text-base-content/60"
          >
            <FileSearch className="size-3" />
            Evidence
          </button>
          <button
            type="button"
            onClick={onOpenHistory}
            className="btn btn-ghost btn-xs gap-1 text-base-content/60"
          >
            <History className="size-3" />
            History
          </button>
          <button
            type="button"
            onClick={onOpenNotes}
            className="btn btn-ghost btn-xs gap-1 text-base-content/60"
          >
            <MessageSquare className="size-3" />
            Add Note
          </button>
        </div>

        <div className="flex flex-wrap items-center gap-2">
          {item.status === "proposed" ? (
            <>
              <button
                type="button"
                disabled={isPending}
                onClick={() =>
                  onTransition("accepted", "Accepted task for implementation")
                }
                className="btn btn-primary btn-xs gap-1"
              >
                <Check className="size-3" />
                Accept Task
              </button>
              <button
                type="button"
                disabled={isPending}
                onClick={() => onTransition("dismissed", "Dismissed by user")}
                className="btn btn-ghost btn-xs text-base-content/50"
              >
                Dismiss
              </button>
            </>
          ) : null}

          {item.status === "accepted" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                onTransition("in_progress", "Started task implementation")
              }
              className="btn btn-primary btn-xs gap-1"
            >
              <Play className="size-3" />
              Start Implementation
            </button>
          ) : null}

          {item.status === "in_progress" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() =>
                onTransition("completed", "Implementation completed by user")
              }
              className="btn btn-success btn-xs gap-1 text-white"
            >
              <Check className="size-3" />
              Mark Completed
            </button>
          ) : null}

          {verification.canVerify ? (
            <button
              type="button"
              disabled={isPending}
              onClick={onVerify}
              className="btn btn-info btn-xs gap-1 text-white"
            >
              <CheckCircle2 className="size-3" />
              {verification.verificationAttempted
                ? "Re-verify Progress"
                : "Verify Progress"}
            </button>
          ) : null}

          {item.status === "verification_pending" ||
          item.status === "verified" ||
          item.status === "dismissed" ? (
            <button
              type="button"
              disabled={isPending}
              onClick={() => onTransition("reopened", "Reopened by user")}
              className="btn btn-ghost btn-xs gap-1 text-base-content/70"
            >
              <RotateCcw className="size-3" />
              Reopen
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
}
