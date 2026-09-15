import {
  scrubGlobalTraceText,
  type GlobalTraceKeywordChild,
  type GlobalTraceOperation,
  type GlobalTraceProviderCall,
} from "@/shared/globalTraceTypes";
import { parseDataforseoDiagnosticsFromErrorMessage } from "@/shared/dataforseoDiagnosticsParser";

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

function providerLabel(provider: string | null | undefined): string {
  if (provider === "dataforseo") return "DataForSEO";
  if (provider === "serper") return "Serper.dev";
  if (provider === "zenserp") return "Zenserp";
  return provider ?? "DataForSEO";
}

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
    | "DATAFORSEO_ACCOUNT_PAUSED";
  budget: "BLOCKED" | "PASS";
  blockedReason?: string;
}

/**
 * Classifies a rank-run failure message using only its text evidence.
 * Credit/budget wording → CREDITS_UNAVAILABLE + BLOCKED; everything else
 * stays a generic OPERATION_FAILED or specific DATAFORSEO_ACCOUNT_PAUSED with budget PASS.
 */
export function classifyRunError(message: string): ClassifiedRunError {
  const isPaused = /40201|paused access|unusual activity/i.test(message);
  if (isPaused) {
    return { errorClass: "DATAFORSEO_ACCOUNT_PAUSED", budget: "PASS" };
  }
  const isBudget =
    /credit|budget|payment|\b402\b|40200|insufficient|upgrade|top up|topup/i.test(
      message,
    );
  if (isBudget) {
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

/**
 * A snapshot belongs to this run when it was checked at/after the run
 * started. Without a run start time we fall back to any checkedAt evidence
 * (best effort, documented in metadata by the caller).
 */
function isFreshSnapshot(
  checkedAt: string | null | undefined,
  runStartedAt: string | null | undefined,
): boolean {
  if (!checkedAt) return false;
  if (!runStartedAt) return true;
  return checkedAt >= runStartedAt;
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

  const children: GlobalTraceKeywordChild[] = targetIds.map((id) => {
    const row = rowMap.get(id);
    const devices = [row?.desktop, row?.mobile].filter(
      (d): d is NonNullable<typeof d> => d != null,
    );
    const fresh = devices.filter((d) =>
      isFreshSnapshot(d.checkedAt, run.startedAt),
    );

    if (fresh.length === 0) {
      if (run.status === "cancelled") {
        return {
          keywordId: id,
          keyword: row?.keyword,
          status: "cancelled" as const,
          rankingStatus: "NOT_CHECKED" as const,
          error: "Cancelled before check",
        };
      }

      const hasProviderMarker = run.errorMessage
        ? PROVIDER_MARKER_RE.test(run.errorMessage)
        : false;
      const diag = hasProviderMarker
        ? parseDataforseoDiagnosticsFromErrorMessage(run.errorMessage)
        : null;
      return {
        keywordId: id,
        keyword: row?.keyword,
        status: "failed" as const,
        rankingStatus: "CHECK_FAILED" as const,
        provider: providerLabel(
          row?.desktop?.provider ?? row?.mobile?.provider,
        ),
        httpStatus: diag?.httpStatus ?? undefined,
        taskStatus: diag?.dataforseoStatusCode ?? undefined,
        // Scrubbed: the run message crosses into a visible trace record.
        error: run.errorMessage
          ? scrubGlobalTraceText(run.errorMessage)
          : "No snapshot recorded for this run",
      };
    }

    const failedDevice = fresh.find(
      (d) => d.status === "failed" || d.rankingStatus === "CHECK_FAILED",
    );

    if (failedDevice) {
      const childErrMsg = failedDevice.errorMessage || run.errorMessage;
      const hasProviderMarker = childErrMsg
        ? PROVIDER_MARKER_RE.test(childErrMsg)
        : false;
      const diag = hasProviderMarker
        ? parseDataforseoDiagnosticsFromErrorMessage(childErrMsg)
        : null;
      const taskStatus =
        failedDevice.providerStatusCode ??
        diag?.dataforseoStatusCode ??
        undefined;
      const httpStatus = diag?.httpStatus ?? undefined;

      return {
        keywordId: id,
        keyword: row?.keyword,
        status: "failed" as const,
        rankingStatus: "CHECK_FAILED" as const,
        provider: "DataForSEO",
        httpStatus,
        taskStatus,
        error: childErrMsg
          ? scrubGlobalTraceText(childErrMsg)
          : "Rank check attempt failed",
      };
    }

    const positionAfter =
      fresh.find((d) => d.position != null)?.position ?? null;
    const positionBefore =
      fresh.find((d) => d.previousPosition != null)?.previousPosition ?? null;
    return {
      keywordId: id,
      keyword: row?.keyword,
      status:
        positionAfter != null ? ("success" as const) : ("no_result" as const),
      rankingStatus:
        positionAfter != null ? ("RANKED" as const) : ("NO_RESULT" as const),
      provider: providerLabel(
        fresh.find((device) => device.position != null)?.provider ??
          fresh[0]?.provider,
      ),
      positionBefore,
      positionAfter,
    };
  });

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
    rankChecksFailed: failed,
    rankChecksSkipped: cancelled,
    completedBeforeCancellation: isCancelledRun
      ? succeeded + failed
      : undefined,
    remainingItems: isCancelledRun ? cancelled : undefined,
    children,
    counters: {
      checked: run.keywordsChecked,
      total: run.keywordsTotal,
    },
  };

  if (run.providerCalls) {
    const dispatchedCalls = run.providerCalls.filter(
      (call) => call.dispatched !== false,
    );
    patch.providerCalls = dispatchedCalls.length;
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

/**
 * Canonical provider markers emitted by the DataForSEO HTTP seam
 * (`DataForSEO HTTP <status> on <path>…`) and the task envelope
 * (`DataForSEO task error (<code>): …`). Only when one is present do we map
 * provider/endpoint/HTTP/task/transport into the trace — otherwise the
 * caller keeps its generic classification and nothing is fabricated.
 *
 * Distinguishes: HTTP 5xx (TRANSIENT_UPSTREAM) ≠ task error inside HTTP 200
 * (TASK_ERROR / CREDITS_UNAVAILABLE / DATAFORSEO_ACCOUNT_PAUSED) ≠ 402 ≠ 429.
 * Returns true when applied.
 */
const PROVIDER_MARKER_RE =
  /DataForSEO HTTP \d{3}|DataForSEO task error \(\d+\)|DATAFORSEO_ACCOUNT_PAUSED|paused access|unusual activity/i;

function applyProviderDiagnostics(
  patch: RankCompletionPatch,
  rawMessage: string,
  succeeded: number,
): boolean {
  if (!PROVIDER_MARKER_RE.test(rawMessage)) return false;
  const d = parseDataforseoDiagnosticsFromErrorMessage(rawMessage);
  const isCreditBlocked = d.errorClass === "CREDITS_UNAVAILABLE";
  const providerCall: GlobalTraceProviderCall = {
    provider: d.provider,
    endpoint: d.endpoint,
    httpStatus: d.httpStatus,
    taskStatus: d.dataforseoStatusCode,
    statusMessage: d.dataforseoStatusMessage,
    transport: d.transport,
    billing: "Paid",
    metered: true,
    budgetGuard: isCreditBlocked ? "BLOCKED" : "PASS",
  };
  patch.providers = [providerCall];
  patch.httpStatus = d.httpStatus ?? undefined;
  patch.errorClass = d.errorClass;
  patch.budget = isCreditBlocked ? "BLOCKED" : "PASS";
  if (isCreditBlocked) {
    patch.blockedReason = scrubGlobalTraceText(rawMessage);
    // A credit block before any snapshot means no billable call completed.
    // Never zero the count when snapshots prove calls happened.
    if (succeeded === 0) {
      patch.providerCalls = 0;
    }
  }
  return true;
}
