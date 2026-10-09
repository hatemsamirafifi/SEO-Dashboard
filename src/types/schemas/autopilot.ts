import { z } from "zod";
import { AUTOPILOT_WORKFLOW_TYPES } from "@/shared/autopilot";

// Spec 013: the workflow allowlist is enforced at the trust boundary —
// workflowType is an enum over the shared const, never a free string.
export const startAutopilotRunSchema = z
  .object({
    projectId: z.string().min(1),
    workflowType: z.enum(AUTOPILOT_WORKFLOW_TYPES),
    trigger: z.string().max(40).optional(),
  })
  .strict();

export const autopilotRunByIdSchema = z
  .object({ projectId: z.string().min(1), runId: z.string().min(1) })
  .strict();

export const listAutopilotRunsSchema = z
  .object({ projectId: z.string().min(1) })
  .strict();
