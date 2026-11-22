import { NonRetryableError } from "cloudflare:workflows";
import { AppError } from "@/server/lib/errors";
import type {
  createSeRankingClient,
  RecheckParams,
} from "@/server/lib/seranking";
import { SeRankingProjectService } from "@/server/lib/seranking";
import { SeRankingRecheckDispatchRepository } from "@/server/features/rank-tracking/repositories/SeRankingRecheckDispatchRepository";

/**
 * Durable dispatch for the paid SE Ranking recheck POST (FIX 2).
 *
 * `POST /sites/positions/recheck` is not idempotent and SE Ranking exposes no
 * check-job ID, so a re-dispatch after a workflow restart or step retry would
 * silently bill the same recheck twice. Every POST is therefore bracketed by a
 * durable `se_ranking_recheck_dispatch` record:
 *
 *   PENDING → DISPATCHED → CONFIRMED
 *                       → OUTCOME_UNKNOWN  (transport failure / 5xx after send)
 *                       → REJECTED         (definitive 4xx-class refusal)
 *
 * Gating before any POST:
 *   CONFIRMED | DISPATCHED  → skip (already sent)
 *   OUTCOME_UNKNOWN         → do NOT resend; warn and continue polling
 *   REJECTED                → do NOT resend; surface and stop
 *   PENDING (crash between INSERT and POST) → allowed to proceed
 */

export type RecheckDispatchScopeEntry = {
  siteEngineId: number | null;
  remoteKeywordId: string;
};

export type RecheckDispatchOutcome =
  | { outcome: "dispatched" }
  | {
      outcome: "already_dispatched";
      status: "CONFIRMED" | "DISPATCHED";
    }
  | { outcome: "outcome_unknown"; warning: string }
  | { outcome: "skipped_no_scope" };

/** AppError codes that mean the request was definitively NOT accepted (4xx class). */
const REJECTED_APP_ERROR_CODES = new Set([
  "VALIDATION_ERROR",
  "UNAUTHENTICATED",
  "FORBIDDEN",
  "NOT_FOUND",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
  "INSUFFICIENT_FUNDS",
  "RATE_LIMITED",
  "CONFLICT",
]);

export function classifyRecheckFailure(
  error: unknown,
): "REJECTED" | "OUTCOME_UNKNOWN" {
  if (error instanceof AppError) {
    return REJECTED_APP_ERROR_CODES.has(error.code)
      ? "REJECTED"
      : "OUTCOME_UNKNOWN";
  }
  // Unwrapped SeRankingError carries the HTTP status (e.g. from a re-thrown
  // validation error): 4xx = definitive refusal, 5xx/unknown = ambiguous.
  if (typeof error === "object" && error !== null && "statusCode" in error) {
    const status = error.statusCode;
    if (typeof status === "number" && status >= 400 && status < 500) {
      return "REJECTED";
    }
  }
  return "OUTCOME_UNKNOWN";
}

/**
 * Deterministic dispatch id: `${runId}:${configId}:${dispatchScope}`.
 */
export function recheckDispatchId(
  runId: string,
  configId: string,
  dispatchScope: string,
): string {
  return `${runId}:${configId}:${dispatchScope}`;
}

/**
 * Builds the canonical, sorted dispatch scope from the pending pairs:
 * a JSON array of { siteEngineId, remoteKeywordId } (null engine = the
 * engine-less keyword recheck path), deduplicated and sorted so the same
 * logical scope always produces the same dispatch id.
 */
export function buildRecheckDispatchScope(
  pairs: Array<{
    remoteKeywordId?: string;
    remoteSiteEngineId?: number;
  }>,
): string {
  const seen = new Set<string>();
  const entries: RecheckDispatchScopeEntry[] = [];
  for (const pair of pairs) {
    if (!pair.remoteKeywordId) continue;
    const entry: RecheckDispatchScopeEntry = {
      siteEngineId: pair.remoteSiteEngineId ?? null,
      remoteKeywordId: pair.remoteKeywordId,
    };
    const key = `${entry.siteEngineId ?? ""}:${entry.remoteKeywordId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
  }
  entries.sort(
    (a, b) =>
      (a.siteEngineId ?? 0) - (b.siteEngineId ?? 0) ||
      a.remoteKeywordId.localeCompare(b.remoteKeywordId, undefined, {
        numeric: true,
      }),
  );
  return JSON.stringify(entries);
}

function sanitizeProviderResponse(error: unknown): string {
  const summary: Record<string, unknown> = {
    name: error instanceof Error ? error.name : "UnknownError",
    code: error instanceof AppError ? error.code : undefined,
    message: (error instanceof Error ? error.message : String(error)).slice(
      0,
      500,
    ),
  };
  return JSON.stringify(summary);
}

export async function dispatchSeRankingRecheck(input: {
  client: ReturnType<typeof createSeRankingClient>;
  remoteSiteId: number;
  runId: string;
  configId: string;
  dispatchScope: string;
  recheckParams: RecheckParams;
  readOnlySync?: boolean;
}): Promise<RecheckDispatchOutcome> {
  if (input.readOnlySync) {
    throw new NonRetryableError(
      "CRITICAL: POST /sites/positions/recheck is strictly forbidden in read-only sync mode",
    );
  }
  const parsedScope: unknown = JSON.parse(input.dispatchScope);
  if (!Array.isArray(parsedScope) || parsedScope.length === 0) {
    // No keyword was mapped to a remote SE Ranking keyword ID. Never fall back
    // to an engine-less/site-wide recheck: that would trigger a paid recheck
    // for the whole remote project, not just this run's scope.
    return { outcome: "skipped_no_scope" };
  }

  const id = recheckDispatchId(
    input.runId,
    input.configId,
    input.dispatchScope,
  );

  let record = await SeRankingRecheckDispatchRepository.getDispatchById(id);
  if (!record) {
    const created = await SeRankingRecheckDispatchRepository.createDispatch({
      id,
      runId: input.runId,
      configId: input.configId,
      dispatchScope: input.dispatchScope,
      status: "PENDING",
      createdAt: Date.now(),
    });
    if (created) {
      record = created;
    } else {
      // Lost an insert race (concurrent duplicate for the same run+scope) —
      // re-read and gate on whatever the winner wrote.
      record = await SeRankingRecheckDispatchRepository.getDispatchById(id);
    }
  }

  if (record && record.status !== "PENDING") {
    if (record.status === "CONFIRMED" || record.status === "DISPATCHED") {
      // The POST was already sent for this exact scope — never resend.
      console.warn(
        `[seranking-recheck] dispatch ${id} already ${record.status}; skipping POST`,
      );
      return {
        outcome: "already_dispatched",
        status: record.status,
      };
    }
    if (record.status === "OUTCOME_UNKNOWN") {
      // A previous attempt sent the POST but the outcome was lost. Resending
      // risks a duplicate paid recheck; polling the existing check is safe.
      const warning =
        "SE Ranking recheck dispatch outcome is UNKNOWN from a previous attempt; NOT resending the POST — continuing to poll for the possibly-accepted recheck. Operator reconciliation required for billing attribution.";
      console.warn(`[seranking-recheck] ${warning} (dispatch ${id})`);
      return { outcome: "outcome_unknown", warning };
    }
    if (record.status === "REJECTED") {
      throw new NonRetryableError(
        `SE Ranking recheck was rejected by the provider for dispatch ${id}; not retried.`,
      );
    }
    // status PENDING → crash between INSERT and POST; allowed to proceed.
  }

  await SeRankingRecheckDispatchRepository.updateDispatch(id, {
    status: "DISPATCHED",
    dispatchedAt: Date.now(),
  });

  try {
    const res = await SeRankingProjectService.recheckPositions(
      input.client,
      input.recheckParams,
    );
    await SeRankingRecheckDispatchRepository.updateDispatch(id, {
      status: "CONFIRMED",
      outcomeAt: Date.now(),
      providerResponse: JSON.stringify({
        ok: true,
        status: res?.status ?? "queued",
      }),
    });
    return { outcome: "dispatched" };
  } catch (error) {
    const classification = classifyRecheckFailure(error);
    const providerResponse = sanitizeProviderResponse(error);
    if (classification === "REJECTED") {
      await SeRankingRecheckDispatchRepository.updateDispatch(id, {
        status: "REJECTED",
        outcomeAt: Date.now(),
        providerResponse,
      });
      throw new NonRetryableError(
        `SE Ranking recheck was rejected by the provider: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    await SeRankingRecheckDispatchRepository.updateDispatch(id, {
      status: "OUTCOME_UNKNOWN",
      outcomeAt: Date.now(),
      providerResponse,
    });
    const warning =
      "SE Ranking recheck POST failed after dispatch (transport failure or 5xx); the recheck may or may not have been accepted. NOT resending — continuing to poll.";
    console.warn(
      `[seranking-recheck] ${warning} (dispatch ${id})`,
      error instanceof Error ? error.message : error,
    );
    return { outcome: "outcome_unknown", warning };
  }
}
