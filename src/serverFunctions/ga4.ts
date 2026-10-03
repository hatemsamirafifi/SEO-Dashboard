import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { AnalyticsService } from "@/server/features/ga4/services/AnalyticsService";
import { Ga4GoalService } from "@/server/features/ga4/services/Ga4GoalService";
import { Ga4SyncService } from "@/server/features/ga4/services/Ga4SyncService";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GA4_GRAINS } from "@/server/features/ga4/services/ga4SyncUtils";
import { Ga4ApiError, Ga4TokenError } from "@/server/lib/ga4Client";
import { createSelfHostedGa4AuthorizationUrl } from "@/server/features/gsc/selfHostedOAuth";
import { hasSelfHostedGscConfig } from "@/server/features/gsc/oauth-config";
import {
  analyticsAcquisitionSchema,
  analyticsAudienceSchema,
  analyticsConversionsSchema,
  analyticsEcommerceSchema,
  analyticsEventsSchema,
  analyticsGeoSchema,
  analyticsLandingPagesSchema,
  analyticsOverviewSchema,
  analyticsTechnologySchema,
  archiveGa4GoalSchema,
  createGa4GoalSchema,
  ga4PeriodUsersSchema,
  ga4ProjectSchema,
  ga4SyncStatusSchema,
  listGa4GoalsSchema,
  setGa4PropertySchema,
  startGa4LinkSchema,
  triggerGa4SyncSchema,
  updateGa4GoalSchema,
} from "@/types/schemas/ga4";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "./middleware";

export const getGa4GrantStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => ({
    connected: await Ga4Service.userHasGrant(context.userId),
  }));
export const getGa4Connection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => {
    const [connection, currentUserHasGrant, hosted, configured] =
      await Promise.all([
        Ga4Service.getConnection(context.projectId, context.organizationId),
        Ga4Service.userHasGrant(context.userId),
        isHostedServerAuthMode(),
        hasSelfHostedGscConfig(),
      ]);
    return {
      connected: Boolean(connection),
      currentUserHasGrant,
      googleOAuthConfigured: hosted || configured,
      propertyId: connection?.propertyId ?? null,
      propertyDisplayName: connection?.propertyDisplayName ?? null,
      connectedAt: connection?.createdAt ?? null,
    };
  });
export const listGa4Properties = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => {
    try {
      return {
        accounts: await Ga4Service.listPropertiesForUser(context.userId),
        failure: null as "permission" | "provider" | null,
      };
    } catch (error) {
      if (
        error instanceof Ga4TokenError ||
        (error instanceof Ga4ApiError && [401, 403].includes(error.status))
      )
        return { accounts: [], failure: "permission" as const };
      return { accounts: [], failure: "provider" as const };
    }
  });
export const setGa4Property = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setGa4PropertySchema)
  .handler(async ({ data, context }) => {
    const connection = await Ga4Service.setProperty({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      accountId: data.accountId,
      propertyId: data.propertyId,
    });
    return {
      connected: true as const,
      propertyId: connection.propertyId,
      propertyDisplayName: connection.propertyDisplayName,
    };
  });
export const disconnectGa4 = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => {
    await Ga4Service.disconnect({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    });
    return { connected: false as const };
  });
export const startSelfHostedGa4Link = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startGa4LinkSchema)
  .handler(async ({ data, context }) => ({
    url: await createSelfHostedGa4AuthorizationUrl({
      user: { userId: context.userId, userEmail: context.userEmail },
      projectId: context.projectId,
      callbackURL: data.callbackURL,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));
export const triggerGa4Sync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(triggerGa4SyncSchema)
  .handler(async ({ data, context }) =>
    Ga4SyncService.runSync({
      projectId: context.projectId,
      organizationId: context.organizationId,
      syncType: data.syncType,
      startDate: data.startDate,
      endDate: data.endDate,
    }),
  );
export const getGa4SyncStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4SyncStatusSchema)
  .handler(async ({ context }) => {
    const connection = await Ga4Service.getConnection(
      context.projectId,
      context.organizationId,
    );
    if (!connection) {
      return {
        connected: false as const,
        latestSync: null,
        activeSync: null,
        isRunning: false,
        lastFullyCoveredDate: null,
      };
    }
    const [latest, active, lastFullyCoveredDate] = await Promise.all([
      Ga4SyncRepository.getLatestSyncRun(
        context.projectId,
        connection.propertyId,
      ),
      Ga4SyncRepository.getActiveSyncRun(
        context.projectId,
        connection.propertyId,
      ),
      Ga4SyncRepository.getLastFullyCoveredDate(
        context.projectId,
        connection.propertyId,
        [...GA4_GRAINS],
        new Date().toISOString().slice(0, 10),
      ),
    ]);
    return {
      connected: true as const,
      latestSync: latest,
      activeSync: active,
      isRunning: active !== null,
      lastFullyCoveredDate,
    };
  });
export const getPeriodUsers = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4PeriodUsersSchema)
  .handler(async ({ data, context }) =>
    Ga4Service.getPeriodUsers({
      projectId: context.projectId,
      organizationId: context.organizationId,
      startDate: data.startDate,
      endDate: data.endDate,
    }),
  );
export const getAnalyticsOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsOverviewSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getOverview({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsAcquisition = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsAcquisitionSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getAcquisition({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsLandingPages = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsLandingPagesSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getLandingPages({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      limit: data.limit,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsEvents = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsEventsSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getEvents({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      limit: data.limit,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsConversions = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsConversionsSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getConversions({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      limit: data.limit,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
      ...(data.goalId ? { goalId: data.goalId } : {}),
    }),
  );
export const getAnalyticsEcommerce = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsEcommerceSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getEcommerce({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsAudience = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsAudienceSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getAudience({
      projectId: context.projectId,
      organizationId: context.organizationId,
      range: data.range,
      ...(data.channel ? { channel: data.channel } : {}),
      ...(data.device ? { device: data.device } : {}),
      ...(data.country ? { country: data.country } : {}),
    }),
  );
export const getAnalyticsGeo = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsGeoSchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getAnalyticsGeo({
      projectId: context.projectId,
      organizationId: context.organizationId,
      from: data.from,
      to: data.to,
    }),
  );
export const getAnalyticsTechnology = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(analyticsTechnologySchema)
  .handler(async ({ data, context }) =>
    AnalyticsService.getAnalyticsTechnology({
      projectId: context.projectId,
      organizationId: context.organizationId,
      from: data.from,
      to: data.to,
      dimension: data.dimension,
    }),
  );

/**
 * Project-scoped GA4 conversion goals (spec 010, contracts/goals-api.md).
 * Goals are OpenSEO-owned rows — listing needs no GA4 connection; all
 * mutations validate project scope via the shared middleware (P39).
 */
export const createGa4Goal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(createGa4GoalSchema)
  .handler(async ({ data, context }) => ({
    goal: await Ga4GoalService.createGoal({
      projectId: context.projectId,
      organizationId: context.organizationId,
      name: data.name,
      eventName: data.eventName,
      matchKeyEventOnly: data.matchKeyEventOnly,
    }),
  }));
export const listGa4Goals = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listGa4GoalsSchema)
  .handler(async ({ data, context }) => ({
    goals: await Ga4GoalService.listGoals({
      projectId: context.projectId,
      organizationId: context.organizationId,
      includeArchived: data.includeArchived,
    }),
  }));
export const updateGa4Goal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateGa4GoalSchema)
  .handler(async ({ data, context }) => ({
    goal: await Ga4GoalService.updateGoal({
      projectId: context.projectId,
      organizationId: context.organizationId,
      id: data.id,
      ...(data.name !== undefined ? { name: data.name } : {}),
      ...(data.eventName !== undefined ? { eventName: data.eventName } : {}),
      ...(data.matchKeyEventOnly !== undefined
        ? { matchKeyEventOnly: data.matchKeyEventOnly }
        : {}),
    }),
  }));
export const archiveGa4Goal = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(archiveGa4GoalSchema)
  .handler(async ({ data, context }) => ({
    goal: await Ga4GoalService.archiveGoal({
      projectId: context.projectId,
      organizationId: context.organizationId,
      id: data.id,
    }),
  }));
