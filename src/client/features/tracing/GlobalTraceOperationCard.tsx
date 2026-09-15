import { useState } from "react";
import {
  AlertTriangle,
  Ban,
  Check,
  ChevronDown,
  ChevronRight,
  Clock,
  Database,
  DollarSign,
  Loader2,
  Server,
  ShieldAlert,
  Square,
  Trash2,
} from "lucide-react";
import type { GlobalTraceOperation } from "@/shared/globalTraceTypes";
import { formatTraceDuration } from "./globalTraceFormat";
import { isOperationCancellable } from "./cancellationRegistry";
import { globalTraceStore } from "./globalTraceStore";
import { CancelConfirmationModal } from "./CancelConfirmationModal";
import {
  BillingSection,
  ChildrenSection,
  ProviderSection,
  ScopeSection,
} from "./GlobalTraceOperationCardSections";

function StatusBadge({ status }: { status: GlobalTraceOperation["status"] }) {
  const badgeClasses: Record<GlobalTraceOperation["status"], string> = {
    pending: "bg-base-content/10 text-base-content/70",
    running: "bg-primary/15 text-primary",
    cancelling: "bg-warning/20 text-warning animate-pulse",
    success: "bg-success/15 text-success",
    failed: "bg-error/15 text-error",
    cancelled: "bg-warning/15 text-warning",
    blocked: "bg-warning/15 text-warning",
  };

  return (
    <span
      className={`rounded px-1.5 py-0.5 text-[11px] font-semibold uppercase tracking-wider ${badgeClasses[status] ?? "bg-base-content/10 text-base-content/70"}`}
    >
      {status}
    </span>
  );
}

function StatusIcon({ status }: { status: GlobalTraceOperation["status"] }) {
  if (status === "pending") {
    return <Clock className="size-4 text-base-content/50" />;
  }
  if (status === "running") {
    return <Loader2 className="size-4 animate-spin text-primary" />;
  }
  if (status === "cancelling") {
    return <Loader2 className="size-4 animate-spin text-warning" />;
  }
  if (status === "cancelled") {
    return <Ban className="size-4 text-warning" />;
  }
  if (status === "success") {
    return <Check className="size-4 text-success" />;
  }
  if (status === "failed") {
    return <AlertTriangle className="size-4 text-error" />;
  }
  return <ShieldAlert className="size-4 text-warning" />;
}

function CardSummary({ operation }: { operation: GlobalTraceOperation }) {
  return (
    <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-base-content/70">
      {operation.scope && (
        <span>
          <strong className="font-medium text-base-content">
            {operation.scope === "selected" ? "Selected" : "All"}
          </strong>
          {operation.selectedCount !== undefined && (
            <span>
              : {operation.selectedCount} requested
              {operation.validatedCount !== undefined &&
                ` · ${operation.validatedCount} validated`}
            </span>
          )}
        </span>
      )}

      {operation.provider && (
        <span className="flex items-center gap-1 font-mono text-base-content/80">
          <Server className="size-3" />
          {operation.provider}
        </span>
      )}

      {operation.httpStatus && (
        <span className="font-mono font-medium">
          HTTP {operation.httpStatus}
        </span>
      )}

      {operation.cache && (
        <span className="flex items-center gap-0.5 text-xs">
          <Database className="size-3" />
          Cache: {operation.cache}
        </span>
      )}

      {operation.billing && (
        <span className="flex items-center gap-0.5 text-xs">
          <DollarSign className="size-3" />
          {operation.billing}
        </span>
      )}

      {operation.budget && (
        <span
          className={`font-semibold ${
            operation.budget === "BLOCKED"
              ? "text-warning"
              : "text-base-content/70"
          }`}
        >
          Budget: {operation.budget}
        </span>
      )}
    </div>
  );
}

function CacheRetrySection({ operation }: { operation: GlobalTraceOperation }) {
  return (
    <div className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
      <div className="rounded border border-base-200 bg-base-100 p-2">
        <div className="text-base-content/60">Cache</div>
        <div className="font-semibold text-base-content">
          {operation.cache ?? "Not applicable"}
          {operation.cacheType && ` (${operation.cacheType})`}
        </div>
      </div>
      <div className="rounded border border-base-200 bg-base-100 p-2">
        <div className="text-base-content/60">Retry</div>
        <div className="font-semibold text-base-content">
          {operation.retry?.attempted ? `YES ×${operation.retry.count}` : "NO"}
        </div>
      </div>
      <div className="rounded border border-base-200 bg-base-100 p-2">
        <div className="text-base-content/60">Operation ID</div>
        <div className="truncate font-mono text-[11px] text-base-content/70">
          {operation.operationId}
        </div>
      </div>
      <div className="rounded border border-base-200 bg-base-100 p-2">
        <div className="text-base-content/60">Trace ID</div>
        <div className="truncate font-mono text-[11px] text-base-content/70">
          {operation.traceId}
        </div>
      </div>
    </div>
  );
}

export function GlobalTraceOperationCard({
  operation,
}: {
  operation: GlobalTraceOperation;
}) {
  const [expanded, setExpanded] = useState(false);
  const [showCancelModal, setShowCancelModal] = useState(false);

  const isRunning = operation.status === "running";
  const isPending = operation.status === "pending";
  const isCancelling = operation.status === "cancelling";
  const isBlocked = operation.status === "blocked";
  const isFailed = operation.status === "failed";
  const isCancelled = operation.status === "cancelled";

  const hasRankRunId = Boolean(
    operation.rankCheckRunId ||
    (operation.metadata as { runId?: string } | undefined)?.runId,
  );
  const isRankTracking = operation.feature === "rank_tracking";
  const cancellable = Boolean(
    operation.supportsCancellation ||
    isOperationCancellable(operation.operationId) ||
    isRankTracking ||
    hasRankRunId,
  );

  const cardBorder = isFailed
    ? "border-error/40"
    : isBlocked || isCancelled
      ? "border-warning/40"
      : isCancelling
        ? "border-warning/60 shadow-sm"
        : isRunning
          ? "border-primary/40 shadow-sm"
          : "border-base-300 hover:border-base-content/20";

  return (
    <div
      className={`rounded-lg border bg-base-100 text-sm transition-colors ${cardBorder}`}
    >
      <div
        onClick={() => setExpanded(!expanded)}
        className="flex w-full cursor-pointer items-start justify-between gap-3 p-3 text-left"
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setExpanded(!expanded);
          }
        }}
        aria-expanded={expanded}
      >
        <div className="flex items-start gap-2.5">
          <div className="mt-0.5">
            <StatusIcon status={operation.status} />
          </div>

          <div>
            <div className="flex flex-wrap items-center gap-2">
              <span className="font-mono font-medium text-base-content">
                {operation.operation}
              </span>
              <span className="rounded bg-base-200 px-1.5 py-0.5 text-xs text-base-content/60">
                {operation.source}
              </span>
              <StatusBadge status={operation.status} />
            </div>
            <CardSummary operation={operation} />
          </div>
        </div>

        <div className="flex items-center gap-1.5">
          <span className="font-mono text-xs text-base-content/60 mr-1">
            {formatTraceDuration(operation.durationMs)}
          </span>

          {/* Action: Cancel for running / pending operations */}
          {(isRunning || isPending || isCancelling) &&
            (cancellable ? (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  if (operation.feature === "rank_tracking") {
                    setShowCancelModal(true);
                  } else {
                    void globalTraceStore.cancelOperation(
                      operation.operationId,
                    );
                  }
                }}
                disabled={isCancelling}
                className="btn btn-xs btn-outline btn-warning gap-1 px-2 py-0.5 h-6 min-h-0 text-[11px] font-medium"
                title={
                  isCancelling ? "Cancelling operation..." : "Cancel operation"
                }
                aria-label="Cancel operation"
              >
                <Square className="size-2.5 fill-current" />
                <span>{isCancelling ? "Cancelling..." : "Cancel"}</span>
              </button>
            ) : (
              <span
                className="text-[10px] text-base-content/40 cursor-not-allowed select-none px-1"
                title="Cancellation not supported for this operation"
              >
                No cancel
              </span>
            ))}

          {/* Action: Remove from trace for terminal operations */}
          {(operation.status === "success" ||
            operation.status === "failed" ||
            operation.status === "cancelled" ||
            operation.status === "blocked") && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                globalTraceStore.removeOperation(operation.operationId);
              }}
              className="btn btn-ghost btn-xs text-base-content/50 hover:text-error hover:bg-error/10 p-1"
              title="Remove from trace"
              aria-label="Remove from trace"
            >
              <Trash2 className="size-3.5" />
            </button>
          )}

          <div className="p-1 text-base-content/40">
            {expanded ? (
              <ChevronDown className="size-4" />
            ) : (
              <ChevronRight className="size-4" />
            )}
          </div>
        </div>
      </div>

      {expanded && (
        <div className="space-y-4 border-t border-base-200 bg-base-200/30 p-3.5">
          {/* Cancelled Banner */}
          {operation.status === "cancelled" && (
            <div className="space-y-1 rounded border border-warning/30 bg-warning/10 p-2.5 text-xs text-warning">
              <div className="flex items-center gap-1.5 font-semibold">
                <Ban className="size-3.5" />
                Cancelled by user
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-base-content/70 mt-1">
                {operation.cancelRequestedAt && (
                  <span>
                    Requested:{" "}
                    {new Date(operation.cancelRequestedAt).toLocaleTimeString()}
                  </span>
                )}
                {operation.cancelledAt && (
                  <span>
                    Cancelled:{" "}
                    {new Date(operation.cancelledAt).toLocaleTimeString()}
                  </span>
                )}
                {operation.completedBeforeCancellation !== undefined && (
                  <span>
                    Completed before cancel:{" "}
                    {operation.completedBeforeCancellation}
                  </span>
                )}
                {operation.remainingItems !== undefined && (
                  <span>Remaining items: {operation.remainingItems}</span>
                )}
              </div>
            </div>
          )}

          <ScopeSection operation={operation} />
          <ProviderSection operation={operation} />
          <BillingSection operation={operation} />
          <CacheRetrySection operation={operation} />

          {(operation.errorClass || operation.errorMessage) && (
            <div className="space-y-1 rounded border border-error/30 bg-error/10 p-2.5 text-xs text-error">
              <div className="font-semibold">
                Error: {operation.errorClass ?? "RUNTIME_ERROR"}
              </div>
              {operation.errorMessage && (
                <div className="font-mono text-[11px] text-error/90">
                  {operation.errorMessage}
                </div>
              )}
            </div>
          )}

          {operation.children && operation.children.length > 0 && (
            <ChildrenSection items={operation.children} />
          )}

          {/* Contextual remove for running tasks with explicit disclaimer */}
          {(isRunning || isPending) && (
            <div className="flex justify-end pt-1">
              <button
                type="button"
                onClick={() =>
                  globalTraceStore.removeOperation(operation.operationId)
                }
                className="btn btn-ghost btn-xs text-base-content/50 hover:text-error"
                title="Removing the trace does not cancel the underlying background task"
              >
                <Trash2 className="size-3 mr-1" />
                Remove from trace (does not cancel operation)
              </button>
            </div>
          )}
        </div>
      )}

      <CancelConfirmationModal
        isOpen={showCancelModal}
        onClose={() => setShowCancelModal(false)}
        onConfirm={() =>
          void globalTraceStore.cancelOperation(operation.operationId)
        }
        operationName={operation.operation}
      />
    </div>
  );
}
