import { createServerFn } from "@tanstack/react-start";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingService } from "@/server/features/rank-tracking/services/RankTrackingService";
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import { AppError } from "@/server/lib/errors";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "@/serverFunctions/middleware";
import {
  getConfigsSchema,
  createTargetSchema,
  removeTargetSchema,
  toggleTargetSchema,
  setKeywordTargetAssignmentsSchema,
  syncSeRankingSchema,
  seRankingSyncStatusInputSchema,
  triggerOrgAccountMigrationSchema,
  retrySeRankingSyncSchema,
} from "@/types/schemas/rank-tracking";

export const getRankTrackingTargets = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getConfigsSchema)
  .handler(async ({ context }) => {
    return RankTrackingService.getTargets(context.projectId, true);
  });

export const addRankTrackingTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createTargetSchema)
  .handler(async ({ data, context }) => {
    return RankTrackingService.addTarget({
      projectId: context.projectId,
      organizationId: context.organizationId,
      configId: data.configId,
      countryCode: data.countryCode,
      cityName: data.cityName,
      languageCode: data.languageCode,
      device: data.device,
    });
  });

export const removeRankTrackingTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(removeTargetSchema)
  .handler(async ({ data, context }) => {
    return RankTrackingService.removeTarget(data.targetId, context.projectId);
  });

export const toggleRankTrackingTarget = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(toggleTargetSchema)
  .handler(async ({ data, context }) => {
    return RankTrackingService.setTargetEnabled(
      data.targetId,
      context.projectId,
      data.enabled,
    );
  });

export const getKeywordTargetAssignments = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getConfigsSchema)
  .handler(async ({ context }) => {
    return RankTrackingService.getKeywordTargetAssignments(context.projectId);
  });

export const setKeywordTargetAssignmentsFn = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setKeywordTargetAssignmentsSchema)
  .handler(async ({ data, context }) => {
    return RankTrackingService.setKeywordTargetAssignments({
      projectId: context.projectId,
      targetId: data.targetId,
      keywordIds: data.keywordIds,
      enabled: data.enabled,
    });
  });

export const syncSeRankingProject = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(syncSeRankingSchema)
  .handler(async ({ data, context }) => {
    const config = await RankTrackingRepository.getConfigById({
      configId: data.configId,
      projectId: context.projectId,
    });
    if (!config) {
      throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
    }
    return RankTrackingService.syncSeRankingProject({
      localProjectId: context.projectId,
      organizationId: context.organizationId,
      domain: data.domain,
      configId: data.configId,
    });
  });

export const getSeRankingSyncStatusFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(seRankingSyncStatusInputSchema)
  .handler(async ({ data, context }) => {
    if (data.projectId) {
      const orgProjects =
        await RankTrackingRepository.getProjectsForOrganization(
          context.organizationId,
        );
      if (!orgProjects.some((p) => p.id === data.projectId)) {
        throw new AppError("NOT_FOUND", "Project not found");
      }
    }
    return RankTrackingService.getSeRankingSyncStatus({
      organizationId: context.organizationId,
      projectId: data.projectId,
    });
  });

export const retrySeRankingProjectSyncFn = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(retrySeRankingSyncSchema)
  .handler(async ({ data, context }) => {
    const configs = await RankTrackingRepository.getConfigsForProject(
      context.projectId,
    );
    const targetConfig = data.configId
      ? configs.find((c) => c.id === data.configId)
      : configs[0];
    if (!targetConfig) {
      throw new AppError(
        "NOT_FOUND",
        "No rank tracking configuration found for this project",
      );
    }
    return RankTrackingService.syncSeRankingProject({
      localProjectId: context.projectId,
      organizationId: context.organizationId,
      domain: targetConfig.domain,
      configId: targetConfig.id,
    });
  });

export const migrateSeRankingAccountFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(triggerOrgAccountMigrationSchema)
  .handler(async ({ data, context }) => {
    let apiKey = data.newApiKey?.trim();
    if (!apiKey) {
      const config = await resolveEffectiveSeRankingConfig({
        organizationId: context.organizationId,
        projectId: data.projectId,
      });
      if (!config.enabled || !config.apiKey) {
        throw new AppError(
          "VALIDATION_ERROR",
          "SE Ranking is not configured or enabled for this workspace",
        );
      }
      apiKey = config.apiKey;
    }
    return RankTrackingService.migrateSeRankingAccount({
      organizationId: context.organizationId,
      newApiKey: apiKey,
    });
  });
