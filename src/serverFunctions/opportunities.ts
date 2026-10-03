import { createServerFn } from "@tanstack/react-start";
import { AppError } from "@/server/lib/errors";
import { OpportunityService } from "@/server/features/intelligence/services/OpportunityService";
import {
  listOpportunitiesSchema,
  opportunityByIdSchema,
  updateOpportunityStatusSchema,
} from "@/types/schemas/opportunities";
import { requireProjectContext } from "./middleware";

/**
 * User-facing opportunity reads and status lifecycle (final-plan §15).
 * Detection/materialization live in the intelligence functions; these
 * endpoints never trigger scans.
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
    });
    return { opportunities: rows };
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
