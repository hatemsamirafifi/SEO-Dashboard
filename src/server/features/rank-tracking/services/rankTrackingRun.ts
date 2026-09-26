import type { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";

type RunRow = NonNullable<
  Awaited<ReturnType<typeof RankTrackingRepository.getLatestRunForConfig>>
>;

export function formatRankTrackingRun(
  run: RunRow,
  providerCalls: Awaited<
    ReturnType<typeof RankTrackingRepository.getProviderCallsForRun>
  >,
  stale?: { maybeStale: boolean; staleReason: string },
) {
  return {
    id: run.id,
    status: run.status,
    keywordsTotal: run.keywordsTotal,
    keywordsChecked: run.keywordsChecked,
    isSubsetRun: run.isSubsetRun,
    errorMessage: run.errorMessage,
    startedAt: run.startedAt,
    completedAt: run.completedAt,
    maybeStale: stale?.maybeStale ?? false,
    staleReason: stale?.staleReason ?? null,
    providerCalls,
  };
}
