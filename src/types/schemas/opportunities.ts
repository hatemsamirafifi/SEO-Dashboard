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

// Spec 021 triage tiers. Absence is null — never an "unknown" placeholder.
const opportunityEffortSchema = z.enum(["small", "medium", "large"]);

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
    // Spec 021 (next actions): recency narrows to rows whose
    // lastDetectedAt falls inside the inclusive day window (long-lived items
    // that keep being confirmed stay visible); reopened narrows to rows with
    // a stored recurrence chain — never a recomputed heuristic.
    recentDays: z.number().int().min(1).max(365).optional(),
    reopened: z.boolean().optional(),
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

// Spec 021: triage fields are set independently of the lifecycle — a change
// never moves status, scores, or identity. `null` clears a field; omitting a
// field leaves it untouched.
export const updateOpportunityTriageSchema = z
  .object({
    projectId: z.string().min(1),
    id: z.string().min(1),
    assignee: z.string().min(1).max(120).nullable().optional(),
    effort: opportunityEffortSchema.nullable().optional(),
  })
  .strict();

export const getNextActionsSchema = z
  .object({
    projectId: z.string().min(1),
    // Overrides the recent view's day window (inclusive lower bound on
    // firstDetectedAt); defaults to the service's reasoned prior.
    recentDays: z.number().int().min(1).max(365).optional(),
  })
  .strict();
