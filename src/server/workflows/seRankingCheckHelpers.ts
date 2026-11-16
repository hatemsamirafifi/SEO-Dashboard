/* eslint-disable complexity */
import type { InferInsertModel } from "drizzle-orm";
import type { rankSnapshots, rankProviderCalls } from "@/db/schema";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import {
  SeRankingProjectService,
  extractPositionObservation,
  type createSeRankingClient,
  type SeRankingPositionItem,
} from "@/server/lib/seranking";
export {
  captureSeRankingRecheckBaseline,
  freshToday,
  type SeRankingCompletionConfidence,
  type SeRankingEngineRecheckBaseline,
  type SeRankingObservationFingerprint,
  type SeRankingRecheckBaseline,
} from "./seRankingCheckBaseline";
export {
  resolveConfigTargets,
  buildScopedPendingPairs,
  type SeRankingPendingPair,
} from "./seRankingCheckTargets";
import {
  evaluatePreCheckedStraggler,
  fingerprintOfObservation,
  fingerprintsEqual,
  freshToday,
  matchPositionItem,
  pairObservationIdentity,
  resolveEffectiveProviderDate,
  type SeRankingCompletionConfidence,
  type SeRankingRecheckBaseline,
} from "./seRankingCheckBaseline";
import type { SeRankingPendingPair } from "./seRankingCheckTargets";
import { synchronizeSeRankingDailyObservations } from "./seRankingDailySync";
export { synchronizeSeRankingDailyObservations } from "./seRankingDailySync";

export async function isSeRankingRunCancelled(runId: string): Promise<boolean> {
  const run = await RankTrackingRepository.getRunById(runId);
  return run?.status !== "running" && run?.status !== "pending";
}

export async function collectSeRankingPollRound(input: {
  client: ReturnType<typeof createSeRankingClient>;
  remoteSiteId: number;
  runId: string;
  projectId: string;
  configId: string;
  today: string;
  pendingPairs: SeRankingPendingPair[];
  previousPositions: Map<string, number | null>;
  recheckBaseline?: SeRankingRecheckBaseline;
  readOnlySync?: boolean;
  trigger?: "manual" | "scheduled";
}) {
  if (input.readOnlySync) {
    return synchronizeSeRankingDailyObservations(input);
  }

  // Refresh the fallback execution date at step-execution time; a `today`
  // frozen at workflow start must not be trusted across a UTC midnight.
  const today = input.today || freshToday();
  const engineIds = [
    ...new Set(input.pendingPairs.map((p) => p.remoteSiteEngineId)),
  ];
  const positionsByEngine = new Map<number | "all", SeRankingPositionItem[]>();
  const engineCallDuration = new Map<number | "all", number>();
  const enginePendingDate = new Set<number | "all">();
  // Effective provider-local check date per engine, resolved from the
  // provider-reported check dates at execution time.
  const engineEffectiveDate = new Map<number | "all", string>();

  for (const siteEngineId of engineIds) {
    const key = siteEngineId ?? "all";
    const baselineLatestCheckDate =
      input.recheckBaseline?.[String(key)]?.latestCheckDate ?? null;
    let checkDates: string[] | null = null;
    if (
      siteEngineId !== undefined &&
      typeof SeRankingProjectService.getCheckDates === "function"
    ) {
      try {
        checkDates = await SeRankingProjectService.getCheckDates(
          input.client,
          input.remoteSiteId,
          siteEngineId,
        );
      } catch {
        checkDates = null;
      }
      if (input.readOnlySync) {
        if (!Array.isArray(checkDates) || checkDates.length === 0) {
          enginePendingDate.add(key);
          continue;
        }
      } else {
        if (
          Array.isArray(checkDates) &&
          !checkDates.some(
            (date) =>
              date >= today ||
              (baselineLatestCheckDate != null &&
                date > baselineLatestCheckDate),
          )
        ) {
          enginePendingDate.add(key);
          continue;
        }
      }
    }

    const effectiveDate = input.readOnlySync
      ? Array.isArray(checkDates) && checkDates.length > 0
        ? checkDates.toSorted().at(-1)!
        : today
      : resolveEffectiveProviderDate({
          checkDates,
          today,
          baselineLatestCheckDate,
        });
    engineEffectiveDate.set(key, effectiveDate);

    const startedAt = Date.now();
    const items = await SeRankingProjectService.getPositions(input.client, {
      siteId: input.remoteSiteId,
      siteEngineId,
      dateFrom: effectiveDate,
      dateTo: effectiveDate,
      withLandingPages: true,
      withSerpFeatures: true,
    });
    positionsByEngine.set(key, items);
    engineCallDuration.set(key, Math.max(0, Date.now() - startedAt));
  }

  const snapshotRows: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
  > = [];
  const providerCallRows: Array<
    Omit<InferInsertModel<typeof rankProviderCalls>, "id" | "createdAt">
  > = [];
  const stillPending: SeRankingPendingPair[] = [];
  let deduplicatedCount = 0;

  for (const pair of input.pendingPairs) {
    const engineKey = pair.remoteSiteEngineId ?? "all";
    if (enginePendingDate.has(engineKey)) {
      stillPending.push(pair);
      continue;
    }
    const positions = positionsByEngine.get(engineKey) ?? [];
    const matchedPos = matchPositionItem(positions, pair);

    if (!matchedPos) {
      stillPending.push(pair);
      continue;
    }

    const effectiveDate = engineEffectiveDate.get(engineKey) ?? today;
    const obs = extractPositionObservation(matchedPos, effectiveDate);
    if (!obs.observed) {
      stillPending.push(pair);
      continue;
    }

    let confidence: SeRankingCompletionConfidence = "CONFIRMED";
    if (!input.readOnlySync) {
      const baselineEngine =
        input.recheckBaseline?.[String(pair.remoteSiteEngineId ?? "all")];
      if (baselineEngine?.hadTodayCheckDate) {
        const identity = pairObservationIdentity(pair);
        const baselineFp = baselineEngine.observations[identity] ?? null;
        const currentFp = fingerprintOfObservation(obs);
        if (baselineFp && fingerprintsEqual(baselineFp, currentFp)) {
          stillPending.push(pair);
          continue;
        }
        confidence = "LIKELY_COMPLETE";
      }
    }

    const observationDate = obs.observedDate ?? effectiveDate;

    // Duplicate prevention for read-only daily position synchronization:
    // If an authentic snapshot already exists for this keyword, target, and provider date
    // with identical position and URL, do not insert duplicate row.
    if (input.readOnlySync) {
      const existingSnap =
        await RankTrackingRepository.findExistingSnapshotForObservation({
          configId: input.configId,
          trackingKeywordId: pair.trackingKeywordId,
          trackingTargetId: pair.targetId,
          device: pair.device,
          dateStr: observationDate,
          source: "daily_import",
        });

      if (
        existingSnap &&
        existingSnap.position === obs.position &&
        existingSnap.url === obs.url
      ) {
        deduplicatedCount++;
        continue;
      }
    }

    const isRanked = obs.position !== null;
    const prevPos =
      input.previousPositions.get(
        `${pair.targetId}:${pair.trackingKeywordId}:${pair.device}`,
      ) ??
      input.previousPositions.get(`${pair.trackingKeywordId}:${pair.device}`) ??
      null;

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
      previousPosition: prevPos,
      rankingStatus: isRanked ? "RANKED" : "NO_RESULT",
      url: obs.url,
      serpFeatures:
        obs.serpFeatures.length > 0 ? JSON.stringify(obs.serpFeatures) : null,
      provider: "seranking",
      providerStatus: isRanked
        ? input.readOnlySync
          ? typeof obs.providerChange === "number" || obs.landingPageDate
            ? JSON.stringify({
                status: "SE Ranking daily position import (read-only sync)",
                providerChange: obs.providerChange,
                landingPageObservedAt: obs.landingPageDate,
              })
            : "SE Ranking daily position import (read-only sync)"
          : typeof obs.providerChange === "number" || obs.landingPageDate
            ? JSON.stringify({
                status: "Ok",
                providerChange: obs.providerChange,
                landingPageObservedAt: obs.landingPageDate,
              })
            : "Ok"
        : "No ranking found",
      providerStatusCode: 200,
      errorMessage: null,
      completionConfidence: confidence,
      observationSource: input.readOnlySync
        ? "daily_sync"
        : input.trigger === "scheduled"
          ? "scheduled_check"
          : "manual_recheck",
      checkedDate: observationDate,
    });

    providerCallRows.push({
      runId: input.runId,
      trackingKeywordId: pair.trackingKeywordId,
      device: pair.device,
      provider: "seranking",
      endpoint: "/v1/project-management/sites/positions",
      status: "success",
      httpStatus: 200,
      errorCode: null,
      durationMs: engineCallDuration.get(engineKey) ?? 0,
    });
  }

  if (snapshotRows.length > 0) {
    await RankTrackingRepository.insertSnapshots(snapshotRows);
    await RankTrackingRepository.insertProviderCalls(providerCallRows);
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
    collectedCount:
      snapshotRows.length + (input.readOnlySync ? deduplicatedCount : 0),
    stillPending,
  };
}

export async function recordSeRankingUncollected(input: {
  runId: string;
  projectId: string;
  configId: string;
  today: string;
  message: string;
  rankingStatus?: "CHECK_FAILED" | "NOT_CHECKED";
  pendingPairs: SeRankingPendingPair[];
  previousPositions: Map<string, number | null>;
  client?: ReturnType<typeof createSeRankingClient>;
  remoteSiteId?: number;
  recheckBaseline?: SeRankingRecheckBaseline;
  trigger?: "manual" | "scheduled";
}) {
  const status = input.rankingStatus ?? "CHECK_FAILED";
  const evaluateBaselines =
    status === "CHECK_FAILED" &&
    input.client !== undefined &&
    input.remoteSiteId !== undefined &&
    input.recheckBaseline !== undefined;

  // Refresh the fallback execution date at step-execution time.
  const today = freshToday();
  const enginePositions = new Map<string, SeRankingPositionItem[] | null>();
  const failedSnapshots: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
  > = [];

  for (const pair of input.pendingPairs) {
    const engineKey = String(pair.remoteSiteEngineId ?? "all");
    const baseline = evaluateBaselines
      ? input.recheckBaseline?.[engineKey]
      : undefined;

    const resolved =
      baseline?.hadTodayCheckDate &&
      input.client &&
      input.remoteSiteId !== undefined
        ? await evaluatePreCheckedStraggler({
            cache: enginePositions,
            engineKey,
            baseline,
            pair,
            client: input.client,
            siteId: input.remoteSiteId,
            today,
            message: input.message,
          })
        : null;

    failedSnapshots.push({
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
      position: resolved ? resolved.position : null,
      previousPosition:
        input.previousPositions.get(
          `${pair.targetId}:${pair.trackingKeywordId}:${pair.device}`,
        ) ??
        input.previousPositions.get(
          `${pair.trackingKeywordId}:${pair.device}`,
        ) ??
        null,
      rankingStatus: resolved ? resolved.rankingStatus : status,
      url: resolved ? resolved.url : null,
      serpFeatures: resolved ? resolved.serpFeatures : null,
      provider: "seranking",
      providerStatus: resolved ? resolved.providerStatus : input.message,
      providerStatusCode: resolved ? resolved.providerStatusCode : null,
      errorMessage: resolved ? resolved.errorMessage : input.message,
      completionConfidence: resolved ? resolved.confidence : null,
      observationSource:
        input.trigger === "scheduled" ? "scheduled_check" : "manual_recheck",
      checkedDate: resolved ? resolved.observedDate : today,
    });
  }

  await RankTrackingRepository.insertSnapshots(failedSnapshots);
}
