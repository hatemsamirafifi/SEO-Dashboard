/* eslint-disable complexity */
import type { InferInsertModel } from "drizzle-orm";
import type { rankSnapshots, rankProviderCalls } from "@/db/schema";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";
import {
  SeRankingProjectService,
  extractPositionObservation,
  type createSeRankingClient,
  type SeRankingPositionItem,
} from "@/server/lib/seranking";
import { matchPositionItem } from "./seRankingCheckBaseline";
import type { SeRankingPendingPair } from "./seRankingCheckTargets";

interface SyncPairObservationContext {
  pair: SeRankingPendingPair;
  effectiveDates: string[];
  matchedPos: SeRankingPositionItem;
  input: {
    runId: string;
    projectId: string;
    configId: string;
    previousPositions: Map<string, number | null>;
  };
}

/**
 * Daily Import Idempotency & Correction Policy:
 * - Source dates (`checkedDate = dateStr`) and distinct `(targetId, device)`
 *   identities are always preserved on each snapshot.
 * - Lookups match prior daily imports strictly by provenance (`observationSource='daily_sync'`),
 *   so manual/DataForSEO/recheck rows are never mutated or overwritten.
 * - If the latest `daily_sync` snapshot for `(targetId, keywordId, device, dateStr)` has the
 *   exact same `(position, url)`, the observation is deduplicated without writing a duplicate row.
 * - If the provider later corrects `position` or landing `url` for an already-imported `dateStr`,
 *   a new immutable snapshot row is appended with `observationSource='daily_sync'`, preserving
 *   `previousImportedPosition` / `previousImportedUrl` in `providerStatus`; deterministic
 *   read queries (`snapshotQueries.ts`) select the newest `checkedAt` row for display.
 */
async function processPairObservations(
  ctx: SyncPairObservationContext,
  snapshotRows: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt"> & {
      checkedAt?: string;
    }
  >,
): Promise<{ observationsFound: number; deduplicated: number }> {
  let observationsFound = 0;
  let deduplicated = 0;
  const { pair, effectiveDates, matchedPos, input } = ctx;

  let lastKnownPosForPair: number | null =
    input.previousPositions.get(
      `${pair.targetId}:${pair.trackingKeywordId}:${pair.device}`,
    ) ??
    input.previousPositions.get(`${pair.trackingKeywordId}:${pair.device}`) ??
    null;

  for (const dateStr of effectiveDates) {
    const obs = extractPositionObservation(matchedPos, dateStr);
    if (!obs.observed) {
      // Do not fabricate observations for dates where provider has no data
      continue;
    }

    observationsFound++;

    const existingSnap =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: input.configId,
        trackingKeywordId: pair.trackingKeywordId,
        trackingTargetId: pair.targetId,
        device: pair.device,
        dateStr,
        source: "daily_import",
      });

    if (
      existingSnap &&
      existingSnap.position === obs.position &&
      existingSnap.url === obs.url
    ) {
      deduplicated++;
      if (obs.position !== null) {
        lastKnownPosForPair = obs.position;
      }
      continue;
    }

    const isRanked = obs.position !== null;
    const providerStatusJson = JSON.stringify({
      status: "SE Ranking daily position import (read-only sync)",
      providerChange: obs.providerChange,
      landingPageObservedAt: obs.landingPageDate,
      ...(existingSnap
        ? {
            previousImportedPosition: existingSnap.position,
            previousImportedUrl: existingSnap.url,
          }
        : {}),
    });

    const importTimestamp = toSqliteTimestamp(new Date());

    snapshotRows.push({
      runId: input.runId,
      projectId: input.projectId,
      configId: input.configId,
      trackingTargetId: pair.targetId,
      trackingKeywordId: pair.trackingKeywordId,
      keyword: pair.keyword,
      searchEngine: pair.searchEngine,
      searchType: "organic",
      location: pair.cityName || pair.countryCode,
      language: pair.languageCode,
      countryCode: pair.countryCode,
      cityName: pair.cityName,
      device: pair.device,
      position: obs.position,
      previousPosition: lastKnownPosForPair,
      rankingStatus: isRanked ? "RANKED" : "NO_RESULT",
      url: obs.url,
      serpFeatures:
        obs.serpFeatures.length > 0 ? JSON.stringify(obs.serpFeatures) : null,
      provider: "seranking",
      providerStatus: providerStatusJson,
      providerStatusCode: 200,
      errorMessage: null,
      completionConfidence: "CONFIRMED",
      observationSource: "daily_sync",
      checkedDate: dateStr,
      checkedAt: importTimestamp,
      importedAt: importTimestamp,
    });

    if (obs.position !== null) {
      lastKnownPosForPair = obs.position;
    }
  }

  return { observationsFound, deduplicated };
}

export async function synchronizeSeRankingDailyObservations(input: {
  client: ReturnType<typeof createSeRankingClient>;
  remoteSiteId: number;
  runId: string;
  projectId: string;
  configId: string;
  today?: string;
  replayFromDate?: string;
  pendingPairs: SeRankingPendingPair[];
  previousPositions: Map<string, number | null>;
}) {
  const engineIds = [
    ...new Set(input.pendingPairs.map((p) => p.remoteSiteEngineId)),
  ];
  const snapshotRows: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt"> & {
      checkedAt?: string;
    }
  > = [];
  const providerCallRows: Array<
    Omit<InferInsertModel<typeof rankProviderCalls>, "id" | "createdAt">
  > = [];
  const stillPending: SeRankingPendingPair[] = [];
  let deduplicatedCount = 0;

  for (const siteEngineId of engineIds) {
    const key = siteEngineId ?? "all";
    const pairsForEngine = input.pendingPairs.filter(
      (p) => (p.remoteSiteEngineId ?? "all") === key,
    );
    if (pairsForEngine.length === 0) continue;

    let checkDates: string[] | null = null;
    const checkDatesStart = Date.now();
    try {
      checkDates = await SeRankingProjectService.getCheckDates(
        input.client,
        input.remoteSiteId,
        siteEngineId,
      );
      providerCallRows.push({
        runId: input.runId,
        trackingKeywordId: pairsForEngine[0]?.trackingKeywordId ?? null,
        device: pairsForEngine[0]?.device ?? "desktop",
        provider: "seranking",
        endpoint: "/v1/project-management/sites/check-dates",
        status: "success",
        httpStatus: 200,
        errorCode: null,
        durationMs: Math.max(0, Date.now() - checkDatesStart),
      });
    } catch (err) {
      providerCallRows.push({
        runId: input.runId,
        trackingKeywordId: pairsForEngine[0]?.trackingKeywordId ?? null,
        device: pairsForEngine[0]?.device ?? "desktop",
        provider: "seranking",
        endpoint: "/v1/project-management/sites/check-dates",
        status: "failed",
        httpStatus: (err as { statusCode?: number })?.statusCode ?? 500,
        errorCode: err instanceof Error ? err.name : "CheckDatesError",
        durationMs: Math.max(0, Date.now() - checkDatesStart),
      });
      checkDates = null;
    }

    if (!Array.isArray(checkDates) || checkDates.length === 0) {
      for (const p of pairsForEngine) stillPending.push(p);
      continue;
    }

    const sortedCheckDates = checkDates.toSorted();
    console.log(
      `[seranking-read-only-sync] Fetched check dates for site ${input.remoteSiteId}, engine ${siteEngineId}: ${sortedCheckDates.length} date(s) available.`,
    );

    let earliestNeedDate: string | null = null;
    let hasPairWithoutPriorSnapshots = false;
    for (const pair of pairsForEngine) {
      const lastImportedDate =
        await RankTrackingRepository.getLatestSnapshotDateForKeywordTarget({
          configId: input.configId,
          trackingKeywordId: pair.trackingKeywordId,
          trackingTargetId: pair.targetId,
          device: pair.device,
        });
      if (lastImportedDate) {
        if (!earliestNeedDate || lastImportedDate < earliestNeedDate) {
          earliestNeedDate = lastImportedDate;
        }
      } else {
        hasPairWithoutPriorSnapshots = true;
      }
    }

    const candidateDates = input.replayFromDate
      ? sortedCheckDates.filter((d) => d >= input.replayFromDate!)
      : earliestNeedDate && !hasPairWithoutPriorSnapshots
        ? sortedCheckDates.filter((d) => d >= earliestNeedDate)
        : sortedCheckDates.slice(-30);

    const effectiveDates =
      candidateDates.length > 0 ? candidateDates : [sortedCheckDates.at(-1)!];
    const dateFrom = effectiveDates[0];
    const dateTo = effectiveDates.at(-1)!;

    const positionsStart = Date.now();
    let items: SeRankingPositionItem[] = [];
    try {
      items = await SeRankingProjectService.getPositions(input.client, {
        siteId: input.remoteSiteId,
        siteEngineId,
        dateFrom,
        dateTo,
        withLandingPages: true,
        withSerpFeatures: true,
      });
      console.log(
        `[seranking-read-only-sync] Fetched positions for site ${input.remoteSiteId}, engine ${siteEngineId} (${items.length} items from ${dateFrom} to ${dateTo}).`,
      );
      providerCallRows.push({
        runId: input.runId,
        trackingKeywordId: pairsForEngine[0]?.trackingKeywordId ?? null,
        device: pairsForEngine[0]?.device ?? "desktop",
        provider: "seranking",
        endpoint: "/v1/project-management/sites/positions",
        status: "success",
        httpStatus: 200,
        errorCode: null,
        durationMs: Math.max(0, Date.now() - positionsStart),
      });
    } catch (err) {
      providerCallRows.push({
        runId: input.runId,
        trackingKeywordId: pairsForEngine[0]?.trackingKeywordId ?? null,
        device: pairsForEngine[0]?.device ?? "desktop",
        provider: "seranking",
        endpoint: "/v1/project-management/sites/positions",
        status: "failed",
        httpStatus: (err as { statusCode?: number })?.statusCode ?? 500,
        errorCode: err instanceof Error ? err.name : "GetPositionsError",
        durationMs: Math.max(0, Date.now() - positionsStart),
      });
      for (const p of pairsForEngine) stillPending.push(p);
      continue;
    }

    for (const pair of pairsForEngine) {
      const matchedPos = matchPositionItem(items, pair);
      if (!matchedPos) {
        stillPending.push(pair);
        continue;
      }

      if (
        pair.remoteKeywordId &&
        matchedPos.normalizedKeywordId &&
        matchedPos.normalizedKeywordId !== pair.remoteKeywordId
      ) {
        stillPending.push(pair);
        continue;
      }

      const outcome = await processPairObservations(
        { pair, effectiveDates, matchedPos, input },
        snapshotRows,
      );
      deduplicatedCount += outcome.deduplicated;
      if (outcome.observationsFound === 0) {
        stillPending.push(pair);
      }
    }
  }

  if (snapshotRows.length > 0) {
    await RankTrackingRepository.insertSnapshots(snapshotRows);
    console.log(
      `[seranking-read-only-sync] Stored ${snapshotRows.length} snapshot row(s) (${deduplicatedCount} deduplicated) for run ${input.runId}.`,
    );
  }
  if (providerCallRows.length > 0) {
    await RankTrackingRepository.insertProviderCalls(providerCallRows);
  }

  const collectedCount = input.pendingPairs.length - stillPending.length;
  if (collectedCount > 0) {
    const allRunSnapshots = await RankTrackingRepository.getSnapshotsForRun(
      input.runId,
    );
    const stillPendingKeywordIds = new Set(
      stillPending.map((p) => p.trackingKeywordId),
    );
    const fullyResolvedKeywordIds = new Set(
      allRunSnapshots
        .map((s) => s.trackingKeywordId)
        .filter((kwId) => !stillPendingKeywordIds.has(kwId)),
    );
    await RankTrackingRepository.updateRun(input.runId, {
      keywordsChecked: fullyResolvedKeywordIds.size,
    });
  }

  return {
    collectedCount,
    stillPending,
    deduplicatedCount,
    importedCount: snapshotRows.length,
    readRequestsCount: providerCallRows.length,
  };
}
