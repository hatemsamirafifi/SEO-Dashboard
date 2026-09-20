import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import { Ga4Service } from "@/server/features/ga4/services/Ga4Service";
import { createSelfHostedGa4AuthorizationUrl } from "@/server/features/gsc/selfHostedOAuth";
import { hasSelfHostedGscConfig } from "@/server/features/gsc/oauth-config";
import {
  ga4ProjectSchema,
  setGa4PropertySchema,
  startGa4LinkSchema,
} from "@/types/schemas/ga4";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "./middleware";

export const getGa4GrantStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => ({
    connected: await Ga4Service.userHasGrant(context.userId),
  }));
export const getGa4Connection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => {
    const [connection, currentUserHasGrant, hosted, configured] =
      await Promise.all([
        Ga4Service.getConnection(context.projectId, context.organizationId),
        Ga4Service.userHasGrant(context.userId),
        isHostedServerAuthMode(),
        hasSelfHostedGscConfig(),
      ]);
    return {
      connected: Boolean(connection),
      currentUserHasGrant,
      googleOAuthConfigured: hosted || configured,
      propertyId: connection?.propertyId ?? null,
      propertyDisplayName: connection?.propertyDisplayName ?? null,
      connectedAt: connection?.createdAt ?? null,
    };
  });
export const listGa4Properties = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => ({
    accounts: await Ga4Service.listPropertiesForUser(context.userId),
  }));
export const setGa4Property = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(setGa4PropertySchema)
  .handler(async ({ data, context }) => {
    const connection = await Ga4Service.setProperty({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
      accountId: data.accountId,
      propertyId: data.propertyId,
    });
    return {
      connected: true as const,
      propertyId: connection.propertyId,
      propertyDisplayName: connection.propertyDisplayName,
    };
  });
export const disconnectGa4 = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(ga4ProjectSchema)
  .handler(async ({ context }) => {
    await Ga4Service.disconnect({
      projectId: context.projectId,
      organizationId: context.organizationId,
      userId: context.userId,
    });
    return { connected: false as const };
  });
export const startSelfHostedGa4Link = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(startGa4LinkSchema)
  .handler(async ({ data, context }) => ({
    url: await createSelfHostedGa4AuthorizationUrl({
      user: { userId: context.userId, userEmail: context.userEmail },
      projectId: context.projectId,
      callbackURL: data.callbackURL,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));
