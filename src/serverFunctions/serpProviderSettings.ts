import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireAuthenticatedContext } from "@/serverFunctions/middleware";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { AppError } from "@/server/lib/errors";
import {
  getSerpProviderSettingsView,
  removeSerpProviderSettings,
  saveSerpProviderSettings,
  testSerpProviderConnection,
  type SerpProviderConnectionTestResult,
  type SerpProviderSettingsView,
} from "@/server/features/settings/services/SerpProviderSettingsService";

export type { SerpProviderConnectionTestResult, SerpProviderSettingsView };

const providerSchema = z.enum(["serper", "zenserp"]);
const baseSchema = z.object({
  provider: providerSchema,
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
  if (!project)
    throw new AppError("FORBIDDEN", "Project not found in this organization.");
}

export const getSerpProviderSettings = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema)
  .handler(async ({ context, data }): Promise<SerpProviderSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return getSerpProviderSettingsView({
      provider: data.provider,
      organizationId: context.organizationId,
      projectId: data.projectId,
    });
  });

export const saveSerpProviderSettingsFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(
    baseSchema.extend({
      patch: z.object({
        apiKey: z.string().max(500).optional(),
        enabled: z.boolean().optional(),
        circuitBreakerEnabled: z.boolean().optional(),
        priority: z.number().int().min(1).max(3).optional(),
      }),
    }),
  )
  .handler(async ({ context, data }): Promise<SerpProviderSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return saveSerpProviderSettings({
      provider: data.provider,
      organizationId: context.organizationId,
      projectId: data.projectId,
      patch: data.patch,
    });
  });

export const removeSerpProviderSettingsFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema)
  .handler(async ({ context, data }): Promise<SerpProviderSettingsView> => {
    await assertProject(data.projectId, context.organizationId);
    return removeSerpProviderSettings({
      provider: data.provider,
      organizationId: context.organizationId,
      projectId: data.projectId,
    });
  });

export const testSerpProviderConnectionFn = createServerFn({ method: "POST" })
  .middleware(requireAuthenticatedContext)
  .validator(baseSchema.extend({ apiKey: z.string().max(500).optional() }))
  .handler(
    async ({ context, data }): Promise<SerpProviderConnectionTestResult> => {
      await assertProject(data.projectId, context.organizationId);
      return testSerpProviderConnection({
        provider: data.provider,
        organizationId: context.organizationId,
        projectId: data.projectId,
        apiKey: data.apiKey,
      });
    },
  );
