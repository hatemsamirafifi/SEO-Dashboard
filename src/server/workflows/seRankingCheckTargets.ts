import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
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

export async function reconstructExpectedPairs(input: {
  configId: string;
  projectId: string;
  organizationId: string;
  devices: "both" | "desktop" | "mobile";
  locationCode: number;
  languageCode: string;
  locationName?: string;
  keywords: Array<{ id: string; keyword: string }>;
}): Promise<Array<{ trackingKeywordId: string; trackingTargetId: string }>> {
  const targets = await resolveConfigTargets({
    configId: input.configId,
    projectId: input.projectId,
    organizationId: input.organizationId,
    devices: input.devices,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    locationName: input.locationName,
  });

  const ktAssignments =
    await RankTrackingTargetRepository.getKeywordTargetsForTargets(
      targets.map((t) => t.id),
      false,
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

  const pairs: Array<{
    trackingKeywordId: string;
    trackingTargetId: string;
    device?: "desktop" | "mobile";
  }> = [];
  for (const target of targets) {
    for (const kw of input.keywords) {
      const explicit = kwAssignmentMap.get(kw.id);
      if (explicit && explicit.size > 0) {
        if (explicit.get(target.id) !== true) continue;
      }
      pairs.push({
        trackingKeywordId: kw.id,
        trackingTargetId: target.id,
        device: target.device,
      });
    }
  }
  return pairs;
}
