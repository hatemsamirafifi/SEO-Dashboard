import { z } from "zod";
import { PRIORITIES } from "@/shared/intelligence";

const opportunityStatusSchema = z.enum([
  "open",
  "in_progress",
  "completed",
  "dismissed",
]);

// Stored priority values use the shared matrix bands (Critical..Low).
const opportunityPrioritySchema = z.enum(PRIORITIES);

export const listOpportunitiesSchema = z
  .object({
    projectId: z.string().min(1),
    status: opportunityStatusSchema.optional(),
    type: z.string().min(1).optional(),
    // Spec 010 (contracts/opportunities-filters.md): server-side composable
    // filters. Single-value dimensions narrow; arrays are OR-within-dimension
    // (empty array = "all"); all dimensions AND-compose. `source` matches
    // opportunities whose stored sources array contains the value exactly
    // (never substring).
    page: z.string().min(1).optional(),
    keyword: z.string().min(1).optional(),
    source: z.string().min(1).optional(),
    priority: opportunityPrioritySchema.optional(),
    statuses: z.array(opportunityStatusSchema).optional(),
    types: z.array(z.string().min(1)).optional(),
    priorities: z.array(opportunityPrioritySchema).optional(),
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
