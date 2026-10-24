import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";
import { db } from "@/db";
import { user } from "@/db/schema";
import { GoogleAdsService } from "@/server/features/google-ads/services/GoogleAdsService";
import {
  discoverAccessibleCustomers,
  listManagerChildren,
} from "@/server/features/google-ads/services/googleAdsDiscovery";
import { createSelfHostedGoogleAdsAuthorizationUrl } from "@/server/features/gsc/selfHostedOAuth";
import { hasSelfHostedGscConfig } from "@/server/features/gsc/oauth-config";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import {
  googleAdsConnectionTestSchema,
  googleAdsDiscoverySchema,
  googleAdsDisconnectSchema,
  googleAdsLinkSchema,
  googleAdsManagerChildrenSchema,
  googleAdsProjectSchema,
  googleAdsSelectCustomerSchema,
} from "@/types/schemas/google-ads";
import {
  requireAuthenticatedContext,
  requireProjectContext,
} from "./middleware";

/* Google Ads account foundation. Every project action reads the project and
 * organization from the authenticated context — never from the payload — and
 * validates its input with Zod. Only the explicit remote actions touch the
 * Ads API; the status reads stay database-only. */

/** The scope a Google Ads action runs in. The project, the organization and
 *  the user always come from the authenticated context; a payload can never
 *  widen or move that scope. */
export function googleAdsProjectScope(context: {
  projectId: string;
  organizationId: string;
  userId: string;
}) {
  return {
    projectId: context.projectId,
    organizationId: context.organizationId,
    userId: context.userId,
  };
}

export const getGoogleAdsGrantStatus = createServerFn({ method: "GET" })
  .middleware(requireAuthenticatedContext)
  .handler(async ({ context }) => ({
    hasGrant: await GoogleAdsService.userHasGrant(context.userId),
  }));

export const getGoogleAdsConnectionStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsProjectSchema)
  .handler(async ({ context }) => {
    const scope = googleAdsProjectScope(context);
    const [connection, currentUserHasGrant, hosted, configured] =
      await Promise.all([
        GoogleAdsService.getConnection(scope.projectId, scope.organizationId),
        GoogleAdsService.userHasGrant(scope.userId),
        isHostedServerAuthMode(),
        hasSelfHostedGscConfig(),
      ]);
    let connectedByEmail: string | null = null;
    if (connection?.connectedByUserId) {
      if (connection.connectedByUserId === scope.userId) {
        connectedByEmail = context.userEmail;
      } else {
        const [connector] = await db
          .select({ email: user.email })
          .from(user)
          .where(eq(user.id, connection.connectedByUserId))
          .limit(1);
        connectedByEmail = connector?.email ?? null;
      }
    }

    return {
      connected: Boolean(connection),
      currentUserHasGrant,
      // Hosted mode connects through the registered Better Auth provider; the
      // self-hosted mode needs the Google OAuth client and a valid secret.
      googleOAuthConfigured: hosted || configured,
      customerId: connection?.customerId ?? null,
      customerDisplayName: connection?.customerDisplayName ?? null,
      loginCustomerId: connection?.loginCustomerId ?? null,
      currencyCode: connection?.currencyCode ?? null,
      timeZone: connection?.timeZone ?? null,
      isTestAccount: connection?.isTestAccount ?? false,
      grantAccountId: connection?.grantAccountId ?? null,
      connectedAt: connection?.createdAt ?? null,
      connectedByEmail,
    };
  });

export const discoverGoogleAdsCustomers = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsDiscoverySchema)
  .handler(async ({ data, context }) =>
    discoverAccessibleCustomers({
      userId: context.userId,
      ...(data.grantAccountId ? { grantAccountId: data.grantAccountId } : {}),
    }),
  );

export const listGoogleAdsManagerChildren = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsManagerChildrenSchema)
  .handler(async ({ data, context }) =>
    listManagerChildren({
      userId: context.userId,
      grantAccountId: data.grantAccountId,
      managerId: data.managerId,
    }),
  );

export const selectGoogleAdsCustomer = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsSelectCustomerSchema)
  .handler(async ({ data, context }) => {
    const connection = await GoogleAdsService.selectCustomer({
      ...googleAdsProjectScope(context),
      grantAccountId: data.grantAccountId,
      customerId: data.customerId,
      loginCustomerId: data.loginCustomerId ?? null,
    });
    return {
      connected: true as const,
      customerId: connection.customerId,
      customerDisplayName: connection.customerDisplayName,
      loginCustomerId: connection.loginCustomerId,
      currencyCode: connection.currencyCode,
      timeZone: connection.timeZone,
      isTestAccount: connection.isTestAccount,
    };
  });

export const testGoogleAdsConnection = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsConnectionTestSchema)
  .handler(async ({ context }) =>
    GoogleAdsService.testConnection(googleAdsProjectScope(context)),
  );

export const disconnectGoogleAds = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsDisconnectSchema)
  .handler(async ({ context }) => {
    await GoogleAdsService.disconnect(googleAdsProjectScope(context));
    return { connected: false as const };
  });

/** Starts the self-hosted Google Ads OAuth flow. The return path is built
 *  here from the trusted project id, so a client can never redirect the
 *  callback to another project or another origin. */
export const startSelfHostedGoogleAdsLink = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsLinkSchema)
  .handler(async ({ context }) => ({
    url: await createSelfHostedGoogleAdsAuthorizationUrl({
      user: { userId: context.userId, userEmail: context.userEmail },
      projectId: context.projectId,
      callbackURL: `/p/${context.projectId}/settings`,
      publicOrigin: getPublicOrigin(getRequest()),
    }),
  }));
