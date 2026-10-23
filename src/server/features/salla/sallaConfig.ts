import { getOptionalEnvValue } from "@/server/lib/runtime-env";

// Salla OAuth connector configuration (§1.5: feature-flagged, disabled by
// default until valid app credentials + a dedicated seal secret exist).
//
// Contracts verified against the official docs (docs.salla.dev "Authorization",
// Aug 2026 + OpenAPI spec):
// - Authorize:  GET https://accounts.salla.sa/oauth2/auth
// - Token:      POST https://accounts.salla.sa/oauth2/token (form-urlencoded)
// - User info:  GET  https://accounts.salla.sa/oauth2/user/info
// - Merchant API base: https://api.salla.dev/admin/v2
// - Scopes are space-separated at authorize time; refresh tokens require
//   `offline_access` and are single-use (each refresh rotates the pair).

export const SALLA_AUTHORIZE_URL = "https://accounts.salla.sa/oauth2/auth";
export const SALLA_TOKEN_URL = "https://accounts.salla.sa/oauth2/token";
export const SALLA_USER_INFO_URL = "https://accounts.salla.sa/oauth2/user/info";
export const SALLA_API_BASE_URL = "https://api.salla.dev/admin/v2";

export const SALLA_OAUTH_PROVIDER_ID = "salla-merchant";
export const SALLA_OAUTH_STATE_IDENTIFIER = "salla-oauth-state";

// Least privilege: read-only catalog scopes + the refresh-token scope. Never
// request read_write flavors; the connector only reads product/category data.
export const SALLA_OAUTH_SCOPES = [
  "products.read",
  "categories.read",
  "offline_access",
] as const;

export const SALLA_CALLBACK_PATH = "/api/salla/oauth/callback";

export type SallaConnectorConfig = {
  clientId: string;
  clientSecret: string;
};

/**
 * The connector is enabled only when the operator intentionally turned the flag
 * on AND supplied app credentials from Salla Partners. Every part is optional,
 * so a self-hosted deployment without Salla never gains network behavior.
 * An explicit `SALLA_CONNECTOR_ENABLED=false` overrides a present env.
 */
export async function resolveSallaConnectorConfig(): Promise<SallaConnectorConfig | null> {
  const enabled = await getOptionalEnvValue("SALLA_CONNECTOR_ENABLED");
  const clientId = await getOptionalEnvValue("SALLA_CLIENT_ID");
  const clientSecret = await getOptionalEnvValue("SALLA_CLIENT_SECRET");
  if (!clientId || !clientSecret) return null;
  if (enabled === undefined) return null;
  if (enabled.trim().toLowerCase() !== "true") return null;
  return { clientId, clientSecret };
}

export async function isSallaConnectorConfigured(): Promise<boolean> {
  return (await resolveSallaConnectorConfig()) !== null;
}
