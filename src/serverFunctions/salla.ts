import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { z } from "zod";
import { SallaService } from "@/server/features/salla/sallaService";
import { isSallaConnectorConfigured } from "@/server/features/salla/sallaConfig";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { requireProjectContext } from "@/serverFunctions/middleware";

const projectScopedSchema = z.object({ projectId: z.string().min(1) });
const startAuthorizeSchema = projectScopedSchema.extend({
  callbackURL: z.string().min(1),
});

// Status is safe to read without the connector being configured: the UI uses
// it to render "not available" instead of guessing.
export const getSallaConnection = createServerFn({ method: "GET" })
  .middleware(requireProjectContext)
  .handler(async ({ context }) => {
    const [status, configured] = await Promise.all([
      SallaService.status(context.projectId),
      isSallaConnectorConfigured(),
    ]);
    return {
      enabled: configured && status.configured,
      connected: status.connected,
      store: status.store,
    };
  });

export const startSallaAuthorize = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startAuthorizeSchema)
  .handler(async ({ data, context }) => {
    const publicOrigin = getPublicOrigin(getRequest());
    const url = await SallaService.buildAuthorizeUrl({
      user: { userId: context.userId },
      projectId: context.projectId,
      callbackURL: data.callbackURL,
      publicOrigin,
    });
    return { url };
  });

export const disconnectSalla = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(projectScopedSchema)
  .handler(async ({ context }) => {
    await SallaService.disconnect(context.projectId);
    return { connected: false as const };
  });

export const listSallaCatalog = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(
    projectScopedSchema.extend({
      resource: z.enum(["products", "categories"]),
      startPage: z.number().int().positive().optional(),
      maxPages: z.number().int().positive().max(50).optional(),
    }),
  )
  .handler(async ({ data, context }) => {
    const result = await SallaService.listCatalog({
      projectId: context.projectId,
      resource: data.resource,
      startPage: data.startPage,
      maxPages: data.maxPages,
    });
    return {
      connection: result.connection,
      rows: result.rows,
      pagesFetched: result.pagesFetched,
      truncatedByCap: result.truncatedByCap,
      nextPage: result.nextPage,
    };
  });
