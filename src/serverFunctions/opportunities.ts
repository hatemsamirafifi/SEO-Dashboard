import { createServerFn } from "@tanstack/react-start";
import { AppError } from "@/server/lib/errors";
import {
  OpportunityService,
  recentWindowSince,
} from "@/server/features/intelligence/services/OpportunityService";
import { getNextActions as getNextActionsSnapshot } from "@/server/features/intelligence/services/nextActions";
import {
  getNextActionsSchema,
  listOpportunitiesSchema,
  opportunityByIdSchema,
  updateOpportunityStatusSchema,
  updateOpportunityTriageSchema,
} from "@/types/schemas/opportunities";
import { requireProjectContext } from "./middleware";

/**
 * User-facing opportunity reads, status lifecycle, and triage (final-plan
 * §15 + spec 021). Detection/materialization live in the intelligence
 * functions; these endpoints never trigger scans.
 */
export const listOpportunities = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listOpportunitiesSchema)
  .handler(async ({ context, data }) => {
    const rows = await OpportunityService.listOpportunities({
      projectId: context.projectId,
      status: data.status,
      type: data.type,
      page: data.page,
      keyword: data.keyword,
      source: data.source,
      priority: data.priority,
      statuses: data.statuses,
      types: data.types,
      priorities: data.priorities,
      recentDays: data.recentDays,
      reopened: data.reopened,
    });
    return {
      opportunities: rows,
      // Echo the applied recency bound so the UI can display it honestly.
      recentSince: data.recentDays
        ? recentWindowSince(data.recentDays)
        : undefined,
    };
  });

export const getOpportunity = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(opportunityByIdSchema)
  .handler(async ({ context, data }) => {
    const result = await OpportunityService.getOpportunity({
      id: data.id,
      projectId: context.projectId,
    });
    if (!result) {
      throw new AppError("NOT_FOUND");
    }
    return result;
  });

export const updateOpportunityStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateOpportunityStatusSchema)
  .handler(async ({ context, data }) => {
    const opportunity = await OpportunityService.updateOpportunityStatus({
      id: data.id,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      status: data.status,
      reason: data.reason,
    });
    return { opportunity };
  });

// Spec 021: triage (assignee/effort) rides the existing update path —
// lifecycle, scores, and identity columns are untouchable here.
export const updateOpportunityTriage = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(updateOpportunityTriageSchema)
  .handler(async ({ context, data }) => {
    const opportunity = await OpportunityService.updateOpportunityTriage({
      id: data.id,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      assignee: data.assignee,
      effort: data.effort,
    });
    return { opportunity };
  });

// Spec 021: the dashboard action-center snapshot (four views, honest counts).
export const getNextActions = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(getNextActionsSchema)
  .handler(async ({ context, data }) => {
    const snapshot = await getNextActionsSnapshot({
      projectId: context.projectId,
      recentDays: data.recentDays,
    });
    return snapshot;
  });
