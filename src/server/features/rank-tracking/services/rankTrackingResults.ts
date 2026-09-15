import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";
import { AppError } from "@/server/lib/errors";
import { isErrorCode } from "@/shared/error-codes";
import type { ComparePeriod } from "@/types/schemas/rank-tracking";
import type {
  RankTrackingDeviceResult,
  RankTrackingRow,
} from "@/types/schemas/rank-tracking";

type SnapshotRow = Awaited<
  ReturnType<typeof RankTrackingRepository.getLatestSnapshotsForKeywords>
>[0];

const PERIOD_DAYS: Record<ComparePeriod, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

export async function getLatestResults(
  configId: string,
  projectId: string,
  comparePeriod: ComparePeriod = "7d",
): Promise<{
  rows: RankTrackingRow[];
  run: { id: string; lastCheckedAt: string } | null;
}> {
  const days = PERIOD_DAYS[comparePeriod];
  const targetDate = toSqliteTimestamp(
    new Date(Date.now() - days * 24 * 60 * 60 * 1000),
  );

  // All reads key off the inputs alone, run in parallel.
  // Project-scoped config lookup doubles as the authorization gate.
  const [
    config,
    activeKeywords,
    currentSnapshots,
    latestValidSnapshots,
    comparisonSnapshots,
  ] = await Promise.all([
    RankTrackingRepository.getConfigById({ configId, projectId }),
    RankTrackingRepository.getKeywordsForConfig(configId),
    // Latest snapshot attempt per keyword per device (including terminal failed/partial runs)
    RankTrackingRepository.getLatestSnapshotsForKeywords(configId),
    // Latest valid observation per keyword per device (RANKED or NO_RESULT only)
    RankTrackingRepository.getLatestValidSnapshotsForKeywords(configId),
    // Comparison snapshots from before the target date (excluding failed attempts)
    RankTrackingRepository.getSnapshotsBeforeDate(configId, targetDate),
  ]);
  if (!config) {
    throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
  }

  const latestValidPositions = new Map<string, number | null>();
  for (const snap of latestValidSnapshots) {
    latestValidPositions.set(
      `${snap.trackingKeywordId}:${snap.device}`,
      snap.position,
    );
  }

  const previousPositions = new Map<string, number | null>();
  for (const snap of comparisonSnapshots) {
    previousPositions.set(
      `${snap.trackingKeywordId}:${snap.device}`,
      snap.position,
    );
  }

  // Fallback: for keyword+device combos with no comparison snapshot before
  // the target date, use the earliest available valid snapshot as a baseline.
  const missingKeywordIds: string[] = [];
  for (const snap of currentSnapshots) {
    const key = `${snap.trackingKeywordId}:${snap.device}`;
    if (!previousPositions.has(key)) {
      missingKeywordIds.push(snap.trackingKeywordId);
    }
  }

  if (missingKeywordIds.length > 0) {
    const uniqueMissingIds = [...new Set(missingKeywordIds)];
    const earliestSnapshots =
      await RankTrackingRepository.getEarliestSnapshotsForKeywords(
        configId,
        uniqueMissingIds,
      );
    for (const snap of earliestSnapshots) {
      const key = `${snap.trackingKeywordId}:${snap.device}`;
      if (!previousPositions.has(key)) {
        previousPositions.set(key, snap.position);
      }
    }
  }

  // Build result rows
  const rows = new Map<string, RankTrackingRow>(
    activeKeywords.map((keyword) => [
      keyword.id,
      {
        trackingKeywordId: keyword.id,
        keyword: keyword.keyword,
        searchVolume: keyword.searchVolume,
        keywordDifficulty: keyword.keywordDifficulty,
        cpc: keyword.cpc,
        desktop: createEmptyDeviceResult(
          previousPositions.get(`${keyword.id}:desktop`) ?? null,
        ),
        mobile: createEmptyDeviceResult(
          previousPositions.get(`${keyword.id}:mobile`) ?? null,
        ),
      },
    ]),
  );

  // Determine the most recent snapshot time for the run info
  let latestRunId: string | null = null;
  let latestStartedAt: string | null = null;

  for (const snapshot of currentSnapshots) {
    const row = rows.get(snapshot.trackingKeywordId);
    if (!row) continue;
    const key = `${snapshot.trackingKeywordId}:${snapshot.device}`;
    row[snapshot.device] = toDeviceResult(
      snapshot,
      previousPositions.get(key) ?? null,
      latestValidPositions.get(key) ?? null,
    );

    // Track the most recent run for the header display
    if (!latestStartedAt || snapshot.checkedAt > latestStartedAt) {
      latestRunId = snapshot.runId;
      latestStartedAt = snapshot.checkedAt;
    }
  }

  return {
    rows: [...rows.values()],
    run:
      latestRunId && latestStartedAt
        ? { id: latestRunId, lastCheckedAt: latestStartedAt }
        : null,
  };
}

function parseSerpFeatures(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      return parsed.filter((item): item is string => typeof item === "string");
    }
  } catch {
    // ignore
  }
  return [];
}

function createEmptyDeviceResult(
  previousPosition: number | null,
): RankTrackingDeviceResult {
  return {
    position: null,
    previousPosition,
    rankingUrl: null,
    serpFeatures: [],
    checkedAt: null,
    status: "not_checked",
  };
}

export function toDeviceResult(
  snapshot: SnapshotRow,
  previousPosition: number | null,
  latestValidPosition?: number | null,
): RankTrackingDeviceResult {
  const isFailed = snapshot.rankingStatus === "CHECK_FAILED";
  const isRanked = snapshot.position !== null;
  const status: RankTrackingDeviceResult["status"] = isFailed
    ? "failed"
    : isRanked
      ? "ranked"
      : "not_ranking";

  let errorCode: string | null = null;
  if (snapshot.providerStatusCode === 40201) {
    errorCode = "DATAFORSEO_ACCOUNT_PAUSED";
  } else if (snapshot.errorMessage && isErrorCode(snapshot.errorMessage)) {
    errorCode = snapshot.errorMessage;
  }

  return {
    position: snapshot.position,
    previousPosition,
    rankingUrl: isFailed ? null : snapshot.url,
    serpFeatures: parseSerpFeatures(snapshot.serpFeatures),
    checkedAt: snapshot.checkedAt,
    status,
    rankingStatus:
      snapshot.rankingStatus ?? (isRanked ? "RANKED" : "NO_RESULT"),
    latestValidPosition: isFailed
      ? (latestValidPosition ?? null)
      : snapshot.position,
    errorCode,
    errorMessage: snapshot.errorMessage,
    providerStatus: snapshot.providerStatus,
    providerStatusCode: snapshot.providerStatusCode,
    provider: snapshot.provider,
  };
}
