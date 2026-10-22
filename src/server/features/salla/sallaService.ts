import { AppError } from "@/server/lib/errors";
import {
  SallaConnectionRepository,
  type SallaConnectionView,
} from "./repositories/SallaConnectionRepository";
import {
  createSallaAuthorizationUrl,
  handleSallaOAuthCallback,
  refreshSallaToken,
  type exchangeSallaAuthorizationCode,
  type SallaCallbackOutcome,
  type SallaStoreIdentity,
} from "./sallaOAuth";
import {
  encryptSallaTokenEnvelope,
  tokenEnvelopeFromGrant,
  type SallaTokenEnvelope,
} from "./sallaTokens";
import {
  fetchSallaList,
  SALLA_CATEGORIES_PATH,
  SALLA_PRODUCTS_PATH,
  type SallaCatalogRow,
} from "./sallaApi";
import {
  isSallaConnectorConfigured,
  resolveSallaConnectorConfig,
  type SallaConnectorConfig,
} from "./sallaConfig";

// Salla connector service — the §1.5 boundary:
// - Public-crawler SEO data and this API connector are strictly separate.
// - The connector is feature-flagged; with no credentials nothing here
//   performs any network call.
// - API-derived catalog rows are informational metadata only. They are never
//   proof that a public product URL is crawlable/indexable/SEO-correct; the
//   audit never reads them.
// - Tokens are sealed at rest with a dedicated deployment secret; they never
//   appear in return values, logs, or traces.

/**
 * A catalog row as the Merchant API returns it: a JSON object whose fields
 * the connector never interprets (§1.5). The row type is validated at the
 * API boundary, so the service hands the rows on as they were received.
 */
export type { SallaCatalogRow };

export type SallaConnectorStatus = {
  configured: boolean;
  connected: boolean;
  store: {
    merchantId: string;
    merchantName: string | null;
    storeId: string;
    storeDomain: string | null;
    storeUrl: string | null;
    storeStatus: string | null;
  } | null;
};

export type AuthorizedSallaGrantInput = {
  owner: { userId: string; organizationId: string; projectId: string };
  code: string;
  grant: Awaited<ReturnType<typeof exchangeSallaAuthorizationCode>>;
  identity: SallaStoreIdentity;
};

async function assertConfigured(): Promise<SallaConnectorConfig> {
  const config = await resolveSallaConnectorConfig();
  if (!config) {
    throw new AppError(
      "AUTH_CONFIG_MISSING",
      "Salla connector is not enabled. Set SALLA_CONNECTOR_ENABLED, SALLA_CLIENT_ID, SALLA_CLIENT_SECRET, and SALLA_TOKEN_ENCRYPTION_KEY.",
    );
  }
  return config;
}

export const SallaService = {
  async status(projectId: string): Promise<SallaConnectorStatus> {
    const configured = await isSallaConnectorConfigured();
    const connection =
      await SallaConnectionRepository.getByProjectId(projectId);
    return {
      configured,
      connected: Boolean(connection),
      store: connection
        ? {
            merchantId: connection.merchantId,
            merchantName: connection.merchantName,
            storeId: connection.storeId,
            storeDomain: connection.storeDomain,
            storeUrl: connection.storeUrl,
            storeStatus: connection.storeStatus,
          }
        : null,
    };
  },

  async buildAuthorizeUrl(input: {
    user: { userId: string };
    projectId: string;
    callbackURL: string;
    publicOrigin: string;
  }): Promise<string> {
    const config = await assertConfigured();
    return createSallaAuthorizationUrl({
      owner: { userId: input.user.userId, projectId: input.projectId },
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      callbackURL: input.callbackURL,
      publicOrigin: input.publicOrigin,
    });
  },

  async completeCallback(input: {
    request: Request;
    user: { userId: string };
    organizationId: string;
    publicOrigin: string;
  }): Promise<{
    outcome: SallaCallbackOutcome;
    redirectTo: string;
    connection: SallaConnectionView | null;
  }> {
    const config = await assertConfigured();
    const { outcome, redirectTo } = await handleSallaOAuthCallback({
      request: input.request,
      user: { userId: input.user.userId },
      config,
      publicOrigin: input.publicOrigin,
    });

    if (outcome.kind !== "authorized") {
      return { outcome, redirectTo, connection: null };
    }

    // Seal the token pair before anything else; if the dedicated secret is
    // missing we reject the connection instead of ever storing plaintext.
    const envelope = tokenEnvelopeFromGrant(outcome.grant);
    const tokenCiphertext = await encryptSallaTokenEnvelope(envelope);
    if (!tokenCiphertext) {
      throw new AppError(
        "AUTH_CONFIG_MISSING",
        "SALLA_TOKEN_ENCRYPTION_KEY is not configured; refusing to store Salla tokens unsealed.",
      );
    }

    const connection = await SallaConnectionRepository.upsert({
      projectId: outcome.state.projectId,
      organizationId: input.organizationId,
      connectedByUserId: input.user.userId,
      identity: outcome.identity,
      tokenCiphertext,
      tokenExpiresAt: new Date(envelope.expiresAt).toISOString(),
      scope: envelope.scope,
    });

    return { outcome, redirectTo, connection };
  },

  async disconnect(projectId: string): Promise<void> {
    await SallaConnectionRepository.deleteByProjectId(projectId);
  },

  /**
   * Read the sealed envelope, refreshing with the single-use refresh token
   * when the access token is expired — the rotated refresh token is re-sealed
   * in place so a stored grant survives 14-day expiry windows. Returns null
   * when the grant is unreadable (operator must re-authorize).
   */
  async resolveAccessToken(
    projectId: string,
  ): Promise<(SallaTokenEnvelope & { connectedByUserId: string }) | null> {
    const grant = await SallaConnectionRepository.getTokenEnvelope(projectId);
    if (!grant) return null;
    if (grant.envelope.expiresAt > Date.now()) {
      return { ...grant.envelope, connectedByUserId: grant.connectedByUserId };
    }
    if (!grant.envelope.refreshToken) return null;

    const config = await assertConfigured();
    const refreshed = await refreshSallaToken({
      refreshToken: grant.envelope.refreshToken,
      config,
    });
    const rotated = tokenEnvelopeFromGrant(refreshed);
    const tokenCiphertext = await encryptSallaTokenEnvelope(rotated);
    if (!tokenCiphertext) {
      throw new AppError(
        "AUTH_CONFIG_MISSING",
        "SALLA_TOKEN_ENCRYPTION_KEY is not configured; refusing to rotate Salla tokens.",
      );
    }
    await SallaConnectionRepository.updateTokenEnvelope({
      projectId,
      tokenCiphertext,
      tokenExpiresAt: new Date(rotated.expiresAt).toISOString(),
    });
    return {
      ...rotated,
      connectedByUserId: grant.connectedByUserId,
    };
  },

  /**
   * Catalog retrieval for diagnostics/UI. Read-only scopes, hard page cap;
   * API rows carry no crawling or indexability semantics (§1.5).
   */
  async listCatalog(input: {
    projectId: string;
    resource: "products" | "categories";
    startPage?: number;
    maxPages?: number;
  }): Promise<{
    connection: SallaConnectionView;
    rows: SallaCatalogRow[];
    pagesFetched: number;
    truncatedByCap: boolean;
    nextPage: number | null;
  }> {
    const accessToken = await SallaService.resolveAccessToken(input.projectId);
    if (!accessToken) {
      throw new AppError(
        "UNAUTHENTICATED",
        "No usable Salla grant for this project; re-authorize the store.",
      );
    }
    const connection = await SallaConnectionRepository.getByProjectId(
      input.projectId,
    );
    if (!connection) {
      throw new AppError("NOT_FOUND", "No Salla connection for this project.");
    }
    const result = await fetchSallaList({
      path:
        input.resource === "products"
          ? SALLA_PRODUCTS_PATH
          : SALLA_CATEGORIES_PATH,
      accessToken: accessToken.accessToken,
      startPage: input.startPage,
      maxPages: input.maxPages,
    });
    return {
      connection,
      rows: result.rows,
      pagesFetched: result.pagesFetched,
      truncatedByCap: result.truncatedByCap,
      nextPage: result.nextPage,
    };
  },
};
