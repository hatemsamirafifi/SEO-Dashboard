/**
 * Shared helpers for the Salla connector tests.
 *
 * The provider response fixtures, the schema the OAuth flow writes to and
 * the fetch-reading helpers live here so the test files stay focused on the
 * boundaries they assert.
 */

/** `verification` table: the single-use OAuth state nonces. */
export const SALLA_VERIFICATION_TABLE_DDL = `
    CREATE TABLE verification (
      id TEXT PRIMARY KEY NOT NULL,
      identifier TEXT NOT NULL,
      value TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

/** `salla_connections` table: the sealed per-project grant. */
export const SALLA_CONNECTIONS_TABLE_DDL = `
    CREATE TABLE salla_connections (
      id TEXT PRIMARY KEY NOT NULL,
      project_id TEXT NOT NULL UNIQUE,
      organization_id TEXT NOT NULL,
      connected_by_user_id TEXT NOT NULL,
      merchant_id TEXT NOT NULL,
      merchant_name TEXT,
      store_id TEXT NOT NULL,
      store_domain TEXT,
      store_url TEXT,
      store_status TEXT,
      scope TEXT,
      token_ciphertext TEXT NOT NULL,
      token_expires_at TEXT,
      connected_at TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `;

/** The documented token response for an authorization-code exchange. */
export function tokenGrantResponse() {
  return new Response(
    JSON.stringify({
      access_token: "ory_at_hello",
      expires: 1209599,
      refresh_token: "ory_rt_rotate",
      scope: "products.read categories.read offline_access",
      token_type: "bearer",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** The documented token response for a refresh-token rotation. */
export function refreshGrantResponse() {
  return new Response(
    JSON.stringify({
      access_token: "ory_at_rotated",
      expires: 1209599,
      refresh_token: "ory_rt_rotated",
      scope: "products.read categories.read offline_access",
      token_type: "bearer",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** The documented user-info response. */
export function userInfoResponse() {
  return new Response(
    JSON.stringify({
      status: 200,
      success: true,
      data: {
        id: 42,
        name: "Owner",
        merchant: { id: 650198123, username: "acme", name: "ACME" },
        store: {
          id: 760398,
          domain: "acme.salla.sa",
          url: "https://acme.salla.sa",
          status: "active",
        },
      },
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

/** The URL a fetch was called with, whatever form the caller used. */
export function requestUrl(input: RequestInfo | URL): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

/** The form-urlencoded body of a fetch call, as URL search params. */
export function formBody(init: RequestInit | undefined): URLSearchParams {
  const body = init?.body;
  if (body instanceof URLSearchParams) return body;
  if (typeof body === "string") return new URLSearchParams(body);
  throw new Error("Expected a form-urlencoded request body");
}
