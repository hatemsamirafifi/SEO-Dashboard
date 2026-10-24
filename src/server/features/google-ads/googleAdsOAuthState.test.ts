import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { symmetricDecrypt } from "better-auth/crypto";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";

/* Phase 1 boundary tests for the self-hosted Google Ads OAuth state machine:
 * PKCE linkage, project/user binding, single-use nonce consumption, expiry,
 * provider-key separation (GA4 states can never satisfy Ads callbacks), the
 * same-origin return path, and Better Auth token encryption at rest. */

const testState = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
  decodeJwt: vi.fn(),
  getConfig: vi.fn(),
  hasConfig: vi.fn(),
  encryptOAuthTokens: false,
  secret: "test-secret-that-is-long-enough-for-auth",
  tokenBody: {} as Record<string, unknown>,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  testState.client = createClient({ url: "file::memory:" });
  testState.db = drizzle(testState.client);
  return { db: testState.db };
});

vi.mock("jose", () => ({ decodeJwt: testState.decodeJwt }));

vi.mock("@/server/features/gsc/oauth-config", () => ({
  getGscOAuthClientConfig: testState.getConfig,
  hasSelfHostedGscConfig: testState.hasConfig,
}));

vi.mock("@/lib/auth", () => ({
  getAuth: () => ({
    $context: Promise.resolve({
      options: {
        account: { encryptOAuthTokens: testState.encryptOAuthTokens },
      },
      secretConfig: testState.secret,
    }),
  }),
}));

import {
  createSelfHostedGa4AuthorizationUrl,
  createSelfHostedGoogleAdsAuthorizationUrl,
  handleSelfHostedGa4OAuthCallback,
  handleSelfHostedGoogleAdsOAuthCallback,
} from "@/server/features/gsc/selfHostedOAuth";

const user = { userId: "user-1", userEmail: "owner@example.com" };
const publicOrigin = "https://openseo.test";
const ADS_STATE = "google-ads-oauth-state";
const GA4_STATE = "ga4-oauth-state";
const COUNT_VERIFICATION =
  "SELECT count(*) AS value FROM verification WHERE identifier = ?";
const COUNT_ACCOUNT =
  "SELECT count(*) AS value FROM account WHERE provider_id = ?";

const statePayloadSchema = z.object({
  userId: z.string().min(1),
  callbackPath: z.string().min(1),
  projectId: z.string().min(1).optional(),
  nonce: z.string().optional(),
});

const pkceValueSchema = z.object({
  state: z.string().min(1),
  codeVerifier: z.string().min(43),
});

const VERIFICATION_DDL = `CREATE TABLE verification (
  id TEXT PRIMARY KEY NOT NULL, identifier TEXT NOT NULL, value TEXT NOT NULL, expires_at INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`;

const ACCOUNT_DDL = `CREATE TABLE account (
  id TEXT PRIMARY KEY NOT NULL, account_id TEXT NOT NULL, provider_id TEXT NOT NULL, user_id TEXT NOT NULL, access_token TEXT, refresh_token TEXT, id_token TEXT, access_token_expires_at INTEGER, refresh_token_expires_at INTEGER, scope TEXT, password TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
)`;

function parseJson(text: string): unknown {
  const parsed: unknown = JSON.parse(text);
  return parsed;
}

function callbackRequest(path: string, state: string, code: string) {
  const url = new URL(path, publicOrigin);
  url.searchParams.set("state", state);
  url.searchParams.set("code", code);
  return new Request(url);
}

async function scalar(sql: string, args: string[] = []) {
  if (!testState.client) throw new Error("Test database was not initialized");
  const result = await testState.client.execute({ sql, args });
  return Number(result.rows[0]?.value ?? 0);
}

/** The parked single-use row for a provider's state identifier. */
async function verificationStateValue(identifier: string): Promise<string> {
  if (!testState.client) throw new Error("Test database was not initialized");
  const result = await testState.client.execute({
    sql: "SELECT value FROM verification WHERE identifier = ?",
    args: [identifier],
  });
  const value = result.rows[0]?.value;
  if (typeof value !== "string") {
    throw new Error(`No verification row for ${identifier}`);
  }
  return value;
}

/** The persisted grant row for a provider, as stored (still encrypted). */
async function storedAccount(providerId: string) {
  if (!testState.client) throw new Error("Test database was not initialized");
  const result = await testState.client.execute({
    sql: "SELECT access_token, refresh_token, id_token FROM account WHERE provider_id = ?",
    args: [providerId],
  });
  const row = result.rows[0];
  if (!row) throw new Error(`No account row for ${providerId}`);
  return {
    accessToken: typeof row.access_token === "string" ? row.access_token : null,
    refreshToken:
      typeof row.refresh_token === "string" ? row.refresh_token : null,
    idToken: typeof row.id_token === "string" ? row.id_token : null,
  };
}

function base64UrlEncodeBinary(binary: string) {
  const encoded = btoa(binary);
  return encoded.replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

function base64UrlDecodeText(value: string) {
  const padded = `${value}${"=".repeat((4 - (value.length % 4)) % 4)}`;
  return atob(padded.replaceAll("-", "+").replaceAll("_", "/"));
}

/** Decodes the signed state payload into its validated fields. */
function statePayload(state: string) {
  const payload = state.split(".")[0];
  if (!payload) throw new Error("state payload was missing");
  return statePayloadSchema.parse(parseJson(base64UrlDecodeText(payload)));
}

/** Body of the n-th token-exchange call, as URL-encoded parameters. */
function tokenRequestParams(callIndex = 0) {
  const body = vi.mocked(fetch).mock.calls[callIndex]?.[1]?.body;
  if (typeof body === "string") return new URLSearchParams(body);
  if (body instanceof URLSearchParams) return new URLSearchParams(body);
  throw new Error("token request body was not URL-encoded");
}

async function adsAuthorizationUrl(init?: {
  projectId?: string;
  callbackURL?: string;
}) {
  return new URL(
    await createSelfHostedGoogleAdsAuthorizationUrl({
      user,
      projectId: init?.projectId ?? "project-a",
      callbackURL: init?.callbackURL ?? "/p/project-a/google-ads",
      publicOrigin,
    }),
  );
}

async function ga4AuthorizationUrl() {
  return new URL(
    await createSelfHostedGa4AuthorizationUrl({
      user,
      projectId: "project-a",
      callbackURL: "/p/project-a/settings",
      publicOrigin,
    }),
  );
}

function requireState(url: URL): string {
  const state = url.searchParams.get("state");
  if (!state) throw new Error("Authorization URL did not contain state");
  return state;
}

/** The parked Ads state row: the signed state plus its PKCE verifier. */
async function adsStateRow() {
  return pkceValueSchema.parse(
    parseJson(await verificationStateValue(ADS_STATE)),
  );
}

/** Decrypts a stored token with Better Auth's own symmetric helper. */
async function decryptStored(value: string | null) {
  if (!value) throw new Error("stored token was missing");
  return symmetricDecrypt({ key: testState.secret, data: value });
}

function adsCallback(state: string, code: string, callbackUser = user) {
  return handleSelfHostedGoogleAdsOAuthCallback({
    request: callbackRequest("/api/google-ads/oauth/callback", state, code),
    user: callbackUser,
    publicOrigin,
  });
}

function ga4Callback(state: string, code: string) {
  return handleSelfHostedGa4OAuthCallback({
    request: callbackRequest("/api/ga4/oauth/callback", state, code),
    user,
    publicOrigin,
  });
}

async function resetTables() {
  if (!testState.client) throw new Error("Test database was not initialized");
  await testState.client.execute("DROP TABLE IF EXISTS verification");
  await testState.client.execute("DROP TABLE IF EXISTS account");
  await testState.client.execute(VERIFICATION_DDL);
  await testState.client.execute(ACCOUNT_DDL);
}

describe("self-hosted Google Ads OAuth state (PKCE + project binding)", () => {
  beforeEach(async () => {
    await resetTables();
    testState.getConfig.mockResolvedValue({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
    testState.hasConfig.mockResolvedValue(true);
    testState.decodeJwt.mockReturnValue({ sub: "google-account-1" });
    // Reset the encryption switch and the token fixture between tests.
    testState.encryptOAuthTokens = false;
    testState.tokenBody = {
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      id_token: "signed-id-token",
      scope: "openid email profile https://www.googleapis.com/auth/adwords",
      token_type: "Bearer",
    };
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(() =>
        Promise.resolve(
          new Response(JSON.stringify(testState.tokenBody), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
        ),
      ),
    );
  });

  afterAll(() => testState.client?.close());

  it("binds the Ads state to user+project+provider with a single-use nonce and PKCE challenge", async () => {
    const authorizationUrl = await adsAuthorizationUrl();
    expect(authorizationUrl.origin).toBe("https://accounts.google.com");
    expect(authorizationUrl.pathname).toBe("/o/oauth2/v2/auth");
    expect(authorizationUrl.searchParams.get("scope")).toContain(
      "https://www.googleapis.com/auth/adwords",
    );
    expect(authorizationUrl.searchParams.get("access_type")).toBe("offline");
    const codeChallenge = authorizationUrl.searchParams.get("code_challenge");
    expect(codeChallenge).toHaveLength(43);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe(
      "S256",
    );
    expect(authorizationUrl.searchParams.get("client_id")).toBe(
      "google-client-id",
    );
    expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(1);

    // The PKCE verifier sits in the single-use row, never in the URL.
    const stored = await adsStateRow();
    expect(stored.state).toBe(authorizationUrl.searchParams.get("state"));
    const payload = statePayload(stored.state);
    expect(payload.userId).toBe("user-1");
    expect(payload.projectId).toBe("project-a");
    expect(payload.callbackPath).toBe("/p/project-a/google-ads");
    expect(typeof stored.codeVerifier).toBe("string");
    expect(stored.codeVerifier.length).toBeGreaterThanOrEqual(43);
    const digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(stored.codeVerifier),
    );
    let binary = "";
    for (const byte of new Uint8Array(digest))
      binary += String.fromCharCode(byte);
    expect(base64UrlEncodeBinary(binary)).toBe(codeChallenge);
    expect(authorizationUrl.searchParams.get("code_verifier")).toBeNull();
    expect(authorizationUrl.href).not.toContain(stored.codeVerifier);
  });

  it("atomically consumes the Ads nonce and sends the stored verifier in the token exchange", async () => {
    const authorizationUrl = await adsAuthorizationUrl();
    const stored = await adsStateRow();
    const response = await adsCallback(
      requireState(authorizationUrl),
      "code-1",
    );
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/p/project-a/google-ads");
    expect(fetch).toHaveBeenCalledTimes(1);
    const body = tokenRequestParams();
    expect(body.get("code")).toBe("code-1");
    expect(body.get("code_verifier")).toBe(stored.codeVerifier);
    expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(0);
    expect(await scalar(COUNT_ACCOUNT, ["google-ads"])).toBe(1);
  });

  it("rejects an Ads state replay without re-exchanging the code", async () => {
    const state = requireState(await adsAuthorizationUrl());
    await adsCallback(state, "code-1");
    await expect(adsCallback(state, "code-2")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Google Ads state was already used",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects an Ads state whose signed project differs from its return project without consuming it", async () => {
    const state = requireState(
      await adsAuthorizationUrl({ callbackURL: "/p/project-b/google-ads" }),
    );
    await expect(adsCallback(state, "code-1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(1);
  });

  it("rejects a GA4-signed state at the Ads callback (provider-bound HMAC keys)", async () => {
    const ga4State = requireState(await ga4AuthorizationUrl());
    await expect(adsCallback(ga4State, "code-1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetch).not.toHaveBeenCalled();
    // The GA4 nonce remains unconsumed for its own callback.
    expect(await scalar(COUNT_VERIFICATION, [GA4_STATE])).toBe(1);
  });

  it("rejects an Ads-signed state at the GA4 callback without consuming it", async () => {
    const state = requireState(await adsAuthorizationUrl());
    await expect(ga4Callback(state, "code-1")).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
    });
    expect(fetch).not.toHaveBeenCalled();
    expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(1);
  });

  it("rejects an Ads state after its expiry window without consuming it", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T12:00:00Z"));
    try {
      const state = requireState(await adsAuthorizationUrl());
      vi.setSystemTime(new Date("2026-10-21T12:11:00Z"));
      await expect(adsCallback(state, "code-1")).rejects.toMatchObject({
        code: "VALIDATION_ERROR",
      });
      expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects an Ads state presented by another user without consuming the nonce", async () => {
    const state = requireState(await adsAuthorizationUrl());
    const response = await adsCallback(state, "code-1", {
      userId: "user-2",
      userEmail: "attacker@example.com",
    });
    expect(response.status).toBe(403);
    expect(fetch).not.toHaveBeenCalled();
    expect(await scalar(COUNT_VERIFICATION, [ADS_STATE])).toBe(1);
    // The parked row survives: a wrong user never burns the nonce.
    expect(await verificationStateValue(ADS_STATE)).toContain(state);
  });

  it("falls back to the site root when the return path points at another origin", async () => {
    const state = requireState(
      await adsAuthorizationUrl({
        callbackURL: "https://evil.test/p/project-a/google-ads",
      }),
    );
    expect(statePayload(state).callbackPath).toBe("/");
    const response = await adsCallback(state, "code-1");
    expect(response.status).toBe(303);
    expect(response.headers.get("Location")).toBe("/");
  });

  it("encrypts the stored Ads tokens with Better Auth's symmetric key", async () => {
    testState.encryptOAuthTokens = true;
    const state = requireState(await adsAuthorizationUrl());
    const response = await adsCallback(state, "code-1");
    expect(response.status).toBe(303);
    // No token material is handed back to the caller.
    expect(await response.text()).toBe("");
    expect(response.headers.get("Location")).not.toContain("access-token");

    const stored = await storedAccount("google-ads");
    expect(stored.accessToken).not.toBe("access-token");
    expect(stored.refreshToken).not.toBe("refresh-token");
    expect(stored.idToken).not.toBe("signed-id-token");
    expect(await decryptStored(stored.accessToken)).toBe("access-token");
    expect(await decryptStored(stored.refreshToken)).toBe("refresh-token");
    expect(await decryptStored(stored.idToken)).toBe("signed-id-token");
  });

  it("keeps the stored refresh token when a reconnect omits refresh_token", async () => {
    testState.encryptOAuthTokens = true;
    await adsCallback(requireState(await adsAuthorizationUrl()), "code-1");
    const first = await storedAccount("google-ads");
    expect(first.refreshToken).toBeTruthy();

    // Google omits refresh_token when the account is already authorized.
    testState.tokenBody = {
      ...testState.tokenBody,
      access_token: "ads-token-2",
    };
    delete testState.tokenBody.refresh_token;
    await adsCallback(requireState(await adsAuthorizationUrl()), "code-2");

    const second = await storedAccount("google-ads");
    expect(second.refreshToken).toBe(first.refreshToken);
    expect(await decryptStored(second.refreshToken)).toBe("refresh-token");
    // The access token is re-issued and re-encrypted.
    expect(second.accessToken).not.toBe(first.accessToken);
    expect(await decryptStored(second.accessToken)).toBe("ads-token-2");
    expect(await scalar(COUNT_ACCOUNT, ["google-ads"])).toBe(1);
  });

  it("stores the Ads grant without disturbing another provider's grant", async () => {
    testState.encryptOAuthTokens = true;
    await adsCallback(requireState(await adsAuthorizationUrl()), "code-1");
    testState.tokenBody = { ...testState.tokenBody, access_token: "ga4-token" };
    await ga4Callback(requireState(await ga4AuthorizationUrl()), "code-2");
    expect(await scalar(COUNT_ACCOUNT, ["google-ads"])).toBe(1);
    expect(await scalar(COUNT_ACCOUNT, ["google-analytics"])).toBe(1);
    const ads = await storedAccount("google-ads");
    const ga4 = await storedAccount("google-analytics");
    expect(await decryptStored(ads.accessToken)).toBe("access-token");
    expect(await decryptStored(ga4.accessToken)).toBe("ga4-token");
  });
});
