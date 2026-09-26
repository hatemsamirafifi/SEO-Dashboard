import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const testState = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
  decodeJwt: vi.fn(),
  getConfig: vi.fn(),
  hasConfig: vi.fn(),
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
      options: { account: { encryptOAuthTokens: false } },
      secretConfig: "test-secret-that-is-long-enough-for-auth",
    }),
  }),
}));

import {
  createSelfHostedGa4AuthorizationUrl,
  createSelfHostedGscAuthorizationUrl,
  handleSelfHostedGa4OAuthCallback,
  handleSelfHostedGscOAuthCallback,
} from "./selfHostedOAuth";

const user = { userId: "user-1", userEmail: "owner@example.com" };
const publicOrigin = "https://openseo.test";

function callbackRequest(path: string, state: string, code: string) {
  const url = new URL(path, publicOrigin);
  url.searchParams.set("state", state);
  url.searchParams.set("code", code);
  return new Request(url);
}

function tokenResponse() {
  return new Response(
    JSON.stringify({
      access_token: "access-token",
      refresh_token: "refresh-token",
      expires_in: 3600,
      id_token: "signed-id-token",
      scope:
        "openid email profile https://www.googleapis.com/auth/analytics.readonly",
      token_type: "Bearer",
    }),
    { status: 200, headers: { "Content-Type": "application/json" } },
  );
}

async function scalar(sql: string) {
  if (!testState.client) throw new Error("Test database was not initialized");
  const result = await testState.client.execute(sql);
  return Number(result.rows[0]?.value ?? 0);
}

describe("self-hosted Google OAuth state boundaries", () => {
  beforeEach(async () => {
    if (!testState.client) throw new Error("Test database was not initialized");
    await testState.client.execute("DROP TABLE IF EXISTS verification");
    await testState.client.execute("DROP TABLE IF EXISTS account");
    await testState.client.execute(`
      CREATE TABLE verification (
        id TEXT PRIMARY KEY NOT NULL,
        identifier TEXT NOT NULL,
        value TEXT NOT NULL,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    await testState.client.execute(`
      CREATE TABLE account (
        id TEXT PRIMARY KEY NOT NULL,
        account_id TEXT NOT NULL,
        provider_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        access_token TEXT,
        refresh_token TEXT,
        id_token TEXT,
        access_token_expires_at INTEGER,
        refresh_token_expires_at INTEGER,
        scope TEXT,
        password TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    testState.getConfig.mockResolvedValue({
      clientId: "google-client-id",
      clientSecret: "google-client-secret",
    });
    testState.hasConfig.mockResolvedValue(true);
    testState.decodeJwt.mockReturnValue({ sub: "google-account-1" });
    vi.stubGlobal("fetch", vi.fn().mockImplementation(tokenResponse));
  });

  afterAll(() => testState.client?.close());

  it("rejects a GA4 state whose signed project differs from its return project without consuming it", async () => {
    const authorizationUrl = new URL(
      await createSelfHostedGa4AuthorizationUrl({
        user,
        projectId: "project-a",
        callbackURL: "/p/project-b/settings",
        publicOrigin,
      }),
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("Authorization URL did not contain state");

    await expect(
      handleSelfHostedGa4OAuthCallback({
        request: callbackRequest("/api/ga4/oauth/callback", state, "code-1"),
        user,
        publicOrigin,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });

    expect(
      await scalar(
        "SELECT count(*) AS value FROM verification WHERE identifier = 'ga4-oauth-state'",
      ),
    ).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("atomically allows one GA4 callback and rejects a concurrent replay", async () => {
    const authorizationUrl = new URL(
      await createSelfHostedGa4AuthorizationUrl({
        user,
        projectId: "project-a",
        callbackURL: "/p/project-a/settings",
        publicOrigin,
      }),
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("Authorization URL did not contain state");

    const outcomes = await Promise.allSettled([
      handleSelfHostedGa4OAuthCallback({
        request: callbackRequest("/api/ga4/oauth/callback", state, "code-1"),
        user,
        publicOrigin,
      }),
      handleSelfHostedGa4OAuthCallback({
        request: callbackRequest("/api/ga4/oauth/callback", state, "code-1"),
        user,
        publicOrigin,
      }),
    ]);

    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Response> =>
        outcome.status === "fulfilled",
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult =>
        outcome.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(fulfilled[0]?.value.status).toBe(303);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      code: "VALIDATION_ERROR",
      message: "Google Analytics state was already used",
    });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(
      await scalar(
        "SELECT count(*) AS value FROM verification WHERE identifier = 'ga4-oauth-state'",
      ),
    ).toBe(0);
    expect(
      await scalar(
        "SELECT count(*) AS value FROM account WHERE provider_id = 'google-analytics'",
      ),
    ).toBe(1);
  });

  it("preserves GSC's non-consuming state and repeat-callback compatibility", async () => {
    const authorizationUrl = new URL(
      await createSelfHostedGscAuthorizationUrl({
        user,
        callbackURL: "/p/project-a/settings",
        publicOrigin,
      }),
    );
    const state = authorizationUrl.searchParams.get("state");
    if (!state) throw new Error("Authorization URL did not contain state");

    expect(await scalar("SELECT count(*) AS value FROM verification")).toBe(0);

    const first = await handleSelfHostedGscOAuthCallback({
      request: callbackRequest("/api/gsc/oauth/callback", state, "code-1"),
      user,
      publicOrigin,
    });
    const replay = await handleSelfHostedGscOAuthCallback({
      request: callbackRequest("/api/gsc/oauth/callback", state, "code-2"),
      user,
      publicOrigin,
    });

    expect(first.status).toBe(303);
    expect(replay.status).toBe(303);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(await scalar("SELECT count(*) AS value FROM verification")).toBe(0);
    expect(
      await scalar(
        "SELECT count(*) AS value FROM account WHERE provider_id = 'google-search-console'",
      ),
    ).toBe(1);
  });
});
