import type { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type {
  ComparePeriod,
  RankComparisonMethod,
} from "@/types/schemas/rank-tracking";

type RawSnapshotRow = Awaited<
  ReturnType<typeof RankTrackingRepository.getLatestSnapshotsForKeywords>
>[number];

export type ComparableSnapshotRow = Omit<
  RawSnapshotRow,
  | "trackingTargetId"
  | "checkedDate"
  | "importedAt"
  | "observationSource"
  | "countryCode"
  | "cityName"
  | "language"
> & {
  trackingTargetId?: string | null;
  checkedDate?: string | null;
  importedAt?: string | null;
  observationSource?:
    | "manual_recheck"
    | "daily_sync"
    | "scheduled_check"
    | "baseline"
    | "legacy"
    | null;
  countryCode?: string | null;
  cityName?: string | null;
  language?: string | null;
};

const PERIOD_DAYS: Record<Exclude<ComparePeriod, "previous">, number> = {
  "1d": 1,
  "7d": 7,
  "30d": 30,
  "90d": 90,
};

function resolveObsDate(
  snap: Pick<ComparableSnapshotRow, "checkedDate" | "checkedAt">,
): string {
  return snap.checkedDate ?? snap.checkedAt.slice(0, 10);
}

function subtractDaysIsoDate(isoDate: string, days: number): string {
  const [y, m, d] = isoDate.slice(0, 10).split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d - days));
  return dt.toISOString().slice(0, 10);
}

function normalizeGeoValue(val: string | null | undefined): string | null {
  return val ? val.trim().toLowerCase() : null;
}

function isValidSnapshotRow(snap: ComparableSnapshotRow): boolean {
  return (
    snap.completionConfidence !== "UNVERIFIED" &&
    snap.rankingStatus !== "CHECK_FAILED" &&
    snap.rankingStatus !== "NOT_CHECKED"
  );
}

function confidenceRank(confidence: string | null | undefined): number {
  if (confidence === "CONFIRMED") return 3;
  if (confidence === "LIKELY_COMPLETE") return 2;
  return 1;
}

function isDailySyncRow(snap: ComparableSnapshotRow): number {
  if (snap.observationSource === "daily_sync") return 2;
  if (snap.providerStatus?.includes("SE Ranking daily position import"))
    return 2;
  return 1;
}

function statusRank(status: string | null | undefined): number {
  if (status === "RANKED" || status === "NO_RESULT") return 2;
  if (status == null) return 1;
  return 0;
}

function isPreferredSnapshot(
  candidate: ComparableSnapshotRow,
  current: ComparableSnapshotRow,
): boolean {
  const candDate = resolveObsDate(candidate);
  const currDate = resolveObsDate(current);
  if (candDate !== currDate) return candDate > currDate;

  const candHasTarget = candidate.trackingTargetId ? 1 : 0;
  const currHasTarget = current.trackingTargetId ? 1 : 0;
  if (candHasTarget !== currHasTarget) return candHasTarget > currHasTarget;

  const candConf = confidenceRank(candidate.completionConfidence);
  const currConf = confidenceRank(current.completionConfidence);
  if (candConf !== currConf) return candConf > currConf;

  const candSync = isDailySyncRow(candidate);
  const currSync = isDailySyncRow(current);
  if (candSync !== currSync) return candSync > currSync;

  const candStat = statusRank(candidate.rankingStatus);
  const currStat = statusRank(current.rankingStatus);
  if (candStat !== currStat) return candStat > currStat;

  if (candidate.checkedAt !== current.checkedAt) {
    return candidate.checkedAt > current.checkedAt;
  }
  const candImp = candidate.importedAt ?? "";
  const currImp = current.importedAt ?? "";
  if (candImp !== currImp) return candImp > currImp;
  return candidate.id > current.id;
}

/**
 * When targetId is omitted, deterministically select one current snapshot per
 * (keywordId, device) so legacy untargeted rows never overwrite target-scoped rows.
 */
export function selectPreferredByKeywordDevice(
  snapshots: ComparableSnapshotRow[],
): ComparableSnapshotRow[] {
  const selected = new Map<string, ComparableSnapshotRow>();
  for (const snap of snapshots) {
    const key = `${snap.trackingKeywordId}:${snap.device}`;
    const existing = selected.get(key);
    if (!existing || isPreferredSnapshot(snap, existing)) {
      selected.set(key, snap);
    }
  }
  return [...selected.values()];
}

export function isComparablePriorObservation(
  anchor: ComparableSnapshotRow,
  candidate: ComparableSnapshotRow,
): boolean {
  if (candidate.trackingKeywordId !== anchor.trackingKeywordId) return false;
  if (candidate.device !== anchor.device) return false;
  if (candidate.provider !== anchor.provider) return false;

  if (anchor.trackingTargetId) {
    if (candidate.trackingTargetId !== anchor.trackingTargetId) return false;
  } else {
    if (candidate.trackingTargetId) return false;
    const anchorCountry = normalizeGeoValue(anchor.countryCode);
    const candCountry = normalizeGeoValue(candidate.countryCode);
    if (anchorCountry && candCountry && anchorCountry !== candCountry) {
      return false;
    }
    const anchorCity = normalizeGeoValue(anchor.cityName);
    const candCity = normalizeGeoValue(candidate.cityName);
    if (anchorCity && candCity && anchorCity !== candCity) {
      return false;
    }
    const anchorLang = normalizeGeoValue(anchor.language);
    const candLang = normalizeGeoValue(candidate.language);
    if (anchorLang && candLang && anchorLang !== candLang) {
      return false;
    }
  }

  return resolveObsDate(candidate) < resolveObsDate(anchor);
}

export interface ComparisonResolution {
  previousPosition: number | null;
  previousComparablePosition: number | null;
  previousObservationDate: string | null;
  previousObservationProvider: string | null;
  previousObservationSource: ComparableSnapshotRow["observationSource"];
  positionChange: number | null;
  comparisonMethod: RankComparisonMethod;
  periodBaselinePosition: number | null;
  periodBaselineDate: string | null;
  periodBaselineProvider: string | null;
}

/**
 * Resolve previous comparable same-target, same-provider observation and
 * optional multi-day period baseline for a keyword+device snapshot.
 */
export function resolveSnapshotComparison(
  current: ComparableSnapshotRow,
  validDailyHistory: ComparableSnapshotRow[],
  comparePeriod: ComparePeriod,
  latestValid?: ComparableSnapshotRow | null,
): ComparisonResolution {
  const anchor = isValidSnapshotRow(current)
    ? current
    : (latestValid ?? current);

  const comparablePriors = validDailyHistory
    .filter((candidate) => isComparablePriorObservation(anchor, candidate))
    .toSorted((a, b) => {
      const dateCmp = resolveObsDate(b).localeCompare(resolveObsDate(a));
      if (dateCmp !== 0) return dateCmp;
      return isPreferredSnapshot(b, a) ? 1 : -1;
    });

  const previousComparable = comparablePriors[0] ?? null;
  const previousComparablePosition = previousComparable?.position ?? null;
  const previousObservationDate = previousComparable
    ? resolveObsDate(previousComparable)
    : null;

  const positionChange =
    isValidSnapshotRow(current) &&
    typeof current.position === "number" &&
    typeof previousComparablePosition === "number"
      ? previousComparablePosition - current.position
      : null;

  if (comparePeriod === "previous" || comparePeriod === "1d") {
    return {
      previousPosition: previousComparablePosition,
      previousComparablePosition,
      previousObservationDate,
      previousObservationProvider: previousComparable?.provider ?? null,
      previousObservationSource: previousComparable?.observationSource ?? null,
      positionChange,
      comparisonMethod: previousComparable
        ? "previous_comparable_observation"
        : "none",
      periodBaselinePosition: null,
      periodBaselineDate: null,
      periodBaselineProvider: null,
    };
  }

  const days = PERIOD_DAYS[comparePeriod];
  const cutoffDate = subtractDaysIsoDate(resolveObsDate(anchor), days);
  const periodMatch =
    comparablePriors.find((p) => resolveObsDate(p) <= cutoffDate) ?? null;
  const fallbackBaseline =
    !periodMatch && comparablePriors.length > 0
      ? comparablePriors[comparablePriors.length - 1]
      : null;
  const periodBaseline = periodMatch ?? fallbackBaseline;
  const comparisonMethod: RankComparisonMethod = periodMatch
    ? "period_lookback"
    : fallbackBaseline
      ? "earliest_available_baseline"
      : "none";

  return {
    previousPosition: periodBaseline?.position ?? null,
    previousComparablePosition,
    previousObservationDate,
    previousObservationProvider: previousComparable?.provider ?? null,
    previousObservationSource: previousComparable?.observationSource ?? null,
    positionChange,
    comparisonMethod,
    periodBaselinePosition: periodBaseline?.position ?? null,
    periodBaselineDate: periodBaseline ? resolveObsDate(periodBaseline) : null,
    periodBaselineProvider: periodBaseline?.provider ?? null,
  };
}
