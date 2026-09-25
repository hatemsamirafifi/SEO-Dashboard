import { createServerFn } from "@tanstack/react-start";
import { AppError } from "@/server/lib/errors";
import { AutopilotService } from "@/server/features/autopilot/services/AutopilotService";
import {
  autopilotRunByIdSchema,
  listAutopilotRunsSchema,
  startAutopilotRunSchema,
} from "@/types/schemas/autopilot";
import { requireProjectContext } from "./middleware";

/**
 * Autopilot run lifecycle (final-plan §15). The SAM Autopilot tab (Task 17)
 * polls getAutopilotRun; MCP run-starters arrive after the UI is proven.
 */
export const startAutopilotRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startAutopilotRunSchema)
  .handler(async ({ context, data }) =>
    AutopilotService.startAutopilotRun({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      userEmail: context.userEmail,
      workflowType: data.workflowType,
      trigger: data.trigger,
    }),
  );

export const getAutopilotRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(autopilotRunByIdSchema)
  .handler(async ({ context, data }) => {
    const view = await AutopilotService.getAutopilotRun({
      runId: data.runId,
      projectId: context.projectId,
    });
    if (!view) {
      throw new AppError("NOT_FOUND");
    }
    return view;
  });

export const listAutopilotRuns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(listAutopilotRunsSchema)
  .handler(async ({ context }) => {
    const runs = await AutopilotService.listAutopilotRuns({
      projectId: context.projectId,
    });
    return { runs };
  });

export const cancelAutopilotRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(autopilotRunByIdSchema)
  .handler(async ({ context, data }) =>
    AutopilotService.cancelAutopilotRun({
      runId: data.runId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    }),
  );

export const resumeAutopilotRun = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(autopilotRunByIdSchema)
  .handler(async ({ context, data }) =>
    AutopilotService.resumeAutopilotRun({
      runId: data.runId,
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      userEmail: context.userEmail,
    }),
  );
