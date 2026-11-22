import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";
import { isErrorCode } from "@/shared/error-codes";
import type {
  ComparePeriod,
  RankTrackingAttemptStatus,
  RankTrackingDeviceResult,
  RankTrackingRow,
} from "@/types/schemas/rank-tracking";
import {
  resolveSnapshotComparison,
  selectPreferredByKeywordDevice,
  type ComparableSnapshotRow,
  type ComparisonResolution,
} from "./rankComparison";

export type { ComparisonResolution };
type SnapshotRow = ComparableSnapshotRow;

export async function getLatestResults(
  configId: string,
  projectId: string,
  comparePeriod: ComparePeriod = "7d",
  trackingTargetId?: string,
): Promise<{
  rows: RankTrackingRow[];
  run: { id: string; lastCheckedAt: string } | null;
}> {
  // All reads key off the inputs alone, run in parallel.
  // Project-scoped config lookup doubles as the authorization gate.
  const [
    config,
    activeKeywords,
    rawCurrentSnapshots,
    rawLatestValidSnapshots,
    validDailyHistory,
  ] = await Promise.all([
    RankTrackingRepository.getConfigById({ configId, projectId }),
    RankTrackingRepository.getKeywordsForConfig(configId),
    // Latest snapshot attempt per target+keyword+device (including terminal failed/partial runs)
    RankTrackingRepository.getLatestSnapshotsForKeywords(
      configId,
      trackingTargetId,
    ),
    // Latest valid observation per target+keyword+device (RANKED or NO_RESULT only)
    RankTrackingRepository.getLatestValidSnapshotsForKeywords(
      configId,
      trackingTargetId,
    ),
    // Authoritative daily valid snapshot series deduplicated per (target, keyword, device, provider, obsDate)
    RankTrackingRepository.getValidDailySnapshotsForConfig(
      configId,
      trackingTargetId,
    ),
  ]);
  if (!config) {
    throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
  }

  const currentSnapshots = trackingTargetId
    ? rawCurrentSnapshots
    : selectPreferredByKeywordDevice(rawCurrentSnapshots);

  const latestValidByTargetKey = new Map<string, SnapshotRow>();
  for (const snap of rawLatestValidSnapshots) {
    const key = `${snap.trackingTargetId ?? "none"}:${snap.trackingKeywordId}:${snap.device}`;
    latestValidByTargetKey.set(key, snap);
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
        desktop: createEmptyDeviceResult(null),
        mobile: createEmptyDeviceResult(null),
      },
    ]),
  );

  // Determine the most recent snapshot time for the run info
  let latestRunId: string | null = null;
  let latestStartedAt: string | null = null;

  for (const snapshot of currentSnapshots) {
    const row = rows.get(snapshot.trackingKeywordId);
    if (!row) continue;
    const targetKey = `${snapshot.trackingTargetId ?? "none"}:${snapshot.trackingKeywordId}:${snapshot.device}`;
    const latestValidSnap = latestValidByTargetKey.get(targetKey) ?? null;
    const comparison = resolveSnapshotComparison(
      snapshot,
      validDailyHistory,
      comparePeriod,
      latestValidSnap,
    );

    row[snapshot.device] = toDeviceResult(
      snapshot,
      comparison.previousPosition,
      latestValidSnap?.position ?? null,
      comparison,
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
    rankingStatus: "NOT_CHECKED",
    attemptStatus: "PENDING",
  };
}

export function parseProviderStatusMetadata(
  status: string | null | undefined,
): {
  status: string;
  providerChange: number | null;
  landingPageDate: string | null;
} {
  if (!status) {
    return { status: "", providerChange: null, landingPageDate: null };
  }

  const trimmed = status.trim();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) {
    try {
      const parsed: unknown = JSON.parse(trimmed);
      if (typeof parsed === "object" && parsed !== null) {
        const obj = parsed as Record<string, unknown>;
        const rawStatus = typeof obj.status === "string" ? obj.status : "Ok";
        const rawChange =
          typeof obj.providerChange === "number"
            ? obj.providerChange
            : typeof obj.change === "number"
              ? obj.change
              : null;
        const rawDate =
          typeof obj.landingPageObservedAt === "string"
            ? obj.landingPageObservedAt
            : typeof obj.landingPageDate === "string"
              ? obj.landingPageDate
              : null;
        return {
          status: rawStatus,
          providerChange: rawChange,
          landingPageDate: rawDate,
        };
      }
    } catch {
      // Fall through to regex parsing
    }
  }

  const changeMatch = status.match(/provider_change:(-?\d+)/);
  const dateMatch = status.match(/landing_page_observed:(\d{4}-\d{2}-\d{2})/);
  const cleanStatus = status.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return {
    status: cleanStatus || status,
    providerChange: changeMatch ? Number(changeMatch[1]) : null,
    landingPageDate: dateMatch ? dateMatch[1] : null,
  };
}

export function deriveAttemptStatus(input: {
  isUnverified: boolean;
  rankingStatus: string | null | undefined;
  errorMessage: string | null | undefined;
  providerStatus: string | null | undefined;
  isFailed: boolean;
  isNotChecked: boolean;
  isRanked: boolean;
  isNoResult: boolean;
}): RankTrackingAttemptStatus {
  const isTimedOutUnverified =
    input.isUnverified ||
    (input.rankingStatus === "CHECK_FAILED" &&
      (Boolean(input.errorMessage?.includes("polling window")) ||
        Boolean(input.providerStatus?.includes("polling window")) ||
        Boolean(
          input.providerStatus?.includes("identical to pre-recheck baseline"),
        ) ||
        Boolean(input.providerStatus?.includes("TIMED_OUT_UNVERIFIED")) ||
        Boolean(input.providerStatus?.includes("unverified"))));

  const isCancelled =
    input.isNotChecked &&
    (Boolean(input.errorMessage?.toLowerCase().includes("cancel")) ||
      Boolean(input.providerStatus?.toLowerCase().includes("cancel")));

  if (isCancelled) return "CANCELLED";
  if (isTimedOutUnverified) return "TIMED_OUT_UNVERIFIED";
  if (input.isFailed) return "PROVIDER_FAILED";
  if (input.isNotChecked) return "PENDING";
  if (input.isRanked || input.isNoResult) return "COMPLETED";
  return "PENDING";
}

export function toDeviceResult(
  snapshot: SnapshotRow,
  previousPosition: number | null,
  latestValidPosition?: number | null,
  comparison?: ComparisonResolution,
): RankTrackingDeviceResult {
  // An UNVERIFIED snapshot (same-day observation identical to the pre-recheck
  // baseline) must never appear as a fresh ranking: treat it as failed so it
  // surfaces as "Ranking unavailable" while preserving the latest valid
  // position for context.
  const isUnverified = snapshot.completionConfidence === "UNVERIFIED";
  const isFailed = isUnverified || snapshot.rankingStatus === "CHECK_FAILED";
  const isNotChecked = snapshot.rankingStatus === "NOT_CHECKED";
  // Strict rule: pos > 0 => RANKED. A null or <= 0 position is NEVER classified as RANKED.
  const isRanked =
    !isFailed &&
    !isNotChecked &&
    typeof snapshot.position === "number" &&
    snapshot.position > 0;
  const status: RankTrackingDeviceResult["status"] = isFailed
    ? "failed"
    : isNotChecked
      ? "not_checked"
      : isRanked
        ? "ranked"
        : "not_ranking";

  let errorCode: string | null = null;
  if (snapshot.providerStatusCode === 40201) {
    errorCode = "DATAFORSEO_ACCOUNT_PAUSED";
  } else if (snapshot.errorMessage && isErrorCode(snapshot.errorMessage)) {
    errorCode = snapshot.errorMessage;
  }

  const meta = parseProviderStatusMetadata(snapshot.providerStatus);

  const effectiveRankingStatus: RankTrackingDeviceResult["rankingStatus"] =
    isUnverified
      ? "CHECK_FAILED"
      : snapshot.rankingStatus === "CHECK_FAILED"
        ? "CHECK_FAILED"
        : isNotChecked
          ? "NOT_CHECKED"
          : isRanked
            ? "RANKED"
            : "NO_RESULT";

  const attemptStatus = deriveAttemptStatus({
    isUnverified,
    rankingStatus: snapshot.rankingStatus,
    errorMessage: snapshot.errorMessage,
    providerStatus: snapshot.providerStatus,
    isFailed,
    isNotChecked,
    isRanked,
    isNoResult: effectiveRankingStatus === "NO_RESULT",
  });

  return {
    position: isUnverified ? null : snapshot.position,
    previousPosition,
    providerChange: meta.providerChange,
    landingPageDate:
      meta.landingPageDate ??
      (snapshot.checkedAt ? snapshot.checkedAt.slice(0, 10) : null),
    completionConfidence: snapshot.completionConfidence ?? null,
    rankingUrl: isFailed || isNotChecked ? null : snapshot.url,
    serpFeatures:
      isUnverified || isNotChecked
        ? []
        : parseSerpFeatures(snapshot.serpFeatures),
    checkedAt: snapshot.checkedAt,
    checkedDate: snapshot.checkedDate ?? null,
    importedAt: snapshot.importedAt ?? null,
    observationSource: snapshot.observationSource ?? null,
    trackingTargetId: snapshot.trackingTargetId ?? null,
    countryCode: snapshot.countryCode ?? null,
    cityName: snapshot.cityName ?? null,
    language: snapshot.language ?? null,
    ...(comparison
      ? {
          previousComparablePosition: comparison.previousComparablePosition,
          previousObservationDate: comparison.previousObservationDate,
          previousObservationProvider: comparison.previousObservationProvider,
          previousObservationSource: comparison.previousObservationSource,
          positionChange: comparison.positionChange,
          comparisonMethod: comparison.comparisonMethod,
          periodBaselinePosition: comparison.periodBaselinePosition,
          periodBaselineDate: comparison.periodBaselineDate,
          periodBaselineProvider: comparison.periodBaselineProvider,
        }
      : {}),
    status,
    rankingStatus: effectiveRankingStatus,
    attemptStatus,
    latestValidPosition:
      isFailed || isNotChecked
        ? (latestValidPosition ?? null)
        : snapshot.position,
    errorCode,
    errorMessage: snapshot.errorMessage,
    providerStatus: meta.status || snapshot.providerStatus,
    providerStatusCode: snapshot.providerStatusCode,
    provider: snapshot.provider,
  };
}
