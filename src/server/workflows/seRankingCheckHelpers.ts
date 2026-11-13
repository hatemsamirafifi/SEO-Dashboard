import type { InferInsertModel } from "drizzle-orm";
import type { rankSnapshots, rankProviderCalls } from "@/db/schema";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import {
  SeRankingProjectService,
  extractPositionObservation,
  type createSeRankingClient,
  type SeRankingPositionItem,
} from "@/server/lib/seranking";
import { getIsoCountryCode } from "@/shared/keyword-locations";

export interface SeRankingPendingPair {
  targetId: string;
  trackingKeywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  countryCode: string;
  cityName: string | null;
  languageCode: string;
  searchEngine: string;
  remoteSiteEngineId?: number;
  remoteKeywordId?: string;
}

export async function isSeRankingRunCancelled(runId: string): Promise<boolean> {
  const run = await RankTrackingRepository.getRunById(runId);
  return run?.status !== "running" && run?.status !== "pending";
}

function matchPositionItem(
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

export async function resolveConfigTargets(input: {
  configId: string;
  projectId: string;
  organizationId: string;
  devices: "both" | "desktop" | "mobile";
  locationCode: number;
  languageCode: string;
  locationName?: string;
}) {
  let configTargets = await RankTrackingTargetRepository.getTargetsForConfig(
    input.configId,
    true,
  );

  if (configTargets.length === 0) {
    const projectTargets =
      await RankTrackingTargetRepository.getTargetsForProject(
        input.projectId,
        true,
      );
    configTargets = projectTargets.filter(
      (t) =>
        t.trackingConfigId === null || t.trackingConfigId === input.configId,
    );
  }

  const requiredDevices: Array<"desktop" | "mobile"> =
    input.devices === "both" ? ["desktop", "mobile"] : [input.devices];
  const countryCode = getIsoCountryCode(input.locationCode).toLowerCase();
  const languageCode = (input.languageCode || "en").toLowerCase();
  const cityName = input.locationName || null;

  for (const device of requiredDevices) {
    if (configTargets.some((t) => t.device === device)) continue;

    const existing = await RankTrackingTargetRepository.findTarget({
      localProjectId: input.projectId,
      searchEngine: "google",
      countryCode,
      cityName,
      languageCode,
      device,
    });

    if (existing) {
      if (!existing.enabled || !existing.trackingConfigId) {
        await RankTrackingTargetRepository.updateTarget(existing.id, {
          enabled: true,
          trackingConfigId: existing.trackingConfigId ?? input.configId,
        });
      }
      configTargets.push({
        ...existing,
        enabled: true,
        trackingConfigId: existing.trackingConfigId ?? input.configId,
      });
    } else {
      const created = await RankTrackingTargetRepository.createTarget({
        id: crypto.randomUUID(),
        organizationId: input.organizationId,
        localProjectId: input.projectId,
        trackingConfigId: input.configId,
        searchEngine: "google",
        countryCode,
        regionCode: null,
        cityName,
        languageCode,
        device,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      });
      configTargets.push(created);
    }
  }

  return configTargets;
}

export async function buildScopedPendingPairs(input: {
  projectBindingId: string;
  targets: Array<{
    id: string;
    device: "desktop" | "mobile";
    countryCode: string;
    cityName: string | null;
    languageCode: string;
    searchEngine: string;
  }>;
  keywords: Array<{ id: string; keyword: string }>;
}): Promise<SeRankingPendingPair[]> {
  const [mappings, engineBindings, ktAssignments] = await Promise.all([
    SeRankingBindingRepository.getKeywordMappingsForProject(
      input.projectBindingId,
    ),
    SeRankingBindingRepository.getEngineBindingsForProject(
      input.projectBindingId,
    ),
    RankTrackingTargetRepository.getKeywordTargetsForTargets(
      input.targets.map((t) => t.id),
      false,
    ),
  ]);

  const kwToRemoteId = new Map<string, string>(
    mappings.map((m) => [m.trackingKeywordId, m.remoteKeywordId]),
  );
  const targetToSiteEngine = new Map<string, number>(
    engineBindings.map((b) => [b.trackingTargetId, b.remoteSiteEngineId]),
  );

  const kwAssignmentMap = new Map<string, Map<string, boolean>>();
  for (const row of ktAssignments) {
    let perTarget = kwAssignmentMap.get(row.trackingKeywordId);
    if (!perTarget) {
      perTarget = new Map<string, boolean>();
      kwAssignmentMap.set(row.trackingKeywordId, perTarget);
    }
    perTarget.set(row.trackingTargetId, row.enabled);
  }

  const pairs: SeRankingPendingPair[] = [];
  for (const target of input.targets) {
    for (const kw of input.keywords) {
      const explicitTargets = kwAssignmentMap.get(kw.id);
      if (explicitTargets && explicitTargets.size > 0) {
        if (explicitTargets.get(target.id) !== true) continue;
      }
      pairs.push({
        targetId: target.id,
        trackingKeywordId: kw.id,
        keyword: kw.keyword,
        device: target.device,
        countryCode: target.countryCode,
        cityName: target.cityName ?? null,
        languageCode: target.languageCode,
        searchEngine: target.searchEngine || "google",
        remoteSiteEngineId: targetToSiteEngine.get(target.id),
        remoteKeywordId: kwToRemoteId.get(kw.id),
      });
    }
  }
  return pairs;
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
}) {
  const engineIds = [
    ...new Set(input.pendingPairs.map((p) => p.remoteSiteEngineId)),
  ];
  const positionsByEngine = new Map<number | "all", SeRankingPositionItem[]>();
  const engineCallDuration = new Map<number | "all", number>();
  const enginePendingDate = new Set<number | "all">();

  for (const siteEngineId of engineIds) {
    const key = siteEngineId ?? "all";
    if (
      siteEngineId !== undefined &&
      typeof SeRankingProjectService.getCheckDates === "function"
    ) {
      const checkDates = await SeRankingProjectService.getCheckDates(
        input.client,
        input.remoteSiteId,
        siteEngineId,
      );
      if (
        Array.isArray(checkDates) &&
        !checkDates.some((date) => date >= input.today)
      ) {
        enginePendingDate.add(key);
        continue;
      }
    }

    const startedAt = Date.now();
    const items = await SeRankingProjectService.getPositions(input.client, {
      siteId: input.remoteSiteId,
      siteEngineId,
      dateFrom: input.today,
      dateTo: input.today,
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

    const obs = extractPositionObservation(matchedPos, input.today);
    if (!obs.observed) {
      stillPending.push(pair);
      continue;
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
      providerStatus: isRanked ? "Ok" : "No ranking found",
      providerStatusCode: 200,
      errorMessage: null,
      checkedDate: obs.observedDate ?? input.today,
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
    await RankTrackingRepository.updateRun(input.runId, {
      keywordsChecked: new Set(allRunSnapshots.map((s) => s.trackingKeywordId))
        .size,
    });
  }

  return {
    collectedCount: snapshotRows.length,
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
}) {
  const status = input.rankingStatus ?? "CHECK_FAILED";
  const failedSnapshots: Array<
    Omit<InferInsertModel<typeof rankSnapshots>, "id" | "checkedAt">
  > = input.pendingPairs.map((pair) => ({
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
    position: null,
    previousPosition:
      input.previousPositions.get(
        `${pair.targetId}:${pair.trackingKeywordId}:${pair.device}`,
      ) ??
      input.previousPositions.get(`${pair.trackingKeywordId}:${pair.device}`) ??
      null,
    rankingStatus: status,
    url: null,
    serpFeatures: null,
    provider: "seranking",
    providerStatus: input.message,
    providerStatusCode: null,
    errorMessage: input.message,
    checkedDate: input.today,
  }));

  await RankTrackingRepository.insertSnapshots(failedSnapshots);
}
