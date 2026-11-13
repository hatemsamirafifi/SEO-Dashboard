import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SeRankingBindingRepository } from "@/server/features/rank-tracking/repositories/SeRankingBindingRepository";
import { SeRankingProjectSyncService } from "@/server/features/rank-tracking/services/SeRankingProjectSyncService";
import { getSeRankingSyncStatus } from "./seRankingSyncStatus";
import { AppError } from "@/server/lib/errors";

export async function getTargets(projectId: string, includeDisabled = true) {
  const rows = await RankTrackingTargetRepository.getTargetsForProject(
    projectId,
    !includeDisabled,
  );
  return rows.toSorted((a, b) => Number(b.enabled) - Number(a.enabled));
}

export async function addTarget(input: {
  organizationId: string;
  projectId: string;
  configId?: string;
  searchEngine?: string;
  countryCode: string;
  cityName?: string;
  languageCode: string;
  device: "desktop" | "mobile";
}) {
  const existing = await RankTrackingTargetRepository.findTarget({
    localProjectId: input.projectId,
    searchEngine: input.searchEngine || "google",
    countryCode: input.countryCode,
    cityName: input.cityName || null,
    languageCode: input.languageCode,
    device: input.device,
  });

  if (existing) {
    if (!existing.enabled) {
      await RankTrackingTargetRepository.updateTarget(existing.id, {
        enabled: true,
      });
      return { ...existing, enabled: true };
    }
    return existing;
  }

  return RankTrackingTargetRepository.createTarget({
    id: crypto.randomUUID(),
    organizationId: input.organizationId,
    localProjectId: input.projectId,
    trackingConfigId: input.configId || null,
    searchEngine: input.searchEngine || "google",
    countryCode: input.countryCode.toLowerCase(),
    regionCode: null,
    cityName: input.cityName || null,
    languageCode: input.languageCode.toLowerCase(),
    device: input.device,
    enabled: true,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
}

export async function removeTarget(targetId: string, projectId?: string) {
  if (projectId) {
    const existing = await RankTrackingTargetRepository.getTargetById(targetId);
    if (!existing || existing.localProjectId !== projectId) {
      throw new AppError("NOT_FOUND", "Tracking target not found");
    }
  }
  await RankTrackingTargetRepository.softDeleteTarget(targetId);
  return { ok: true, targetId };
}

export async function setTargetEnabled(
  targetId: string,
  projectId: string,
  enabled: boolean,
) {
  const existing = await RankTrackingTargetRepository.getTargetById(targetId);
  if (!existing || existing.localProjectId !== projectId) {
    throw new AppError("NOT_FOUND", "Tracking target not found");
  }
  await RankTrackingTargetRepository.updateTarget(targetId, { enabled });
  return { ok: true, targetId, enabled };
}

export async function assignKeywordToTarget(
  keywordId: string,
  targetId: string,
) {
  await RankTrackingTargetRepository.assignKeywordToTarget(keywordId, targetId);
  return { ok: true, keywordId, targetId };
}

export async function removeKeywordFromTarget(
  keywordId: string,
  targetId: string,
) {
  await RankTrackingTargetRepository.disableKeywordTarget(keywordId, targetId);
  return { ok: true, keywordId, targetId };
}

export async function getKeywordTargetAssignments(projectId: string) {
  const targets = await RankTrackingTargetRepository.getTargetsForProject(
    projectId,
    false,
  );
  const targetIds = targets.map((t) => t.id);
  const rows = await RankTrackingTargetRepository.getKeywordTargetsForTargets(
    targetIds,
    true,
  );
  const targetIdsByKeyword: Record<string, string[]> = {};
  for (const row of rows) {
    const existing = targetIdsByKeyword[row.trackingKeywordId] ?? [];
    existing.push(row.trackingTargetId);
    targetIdsByKeyword[row.trackingKeywordId] = existing;
  }
  return {
    assignments: rows,
    targetIdsByKeyword,
  };
}

export async function setKeywordTargetAssignments(input: {
  projectId: string;
  targetId: string;
  keywordIds: string[];
  enabled: boolean;
}) {
  const target = await RankTrackingTargetRepository.getTargetById(
    input.targetId,
  );
  if (!target || target.localProjectId !== input.projectId) {
    throw new AppError("NOT_FOUND", "Tracking target not found");
  }

  const configs = await RankTrackingRepository.getConfigsForProject(
    input.projectId,
  );
  const validKeywordIds = new Set<string>();
  for (const config of configs) {
    const kws = await RankTrackingRepository.getKeywordsForConfig(config.id);
    for (const kw of kws) validKeywordIds.add(kw.id);
  }

  let updated = 0;
  for (const keywordId of input.keywordIds) {
    if (!validKeywordIds.has(keywordId)) continue;
    if (input.enabled) {
      await RankTrackingTargetRepository.assignKeywordToTarget(
        keywordId,
        input.targetId,
      );
    } else {
      await RankTrackingTargetRepository.disableKeywordTarget(
        keywordId,
        input.targetId,
      );
    }
    updated++;
  }

  return {
    ok: true,
    updated,
    targetId: input.targetId,
    enabled: input.enabled,
  };
}

export { getSeRankingSyncStatus };

export async function migrateSeRankingAccount(params: {
  organizationId: string;
  newApiKey: string;
}) {
  return SeRankingProjectSyncService.migrateAccount(params);
}

export async function syncSeRankingProject(params: {
  localProjectId: string;
  organizationId: string;
  domain: string;
  configId: string;
}) {
  const { projectBinding, client, remoteSiteId } =
    await SeRankingProjectSyncService.ensureProject({
      localProjectId: params.localProjectId,
      organizationId: params.organizationId,
      domain: params.domain,
    });

  try {
    if (remoteSiteId) {
      await SeRankingProjectSyncService.ensureSearchEngines({
        localProjectId: params.localProjectId,
        organizationId: params.organizationId,
        projectBindingId: projectBinding.id,
        remoteSiteId,
        client,
      });

      await SeRankingProjectSyncService.syncTrackedKeywords({
        localProjectId: params.localProjectId,
        configId: params.configId,
        projectBindingId: projectBinding.id,
        remoteSiteId,
        client,
      });
    }

    const nowIso = new Date().toISOString();
    await SeRankingBindingRepository.updateProjectBinding(projectBinding.id, {
      status: "connected",
      lastSuccessfulSync: nowIso,
      errorMessage: null,
    });

    return {
      ok: true,
      projectBinding: {
        ...projectBinding,
        status: "connected",
        lastSuccessfulSync: nowIso,
        errorMessage: null,
      },
      remoteSiteId,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isQuota =
      error instanceof AppError &&
      (error.code === "PAYMENT_REQUIRED" || error.code === "FORBIDDEN");
    await SeRankingBindingRepository.updateProjectBinding(projectBinding.id, {
      status: isQuota ? "paused" : "failed",
      errorMessage: message,
    });
    throw error;
  }
}
