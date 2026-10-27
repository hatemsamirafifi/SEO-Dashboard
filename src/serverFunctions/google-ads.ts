/* eslint-disable max-lines */
import { createServerFn } from "@tanstack/react-start";
import { getRequest } from "@tanstack/react-start/server";
import { eq } from "drizzle-orm";

/** Deterministic browser-E2E responses: enabled by a build-time env flag or
 *  a request header, mirroring the GA4 analytics fixtures. */
function shouldUseGoogleAdsE2eFixtures() {
  if (import.meta.env.VITE_E2E_GOOGLE_ADS_FIXTURES === "1") return true;
  try {
    return getRequest().headers.get("x-e2e-google-ads-fixture") === "1";
  } catch {
    return false;
  }
}

async function getGoogleAdsE2eFixtures() {
  return import("../../e2e/fixtures/google-ads-fixtures");
}
import { db } from "@/db";
import { user } from "@/db/schema";
import { GoogleAdsService } from "@/server/features/google-ads/services/GoogleAdsService";
import {
  getAdGroups,
  getCampaigns,
  getDevices,
  getKeywords,
  getLandingPages,
  getOverview,
  getSearchTerms,
  getSyncState,
} from "@/server/features/google-ads/services/GoogleAdsAnalyticsService";
import { GoogleAdsSyncService } from "@/server/features/google-ads/services/GoogleAdsSyncService";
import {
  discoverAccessibleCustomers,
  listManagerChildren,
} from "@/server/features/google-ads/services/googleAdsDiscovery";
import { createSelfHostedGoogleAdsAuthorizationUrl } from "@/server/features/gsc/selfHostedOAuth";
import { hasSelfHostedGscConfig } from "@/server/features/gsc/oauth-config";
import { isHostedServerAuthMode } from "@/server/lib/runtime-env";
import { getPublicOrigin } from "@/server/mcp/public-origin";
import type { GoogleAdsWindow } from "@/server/features/google-ads/services/googleAdsAnalyticsMath";
import {
  googleAdsAdGroupBreakdownSchema,
  googleAdsAnalyticsWindowSchema,
  googleAdsCampaignBreakdownSchema,
  googleAdsConnectionTestSchema,
  googleAdsDeviceBreakdownSchema,
  googleAdsDiscoverySchema,
  googleAdsDisconnectSchema,
  googleAdsKeywordBreakdownSchema,
  googleAdsLandingPageBreakdownSchema,
  googleAdsLinkSchema,
  googleAdsManagerChildrenSchema,
  googleAdsProjectSchema,
  googleAdsSearchTermBreakdownSchema,
  googleAdsSelectCustomerSchema,
  googleAdsSyncTriggerSchema,
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
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsConnectionStatus();
    }

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

// ---------------------------------------------------------------------------
// Stored analytics + durable sync (server functions)
// ---------------------------------------------------------------------------

function defaultGoogleAdsWindow() {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { startDate, endDate };
}

function googleAdsBreakdownWindow(
  startDate?: string,
  endDate?: string,
): GoogleAdsWindow {
  return startDate !== undefined && endDate !== undefined
    ? { startDate, endDate }
    : defaultGoogleAdsWindow();
}

function googleAdsAnalyticsScope(
  context: { projectId: string; organizationId: string },
  customerId: string,
) {
  return {
    projectId: context.projectId,
    organizationId: context.organizationId,
    customerId,
  };
}

/** Triggers a manual sync. An explicit window is optional; the sync service
 *  resolves the default window from the published-unit ledger. */
export const triggerGoogleAdsSync = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsSyncTriggerSchema)
  .handler(async ({ data, context }) => {
    const connection = await GoogleAdsService.getConnection(
      context.projectId,
      context.organizationId,
    );
    if (!connection) {
      return { connected: false as const };
    }
    return GoogleAdsSyncService.runSync({
      projectId: context.projectId,
      organizationId: context.organizationId,
      mode: "manual",
      ...(data.startDate !== undefined && data.endDate !== undefined
        ? { startDate: data.startDate, endDate: data.endDate }
        : {}),
    });
  });

export const getGoogleAdsSyncStatus = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsProjectSchema)
  .handler(async ({ context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsSyncStatus();
    }

    const connection = await GoogleAdsService.getConnection(
      context.projectId,
      context.organizationId,
    );
    if (!connection) {
      return { connected: false as const, syncState: null };
    }
    return {
      connected: true as const,
      syncState: await getSyncState({
        projectId: context.projectId,
        organizationId: context.organizationId,
        customerId: connection.customerId,
      }),
    };
  });

export const getGoogleAdsOverview = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsAnalyticsWindowSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsOverview();
    }
    const connection = await GoogleAdsService.getConnection(
      context.projectId,
      context.organizationId,
    );
    if (!connection) {
      return { connected: false as const, overview: null };
    }
    const window =
      data.startDate !== undefined && data.endDate !== undefined
        ? { startDate: data.startDate, endDate: data.endDate }
        : defaultGoogleAdsWindow();
    return {
      connected: true as const,
      // The preceding equal-length comparison is always computed: the UI
      // overview surfaces either the deltas or an explicit gate reason.
      overview: await getOverview({
        scope: googleAdsAnalyticsScope(context, connection.customerId),
        window,
        compare: true,
      }),
    };
  });

export const getGoogleAdsCampaigns = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsCampaignBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsCampaigns();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    return {
      connected: true as const,
      breakdown: await getCampaigns({
        scope: googleAdsAnalyticsScope(context, connection.customerId),
        window,
      }),
    };
  });

export const getGoogleAdsAdGroups = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsAdGroupBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsAdGroups();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    return {
      connected: true as const,
      breakdown: await getAdGroups({
        scope: googleAdsAnalyticsScope(context, connection.customerId),
        window,
      }),
    };
  });

export const getGoogleAdsKeywords = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsKeywordBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsKeywords();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    return {
      connected: true as const,
      breakdown: await getKeywords({
        scope: googleAdsAnalyticsScope(context, connection.customerId),
        window,
      }),
    };
  });

export const getGoogleAdsSearchTerms = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsSearchTermBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsSearchTerms();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    const options: { searchText?: string; searchTextLike?: string } = {};
    if (data.searchText !== undefined) options.searchText = data.searchText;
    if (data.searchTextLike !== undefined) {
      options.searchTextLike = data.searchTextLike;
    }
    return {
      connected: true as const,
      breakdown: await getSearchTerms(
        {
          scope: googleAdsAnalyticsScope(context, connection.customerId),
          window,
        },
        options,
      ),
    };
  });

export const getGoogleAdsDevices = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsDeviceBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsDevices();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    return {
      connected: true as const,
      breakdown: await getDevices(
        {
          scope: googleAdsAnalyticsScope(context, connection.customerId),
          window,
        },
        data.campaignResourceId !== undefined
          ? { campaignResourceId: data.campaignResourceId }
          : {},
      ),
    };
  });

export const getGoogleAdsLandingPages = createServerFn({ method: "POST" })
  .middleware(requireProjectContext)
  .validator(googleAdsLandingPageBreakdownSchema)
  .handler(async ({ data, context }) => {
    if (shouldUseGoogleAdsE2eFixtures()) {
      const fixtures = await getGoogleAdsE2eFixtures();
      return fixtures.getFixtureGoogleAdsLandingPages();
    }
    const [connection, window] = await Promise.all([
      GoogleAdsService.getConnection(context.projectId, context.organizationId),
      googleAdsBreakdownWindow(data.startDate, data.endDate),
    ]);
    if (!connection) {
      return { connected: false as const, breakdown: null };
    }
    return {
      connected: true as const,
      breakdown: await getLandingPages(
        {
          scope: googleAdsAnalyticsScope(context, connection.customerId),
          window,
        },
        data.campaignResourceId !== undefined
          ? { campaignResourceId: data.campaignResourceId }
          : {},
      ),
    };
  });
