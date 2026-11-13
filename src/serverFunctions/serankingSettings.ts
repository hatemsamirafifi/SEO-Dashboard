import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import {
  getSeRankingSettingsView,
  removeSeRankingSettings,
  saveSeRankingSettings,
  testSeRankingConnection,
  type SeRankingConnectionTestResult,
  type SeRankingSettingsView,
} from "@/server/features/settings/services/SeRankingSettingsService";

export type { SeRankingConnectionTestResult, SeRankingSettingsView };

const baseSchema = z.object({
  projectId: z.string().min(1).optional(),
});

async function assertProject(
  projectId: string | undefined,
  organizationId: string,
) {
  if (!projectId) return;
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    organizationId,
  );
  if (!project) {
    throw new AppError("FORBIDDEN", "Project not found in this organization.");
  }
}

export const getSeRankingSettings = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema)
  .handler(async ({ context, data }): Promise<SeRankingSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return getSeRankingSettingsView({
      organizationId: context.organizationId,
      projectId: data.projectId,
    });
  });

export const saveSeRankingSettingsFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(
    baseSchema.extend({
      patch: z.object({
        apiKey: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        circuitBreakerEnabled: z.boolean().optional(),
        maxRetries: z.number().int().min(0).max(5).optional(),
        priority: z.number().int().min(1).max(5).optional(),
      }),
    }),
  )
  .handler(async ({ context, data }): Promise<SeRankingSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return saveSeRankingSettings({
      organizationId: context.organizationId,
      projectId: data.projectId,
      patch: data.patch,
    });
  });

export const removeSeRankingSettingsFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema)
  .handler(async ({ context, data }): Promise<SeRankingSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return removeSeRankingSettings({
      organizationId: context.organizationId,
      projectId: data.projectId,
    });
  });

export const testSeRankingConnectionFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema.extend({ apiKey: z.string().max(500).optional() }))
  .handler(
    async ({ context, data }): Promise<SeRankingConnectionTestResult> => {
      await assertProject(data.projectId, context.organizationId);
      return testSeRankingConnection({
        organizationId: context.organizationId,
        projectId: data.projectId,
        apiKey: data.apiKey,
      });
    },
  );
