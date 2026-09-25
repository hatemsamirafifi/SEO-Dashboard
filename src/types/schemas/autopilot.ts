import { z } from "zod";

export const startAutopilotRunSchema = z
  .object({
    projectId: z.string().min(1),
    workflowType: z.string().min(1).max(120),
    trigger: z.string().max(40).optional(),
  })
  .strict();

export const autopilotRunByIdSchema = z
  .object({ projectId: z.string().min(1), runId: z.string().min(1) })
  .strict();

export const listAutopilotRunsSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
