import { useRef } from "react";
import {
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  getLatestRankRun,
  cancelRankCheckRun,
} from "@/serverFunctions/rank-tracking";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { registerCancellation } from "@/client/features/tracing/cancellationRegistry";
import type { GlobalTraceOperation } from "@/shared/globalTraceTypes";
import type { RankTrackingRow } from "@/types/schemas/rank-tracking";
import { buildRankCompletionPatch } from "./rankTraceCompletion";

type LatestRun = Awaited<ReturnType<typeof getLatestRankRun>>;

function findActiveTraces(
  runId: string,
  projectId: string,
): GlobalTraceOperation[] {
  const ops = globalTraceStore.getOperations(projectId);
  return ops.filter(
    (op) =>
      op.feature === "rank_tracking" &&
      (op.status === "running" ||
        op.status === "cancelling" ||
        op.status === "pending") &&
      (op.rankCheckRunId === runId ||
        (op.metadata as { runId?: unknown } | undefined)?.runId === runId ||
        !op.rankCheckRunId),
  );
}

/**
 * Polls the latest rank check run for a config, auto-refreshing results
 * when a run transitions from "running" to "completed".
 * Also feeds the Global Debug Trace with real-time run progress and honest
 * completion: per-keyword children are derived from snapshot evidence only
 * (fresh snapshot + position → success, fresh snapshot + no position →
 * no_result, no snapshot → failed). Nothing is fabricated.
 */
export function useRankRunPolling(projectId: string, configId: string) {
  const queryClient = useQueryClient();
  const prevStatusRef = useRef<string | undefined>(undefined);
  // Runs that were already terminal when this hook mounted (page opened
  // mid/late-run) still need to finalize their trace exactly once.
  const finalizedRunIdsRef = useRef<Set<string>>(new Set());

  const { data: latestRun } = useQuery({
    queryKey: ["rankTrackingLatestRun", projectId, configId],
    queryFn: () => getLatestRankRun({ data: { projectId, configId } }),
    refetchInterval: (query) => {
      const run = query.state.data;
      prevStatusRef.current = run?.status;

      if (run && (run.status === "running" || run.status === "pending")) {
        const activeOps = findActiveTraces(run.id, projectId);
        for (const activeOp of activeOps) {
          // Register cancellation handler so cancellation works even after reload/navigation
          registerCancellation(activeOp.operationId, async () => {
            try {
              await cancelRankCheckRun({
                data: {
                  projectId,
                  configId,
                  runId: run.id,
                },
              });
            } catch (err) {
              console.error("Failed to cancel server rank check run:", err);
            }
          });

          globalTraceStore.updateOperation(activeOp.operationId, {
            supportsCancellation: true,
            rankCheckRunId: run.id,
            rankChecksStarted: run.keywordsChecked,
            providerCalls: run.providerCalls.length,
            rankChecksSucceeded: run.keywordsChecked,
            counters: {
              checked: run.keywordsChecked,
              total: run.keywordsTotal,
            },
          });
        }
      }

      // When a run reaches a terminal state, invalidate results & finalize
      // the correlated trace. Finalization is keyed by run id (idempotent —
      // a second call finds no RUNNING op), so this also covers the
      // mount-after-terminal case: a page opened while/after the run
      // finished still completes its trace instead of leaving it RUNNING
      // forever.
      const isTerminal =
        run?.status === "completed" ||
        run?.status === "failed" ||
        run?.status === "cancelled";
      if (run && isTerminal && !finalizedRunIdsRef.current.has(run.id)) {
        finalizedRunIdsRef.current.add(run.id);
        const activeOps = findActiveTraces(run.id, projectId);
        for (const activeOp of activeOps) {
          void finalizeTraceForRun(
            run,
            queryClient,
            projectId,
            configId,
            activeOp,
          );
        }
      }

      // Fast 1s polling for active runs so progress increments and cancellation are responsive
      if (run?.status === "pending" || run?.status === "running") return 1000;
      return false;
    },
  });

  return latestRun;
}

async function finalizeTraceForRun(
  run: NonNullable<LatestRun>,
  queryClient: QueryClient,
  projectId: string,
  configId: string,
  activeOp: GlobalTraceOperation,
): Promise<void> {
  try {
    // Refresh the table's own results queries (prefix-matched, so every
    // compare-period variant) and await them: children must be built from
    // fresh snapshots, not the pre-run cache. This reuses the table's
    // queries — no divergent cache keys, no extra provider calls.
    const resultsPrefix = ["rankTrackingResults", projectId, configId];
    try {
      await queryClient.refetchQueries({
        queryKey: resultsPrefix,
        type: "active",
      });
    } catch {
      // Best effort — fall through to whatever the cache holds.
    }
    void queryClient.invalidateQueries({ queryKey: resultsPrefix });
    const cached = queryClient.getQueriesData<{
      rows?: RankTrackingRow[];
    }>({ queryKey: resultsPrefix });
    let effectiveRows: RankTrackingRow[] = [];
    for (const [, data] of cached) {
      if (data?.rows && data.rows.length > effectiveRows.length) {
        effectiveRows = data.rows;
      }
    }

    const targetIds =
      activeOp.selectedKeywordIds && activeOp.selectedKeywordIds.length > 0
        ? activeOp.selectedKeywordIds
        : effectiveRows.map((r) => r.trackingKeywordId);

    const patch = buildRankCompletionPatch({
      run: {
        id: run.id,
        status: run.status,
        keywordsChecked: run.keywordsChecked,
        keywordsTotal: run.keywordsTotal,
        errorMessage: run.errorMessage,
        startedAt: run.startedAt,
        providerCalls: run.providerCalls,
      },
      rows: effectiveRows,
      targetIds,
    });

    // Correlate the client trace with the server run for the operation card.
    globalTraceStore.completeOperation(activeOp.operationId, {
      ...patch,
      metadata: {
        ...activeOp.metadata,
        runId: run.id,
        configId,
        keywordsChecked: run.keywordsChecked,
        keywordsTotal: run.keywordsTotal,
      },
    });
  } catch {
    // Trace finalization must never throw out of the polling loop.
    try {
      globalTraceStore.completeOperation(activeOp.operationId, {
        status:
          run.status === "cancelled"
            ? "cancelled"
            : run.status === "failed"
              ? "failed"
              : "success",
        errorMessage: run.errorMessage || undefined,
      });
    } catch {
      // Best effort only.
    }
  }
}
