import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireProjectContext } from "@/serverFunctions/middleware";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";
import { getProviderFeatureFlags } from "@/server/lib/seo-data/config";

export const getSeoApiKeyStatus = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .validator(z.object({ projectId: z.string().min(1) }))
  .handler(async ({ context }) => {
    const config = await resolveEffectiveDataforseoConfig({
      organizationId: context.organizationId,
      projectId: context.projectId,
    });
    const { dataforseoEnabled } = await getProviderFeatureFlags();
    return {
      configured: config.configured,
      enabled: dataforseoEnabled && config.enabled,
    };
  });
