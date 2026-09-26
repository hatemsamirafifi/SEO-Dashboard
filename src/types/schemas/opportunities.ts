import { z } from "zod";

const opportunityStatusSchema = z.enum([
  "open",
  "in_progress",
  "completed",
  "dismissed",
]);

export const listOpportunitiesSchema = z
  .object({
    projectId: z.string().min(1),
    status: opportunityStatusSchema.optional(),
    type: z.string().min(1).optional(),
  })
  .strict();

export const opportunityByIdSchema = z
  .object({ projectId: z.string().min(1), id: z.string().min(1) })
  .strict();

export const updateOpportunityStatusSchema = z
  .object({
    projectId: z.string().min(1),
    id: z.string().min(1),
    status: opportunityStatusSchema,
    reason: z.string().max(500).optional(),
  })
  .strict();
