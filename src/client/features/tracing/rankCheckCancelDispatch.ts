import type { GlobalTraceOperation } from "@/shared/globalTraceTypes";

/**
 * Dispatches the real server cancellation for a rank_tracking operation.
 * Never throws: a failed server cancel must not break the local trace
 * transition to "cancelled".
 */
export async function dispatchRankCheckServerCancel(
  op: GlobalTraceOperation,
): Promise<void> {
  const runId =
    op.rankCheckRunId ||
    (op.metadata as { runId?: string } | undefined)?.runId;
  if (op.feature !== "rank_tracking" || !runId || !op.projectId) {
    return;
  }
  try {
    const { cancelRankCheckRun } = await import(
      "@/serverFunctions/rank-tracking"
    );
    await cancelRankCheckRun({
      data: {
        projectId: op.projectId,
        configId: (op.metadata as { configId?: string } | undefined)
          ?.configId,
        runId,
      },
    });
  } catch (err) {
    console.error(`Direct server cancel for run ${runId} failed:`, err);
  }
}