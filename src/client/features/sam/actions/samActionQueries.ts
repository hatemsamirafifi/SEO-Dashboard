import { queryOptions } from "@tanstack/react-query";
import { queryClient } from "@/client/tanstack-db";
import {
  listSeoActionPlans,
  getSeoActionPlan,
  listSeoActionItems,
  getSeoActionEvents,
  getSeoActionEvidence,
} from "@/serverFunctions/seoActions";
import type { SeoActionStatus } from "@/shared/samSeoAnalyst";

export const seoActionPlansQueryOptions = (projectId: string) =>
  queryOptions({
    queryKey: ["seoActionPlans", projectId],
    queryFn: () => listSeoActionPlans({ data: { projectId } }),
  });

export const seoActionPlanQueryOptions = (projectId: string, planId?: string) =>
  queryOptions({
    queryKey: ["seoActionPlan", projectId, planId ?? "default"],
    queryFn: () => getSeoActionPlan({ data: { projectId, planId } }),
  });

export const seoActionItemsQueryOptions = (
  projectId: string,
  filter?: { status?: SeoActionStatus; category?: string; priority?: string },
) =>
  queryOptions({
    queryKey: ["seoActionItems", projectId, filter],
    queryFn: () => listSeoActionItems({ data: { projectId, ...filter } }),
  });

export const seoActionEventsQueryOptions = (
  projectId: string,
  itemId: string,
) =>
  queryOptions({
    queryKey: ["seoActionEvents", projectId, itemId],
    queryFn: () => getSeoActionEvents({ data: { projectId, itemId } }),
  });

export const seoActionEvidenceQueryOptions = (
  projectId: string,
  itemId: string,
) =>
  queryOptions({
    queryKey: ["seoActionEvidence", projectId, itemId],
    queryFn: () => getSeoActionEvidence({ data: { projectId, itemId } }),
  });

export function invalidateSeoActions(projectId: string) {
  void queryClient.invalidateQueries({
    queryKey: ["seoActionPlans", projectId],
  });
  void queryClient.invalidateQueries({ queryKey: ["seoActionPlan", projectId] });
  void queryClient.invalidateQueries({
    queryKey: ["seoActionItems", projectId],
  });
  void queryClient.invalidateQueries({
    queryKey: ["seoActionEvents", projectId],
  });
  void queryClient.invalidateQueries({
    queryKey: ["seoActionEvidence", projectId],
  });
}
