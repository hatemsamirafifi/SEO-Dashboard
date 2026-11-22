import {
  SeRankingProjectService,
  extractPositionObservation,
  type createSeRankingClient,
  type NormalizedSeRankingObservation,
  type SeRankingPositionItem,
} from "@/server/lib/seranking";
import type { SeRankingPendingPair } from "./seRankingCheckHelpers";

/**
 * Attribution certainty for SE Ranking observations. SE Ranking's Project API
 * is day-granular (check dates, no check-job ID), so a same-day observation
 * cannot always be proven to come from this run's recheck:
 * - CONFIRMED — the engine had no check date >= today before the recheck POST,
 *   so today's data appearing afterwards is safely attributable.
 * - LIKELY_COMPLETE — the engine was already pre-checked today, but the
 *   observation differs from the pre-recheck baseline fingerprint; that is
 *   evidence of a new check, not proof (another actor could have produced it).
 * - UNVERIFIED — the observation is identical to the pre-recheck baseline;
 *   it may be stale same-day data from an earlier run. Never promoted to a
 *   confirmed snapshot without explicit operator review.
 */
export type SeRankingCompletionConfidence =
  | "CONFIRMED"
  | "LIKELY_COMPLETE"
  | "UNVERIFIED";

export type SeRankingObservationFingerprint = {
  position: number | null;
  url: string | null;
  serpFeatures: string[];
};

export type SeRankingEngineRecheckBaseline = {
  /** True when SE Ranking already reported a check date >= `today` before this run's recheck POST. */
  hadTodayCheckDate: boolean;
  /**
   * The max YYYY-MM-DD check date SE Ranking reported for this engine at
   * baseline time, or `null` when none was reported. Used by later poll
   * rounds to resolve the effective provider-local date (a date strictly
   * newer than this is evidence of a fresh check), and to avoid freezing the
   * effective date at the workflow-start UTC calendar day.
   */
  latestCheckDate: string | null;
  /**
   * Fingerprint of each keyword's today-dated observation at baseline time,
   * keyed by keyword identity (remoteKeywordId ?? normalized keyword).
   * `null` = the keyword had no today-dated entry at baseline.
   */
  observations: Record<string, SeRankingObservationFingerprint | null>;
};

/**
 * Refreshed UTC calendar date at call (step-execution) time. A workflow can
 * span a UTC midnight boundary, so a `today` frozen at workflow start must not
 * be trusted inside a step body — this re-derives the current day each time a
 * date-sensitive step runs. Used as the fallback when the provider does not
 * report a usable check date.
 */
export function freshToday(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * Resolves the effective provider-local check date for an engine from the
 * provider-reported check dates, preferring a date at or after `today` (so a
 * same-day observation is attributable) or strictly after the baseline's
 * latest check date (so a newer-than-baseline observation is attributable even
 * across a UTC midnight rollover). Falls back to `today` when `getCheckDates`
 * is not used or reports nothing usable. Never adds a bound parameter.
 */
export function resolveEffectiveProviderDate(input: {
  checkDates: string[] | null;
  today: string;
  baselineLatestCheckDate?: string | null;
}): string {
  const dates = input.checkDates ?? [];
  const candidates = dates.filter(
    (d) =>
      d >= input.today ||
      (input.baselineLatestCheckDate != null &&
        d > input.baselineLatestCheckDate),
  );
  if (candidates.length > 0) {
    return candidates.toSorted().at(-1) ?? input.today;
  }
  return input.today;
}

/** Baseline keyed by engine identity (String(remoteSiteEngineId) or "all"). */
export type SeRankingRecheckBaseline = Record<
  string,
  SeRankingEngineRecheckBaseline
>;

export function fingerprintOfObservation(
  obs: NormalizedSeRankingObservation,
): SeRankingObservationFingerprint {
  return {
    position: obs.position,
    url: obs.url,
    serpFeatures: obs.serpFeatures.toSorted((a, b) => a.localeCompare(b)),
  };
}

export function fingerprintsEqual(
  a: SeRankingObservationFingerprint,
  b: SeRankingObservationFingerprint,
): boolean {
  return (
    a.position === b.position &&
    a.url === b.url &&
    a.serpFeatures.length === b.serpFeatures.length &&
    a.serpFeatures.every((f, i) => f === b.serpFeatures[i])
  );
}

export function pairObservationIdentity(pair: SeRankingPendingPair): string {
  return pair.remoteKeywordId ?? pair.keyword.trim().toLowerCase();
}

export function matchPositionItem(
  positions: SeRankingPositionItem[],
  pair: SeRankingPendingPair,
): SeRankingPositionItem | undefined {
  const normalizedKw = pair.keyword.trim().toLowerCase();
  return positions.find((p) => {
    if (
      pair.remoteKeywordId &&
      p.normalizedKeywordId === pair.remoteKeywordId
    ) {
      return true;
    }
    return (
      p.normalizedKeyword.length > 0 &&
      p.normalizedKeyword.toLowerCase() === normalizedKw
    );
  });
}

function recordBaselineObservations(
  items: SeRankingPositionItem[],
  today: string,
): Record<string, SeRankingObservationFingerprint | null> {
  const observations: Record<string, SeRankingObservationFingerprint | null> =
    {};
  for (const item of items) {
    const identity =
      item.normalizedKeywordId || item.normalizedKeyword.trim().toLowerCase();
    if (!identity || identity in observations) continue;
    const obs = extractPositionObservation(item, today);
    observations[identity] = obs.observed
      ? fingerprintOfObservation(obs)
      : null;
  }
  return observations;
}

/**
 * Captures a pre-recheck baseline for each engine in the run, BEFORE the paid
 * recheck POST is dispatched:
 *  - whether SE Ranking already reported a check date >= `today` (pre-checked),
 *  - a fingerprint of each keyword's today-dated observation at baseline time.
 *
 * The result is persisted by the caller as a workflow step result (durable
 * across restarts) and compared against later poll rounds to prevent stale
 * same-day data from an earlier run being attributed to this recheck.
 *
 * Timezone assumption: SE Ranking check dates are day strings in the remote
 * project's configured timezone, but the local rank_tracking_configs schema
 * has no timezone column, so `today` is the UTC calendar date. Near a local
 * (e.g. UTC+2/+3) midnight boundary an engine can be flagged pre-checked or
 * not-pre-checked one day off; the fingerprint comparison keeps both
 * directions safe (UNVERIFIED / LIKELY_COMPLETE rather than a false CONFIRMED).
 */
export async function captureSeRankingRecheckBaseline(input: {
  client: ReturnType<typeof createSeRankingClient>;
  remoteSiteId: number;
  today: string;
  pendingPairs: SeRankingPendingPair[];
}): Promise<SeRankingRecheckBaseline> {
  // Refresh the fallback execution date at step-execution time; a `today`
  // frozen at workflow start must not be trusted across a UTC midnight.
  const today = freshToday();
  const engineIds = [
    ...new Set(input.pendingPairs.map((p) => p.remoteSiteEngineId)),
  ];

  const baseline: SeRankingRecheckBaseline = {};
  for (const siteEngineId of engineIds) {
    const key = String(siteEngineId ?? "all");

    let checkDates: string[] = [];
    let hadTodayCheckDate = true;
    let latestCheckDate: string | null = null;
    try {
      checkDates = await SeRankingProjectService.getCheckDates(
        input.client,
        input.remoteSiteId,
        siteEngineId,
      );
      hadTodayCheckDate =
        Array.isArray(checkDates) && checkDates.some((date) => date >= today);
      latestCheckDate =
        Array.isArray(checkDates) && checkDates.length > 0
          ? (checkDates.toSorted().at(-1) ?? null)
          : null;
    } catch (err) {
      console.warn(
        `[seranking-baseline] check-dates read failed for engine ${key}; treating as pre-checked`,
        err instanceof Error ? err.message : err,
      );
    }

    // Resolve the effective provider-local date for this engine: prefer a
    // reported check date >= today, else fall back to the refreshed today.
    const effectiveDate = resolveEffectiveProviderDate({
      checkDates,
      today,
    });

    let observations: Record<string, SeRankingObservationFingerprint | null> =
      {};
    if (hadTodayCheckDate) {
      try {
        const items = await SeRankingProjectService.getPositions(input.client, {
          siteId: input.remoteSiteId,
          siteEngineId,
          dateFrom: effectiveDate,
          dateTo: effectiveDate,
          withLandingPages: true,
          withSerpFeatures: true,
        });
        observations = recordBaselineObservations(items, effectiveDate);
      } catch (err) {
        console.warn(
          `[seranking-baseline] positions read failed for engine ${key}; baseline fingerprints unavailable`,
          err instanceof Error ? err.message : err,
        );
      }
    }

    baseline[key] = { hadTodayCheckDate, latestCheckDate, observations };
  }

  return baseline;
}

export type StragglerBaselineResolution = {
  confidence: SeRankingCompletionConfidence;
  position: number | null;
  url: string | null;
  serpFeatures: string | null;
  rankingStatus: "RANKED" | "NO_RESULT" | "CHECK_FAILED";
  providerStatus: string;
  providerStatusCode: number;
  errorMessage: string | null;
  observedDate: string;
};

export async function evaluatePreCheckedStraggler(input: {
  cache: Map<string, SeRankingPositionItem[] | null>;
  engineKey: string;
  baseline: SeRankingEngineRecheckBaseline;
  pair: SeRankingPendingPair;
  client: ReturnType<typeof createSeRankingClient>;
  siteId: number;
  today: string;
  /** Operator-facing message for the uncollected/timed-out case. */
  message?: string;
}): Promise<StragglerBaselineResolution | null> {
  // Refresh the fallback execution date at step-execution time.
  const today = freshToday();

  // Resolve the effective provider-local date by refreshing check dates at
  // execution time, so the straggler observation is matched against the
  // engine's actual latest provider check date rather than a frozen day.
  let effectiveDate = today;
  try {
    const checkDates = await SeRankingProjectService.getCheckDates(
      input.client,
      input.siteId,
      input.pair.remoteSiteEngineId,
    );
    effectiveDate = resolveEffectiveProviderDate({
      checkDates,
      today,
      baselineLatestCheckDate: input.baseline.latestCheckDate,
    });
  } catch {
    // Fall back to the refreshed today; the fingerprint comparison still
    // keeps attribution safe.
  }

  let positions: SeRankingPositionItem[] | null;
  if (input.cache.has(input.engineKey)) {
    positions = input.cache.get(input.engineKey) ?? null;
  } else {
    try {
      positions = await SeRankingProjectService.getPositions(input.client, {
        siteId: input.siteId,
        siteEngineId: input.pair.remoteSiteEngineId,
        dateFrom: effectiveDate,
        dateTo: effectiveDate,
        withLandingPages: true,
        withSerpFeatures: true,
      });
    } catch {
      positions = null;
    }
    input.cache.set(input.engineKey, positions);
  }

  const matchedPos = positions
    ? matchPositionItem(positions, input.pair)
    : undefined;
  const obs = matchedPos
    ? extractPositionObservation(matchedPos, effectiveDate)
    : null;
  if (!obs?.observed) {
    return null;
  }

  const baselineFp =
    input.baseline.observations[pairObservationIdentity(input.pair)] ?? null;
  const changed =
    !baselineFp ||
    !fingerprintsEqual(baselineFp, fingerprintOfObservation(obs));

  return {
    confidence: changed ? "LIKELY_COMPLETE" : "UNVERIFIED",
    position: obs.position,
    url: obs.url,
    serpFeatures:
      obs.serpFeatures.length > 0 ? JSON.stringify(obs.serpFeatures) : null,
    rankingStatus: obs.position !== null ? "RANKED" : "NO_RESULT",
    providerStatus: changed
      ? "Likely new same-day observation after recheck (differs from pre-recheck baseline)"
      : "Unverified same-day observation: identical to pre-recheck baseline (possible stale attribution)",
    providerStatusCode: 200,
    errorMessage: null,
    observedDate: obs.observedDate ?? effectiveDate,
  };
}
