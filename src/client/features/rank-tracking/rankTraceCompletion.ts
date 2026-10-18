import {
  scrubGlobalTraceText,
  type GlobalTraceKeywordChild,
  type GlobalTraceOperation,
} from "@/shared/globalTraceTypes";
import { parseDataforseoDiagnosticsFromErrorMessage } from "@/shared/dataforseoDiagnosticsParser";
import {
  buildKeywordChild,
  applyProviderDiagnostics,
  isFreshSnapshot,
  providerLabel,
  PROVIDER_MARKER_RE,
} from "./rankTraceHelpers";

export { providerLabel, isFreshSnapshot, PROVIDER_MARKER_RE };

/**
 * Pure, testable decision logic for the rank-check Global Debug Trace
 * lifecycle. No React, no store access — the hooks call these helpers and
 * the store stays a dumb append-only log.
 *
 * Honesty rules enforced here:
 * - Only snapshot-derived facts become per-keyword children. HTTP/task
 *   statuses are NEVER fabricated: provider details are mapped only from
 *   canonical markers the DataForSEO seam emits ("DataForSEO HTTP <status>
 *   on <path>", "DataForSEO task error (<code>)"); otherwise they stay
 *   omitted, not defaulted to 200/20000.
 * - A child is `success` only with a fresh snapshot showing a position,
 *   `no_result` with a fresh snapshot showing no ranking, and `failed`
 *   when this run left no snapshot for the keyword at all.
 */

export type RankCheckDevices = "both" | "desktop" | "mobile";

/** Number of DataForSEO live tasks the manual workflow issues per keyword. */
export function providerTaskCount(
  validatedCount: number,
  devices: RankCheckDevices,
): number {
  return validatedCount * (devices === "both" ? 2 : 1);
}

export type CheckBusyState = "proceed" | "busy-inflight" | "busy-running";

/**
 * Decides whether a Check click may start a new server request.
 * Extracted so the "every click leaves a trace" contract is unit-testable:
 * busy clicks must produce a `blocked` trace + toast, never silence.
 */
export function resolveCheckBusyState(input: {
  isPending: boolean;
  isRunning: boolean;
}): CheckBusyState {
  if (input.isPending) return "busy-inflight";
  if (input.isRunning) return "busy-running";
  return "proceed";
}

export function busyBlockedReason(state: CheckBusyState): string {
  return state === "busy-inflight"
    ? "A rank check request is already in flight"
    : "A rank check is already running";
}

export interface ClassifiedRunError {
  errorClass:
    | "CREDITS_UNAVAILABLE"
    | "OPERATION_FAILED"
    | "DATAFORSEO_ACCOUNT_PAUSED"
    | "AUTH_FAILED"
    | "CIRCUIT_OPEN"
    | "BUDGET_EXCEEDED";
  budget: "BLOCKED" | "PASS";
  blockedReason?: string;
}

/**
 * Classifies a rank-run failure message using only its text evidence.
 * Distinguishes:
 * - Provider insufficient funds (CREDITS_UNAVAILABLE)
 * - Provider account paused (DATAFORSEO_ACCOUNT_PAUSED)
 * - Provider authentication failure (AUTH_FAILED)
 * - Explicit per-run budget refusal (BUDGET_EXCEEDED)
 * - Circuit breaker open (CIRCUIT_OPEN)
 * - Provider request failure (OPERATION_FAILED)
 * Daily budget cap is removed; daily budget text does NOT classify as BUDGET_EXCEEDED.
 */
export function classifyRunError(message: string): ClassifiedRunError {
  const isPaused = /40201|paused access|unusual activity/i.test(message);
  if (isPaused) {
    return { errorClass: "DATAFORSEO_ACCOUNT_PAUSED", budget: "PASS" };
  }
  const isAuth = /40100|401|auth|credential|invalid api key/i.test(message);
  if (isAuth) {
    return { errorClass: "AUTH_FAILED", budget: "PASS" };
  }
  const isCircuit = /circuit.*(?:open|bypassed)|temporarily bypassed/i.test(
    message,
  );
  if (isCircuit) {
    return { errorClass: "CIRCUIT_OPEN", budget: "PASS" };
  }
  const isPerRunBudget =
    /per-run budget|cost limit exceeded|monthly budget exceeded|explicit budget/i.test(
      message,
    );
  if (isPerRunBudget) {
    return {
      errorClass: "BUDGET_EXCEEDED",
      budget: "BLOCKED",
      blockedReason: message,
    };
  }
  const isCredits =
    /credit|payment|\b402\b|40200|insufficient funds|upgrade|top up|topup/i.test(
      message,
    );
  if (isCredits) {
    return {
      errorClass: "CREDITS_UNAVAILABLE",
      budget: "BLOCKED",
      blockedReason: message,
    };
  }
  return { errorClass: "OPERATION_FAILED", budget: "PASS" };
}

export interface RankRunForTrace {
  id: string;
  status: string;
  keywordsChecked: number;
  keywordsTotal: number;
  errorMessage?: string | null;
  startedAt?: string | null;
  providerCalls?: Array<{
    provider: string;
    endpoint: string;
    status: "success" | "failed" | "insufficient_depth" | "skipped";
    httpStatus?: number | null;
    errorCode?: string | null;
    durationMs: number;
    resultCount?: number | null;
    requestedDepth?: number;
    inspectedDepth?: number | null;
    pagesRequested?: number;
    resultCompleteness?: string;
    dispatched?: boolean;
    circuitBreakerEnabled?: boolean;
    attempt?: number | null;
    maxRetries?: number | null;
    retryable?: boolean | null;
    retryAfterMs?: number | null;
    skipReason?: string | null;
    circuitReason?: string | null;
    circuitOpenedAt?: string | null;
    circuitExpiresAt?: string | null;
    trackingKeywordId?: string;
    device?: string;
  }>;
}

export interface RankRowForTrace {
  trackingKeywordId: string;
  keyword?: string;
  desktop?: {
    position?: number | null;
    previousPosition?: number | null;
    checkedAt?: string | null;
    status?: string | null;
    rankingStatus?: string | null;
    errorMessage?: string | null;
    providerStatusCode?: number | null;
    provider?: string | null;
  } | null;
  mobile?: {
    position?: number | null;
    previousPosition?: number | null;
    checkedAt?: string | null;
    status?: string | null;
    rankingStatus?: string | null;
    errorMessage?: string | null;
    providerStatusCode?: number | null;
    provider?: string | null;
  } | null;
}

export type RankCompletionPatch = Partial<GlobalTraceOperation> & {
  status: "success" | "failed" | "cancelled";
  children: GlobalTraceKeywordChild[];
};

/**
 * Builds the completion patch for a terminal rank run from authoritative
 * runtime facts only: the run row + latest result rows. Target keywords are
 * the trace's validated selected IDs (falling back to all row IDs for
 * check-all runs that recorded no explicit selection).
 */
export function buildRankCompletionPatch(input: {
  run: RankRunForTrace;
  rows: RankRowForTrace[];
  targetIds: string[];
}): RankCompletionPatch {
  const { run, rows, targetIds } = input;
  const rowMap = new Map(rows.map((r) => [r.trackingKeywordId, r]));

  const children: GlobalTraceKeywordChild[] = targetIds.map((id) =>
    buildKeywordChild(id, rowMap.get(id), run),
  );

  const succeeded = children.filter(
    (c) => c.status === "success" || c.status === "no_result",
  ).length;
  const cancelled = children.filter((c) => c.status === "cancelled").length;
  const failed = children.length - succeeded - cancelled;

  const isCancelledRun = run.status === "cancelled";
  const runFailed = run.status === "failed";
  const status: "success" | "failed" | "cancelled" = isCancelledRun
    ? "cancelled"
    : runFailed || failed > 0
      ? "failed"
      : "success";

  const patch: RankCompletionPatch = {
    status,
    rankChecksSucceeded: succeeded,
    succeededWithValidSerp: succeeded,
    rankChecksAttempted: succeeded + failed,
    rankChecksFailed: failed,
    rankChecksSkipped: cancelled,
    completedBeforeCancellation: isCancelledRun
      ? succeeded + failed
      : undefined,
    remainingItems: isCancelledRun ? cancelled : undefined,
    children,
    counters: {
      candidates: targetIds.length,
      eligible: targetIds.length,
      selected: targetIds.length,
      attempted: succeeded + failed,
      succeededWithValidSerp: succeeded,
      failed,
      skipped: cancelled,
      cancelled,
      pending: 0,
      checked: run.keywordsChecked,
      total: run.keywordsTotal,
    },
  };

  if (run.providerCalls) {
    const dispatchedCalls = run.providerCalls.filter(
      (call) => call.dispatched !== false,
    );
    patch.providerCalls = dispatchedCalls.length;
    patch.providersConsidered = new Set(
      run.providerCalls.map((call) => call.provider),
    ).size;
    const breakdown = new Map<string, number>();
    for (const call of dispatchedCalls) {
      const label = providerLabel(call.provider);
      breakdown.set(label, (breakdown.get(label) ?? 0) + 1);
    }
    patch.providerBreakdown = [...breakdown].map(([provider, count]) => ({
      provider,
      count,
    }));
    patch.providers = run.providerCalls.map((call) => ({
      provider: providerLabel(call.provider),
      endpoint: call.endpoint,
      httpStatus: call.httpStatus,
      statusMessage: call.errorCode ?? call.status,
      durationMs: call.durationMs,
      billing: "Paid",
      metered: true,
      cost: call.provider === "dataforseo" ? undefined : "Not available",
      resultCount: call.resultCount ?? undefined,
      requestedDepth: call.requestedDepth,
      inspectedDepth: call.inspectedDepth,
      pagesRequested: call.pagesRequested,
      resultCompleteness: call.resultCompleteness,
      dispatched: call.dispatched,
      circuitBreakerEnabled: call.circuitBreakerEnabled,
      attempt: call.attempt ?? undefined,
      maxRetries: call.maxRetries ?? undefined,
      retryable: call.retryable ?? undefined,
      retryAfterMs: call.retryAfterMs ?? undefined,
      skipReason:
        call.skipReason ??
        (call.status === "skipped" ? call.errorCode : undefined),
      circuitReason: call.circuitReason,
      circuitOpenedAt: call.circuitOpenedAt,
      circuitExpiresAt: call.circuitExpiresAt,
    }));
    const attemptsByTarget = new Map<string, number>();
    const retryDetails = dispatchedCalls.flatMap((call) => {
      const target = `${call.trackingKeywordId ?? "unknown"}:${call.device ?? "unknown"}`;
      const attempt = (attemptsByTarget.get(target) ?? 0) + 1;
      attemptsByTarget.set(target, attempt);
      return attempt > 1
        ? [
            {
              attempt,
              provider: providerLabel(call.provider),
              httpStatus: call.httpStatus,
              durationMs: call.durationMs,
              error: call.errorCode ?? undefined,
            },
          ]
        : [];
    });
    patch.retry = {
      attempted: retryDetails.length > 0,
      count: retryDetails.length,
      details: retryDetails,
    };
  }

  if (isCancelledRun) {
    const executedKeywordCount = succeeded + failed;
    const completedTasksCount = rows
      .filter((r) => targetIds.includes(r.trackingKeywordId))
      .reduce((acc, r) => {
        const dCount = [r.desktop, r.mobile].filter((d) =>
          isFreshSnapshot(d?.checkedAt, run.startedAt),
        ).length;
        return acc + dCount;
      }, 0);

    patch.providerCalls = Math.max(executedKeywordCount, completedTasksCount);
    patch.billing = "Paid";
    patch.errorMessage = run.errorMessage
      ? scrubGlobalTraceText(run.errorMessage)
      : "Operation cancelled by user";
  }

  // Defense in depth: the run message crosses from the server record into a
  // developer-visible trace — scrub credential-shaped substrings even though
  // the producer already emits pre-scrubbed canonical messages.
  const rawMessage = run.errorMessage || "Rank check failed";
  if (run.errorMessage) {
    patch.errorMessage = scrubGlobalTraceText(run.errorMessage);
  }
  if (status === "failed") {
    if (applyProviderDiagnostics(patch, rawMessage, succeeded)) {
      // Canonical provider evidence applied (see helper below).
    } else {
      const classified = classifyRunError(rawMessage);
      patch.errorClass = classified.errorClass;
      patch.budget = classified.budget;
      if (classified.blockedReason) {
        patch.blockedReason = scrubGlobalTraceText(classified.blockedReason);
        // A budget block before any snapshot means no provider call executed.
        // Never zero the count when snapshots prove calls happened.
        if (succeeded === 0) {
          patch.providerCalls = 0;
        }
      }
      // Transport-layer evidence (no HTTP response arrived) upgrades the
      // generic label without claiming anything unobserved.
      const transportParsed =
        parseDataforseoDiagnosticsFromErrorMessage(rawMessage);
      if (transportParsed.transport !== "HTTP") {
        patch.errorClass = transportParsed.errorClass;
      }
    }
    if (!patch.errorMessage) {
      patch.errorMessage = "Rank check failed";
    }
  }

  return patch;
}
