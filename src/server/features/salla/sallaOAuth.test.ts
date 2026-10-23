import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";

// Salla OAuth authorization-code flow boundaries — mock-tested only (§1.5):
// signed state, single-use nonce consumed before side effects, user/project
// ownership bindings, sealed tokens, docs-shaped token + user-info contracts.
const testState = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
  envValues: {} as Record<string, string | undefined>,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

// The service boundary reads the dedicated seal secret through the runtime-env
// wrapper; the test pins it so completeCallback can seal (not store plaintext).
vi.mock("@/server/lib/runtime-env", async () => {
  void testState;
  return {
    getOptionalEnvValue: (name: string) =>
      Promise.resolve(testState.envValues[name]),
  };
});

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  testState.client = createClient({ url: "file::memory:" });
  testState.db = drizzle(testState.client);
  return { db: testState.db };
});

import { SALLA_TOKEN_URL, SALLA_USER_INFO_URL } from "./sallaConfig";
import {
  createSallaAuthorizationUrl,
  exchangeSallaAuthorizationCode,
  fetchSallaUserInfo,
  handleSallaOAuthCallback,
  refreshSallaToken,
} from "./sallaOAuth";
import { SallaService } from "./sallaService";
import {
  formBody,
  requestUrl,
  refreshGrantResponse,
  SALLA_CONNECTIONS_TABLE_DDL,
  SALLA_VERIFICATION_TABLE_DDL,
  tokenGrantResponse,
  userInfoResponse,
} from "./sallaTestHelpers";

const config = {
  clientId: "salla-client-id",
  clientSecret: "salla-client-secret",
};

const publicOrigin = "https://openseo.test";
const owner = { userId: "user-1", projectId: "project-1" };

/** A fetch stub whose recorded calls stay typed. */
type SallaFetchMock = Mock<
  (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
>;

function stubFetchMock(
  handler: (input: RequestInfo | URL) => Promise<Response>,
): SallaFetchMock {
  const fetchMock =
    vi.fn<
      (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    >();
  fetchMock.mockImplementation(async (input: RequestInfo | URL) =>
    handler(input),
  );
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function scalarExpr(sqlText: string) {
  return async (): Promise<string | number | null> => {
    if (!testState.client) throw new Error("Test database was not initialized");
    const result = await testState.client.execute(sqlText);
    const value = result.rows[0]?.value;
    if (typeof value === "string" || typeof value === "number") return value;
    return null;
  };
}

async function makeState(
  overrides: Partial<{
    callbackURL: string;
    projectId: string;
  }> = {},
) {
  const url = await createSallaAuthorizationUrl({
    owner: {
      userId: owner.userId,
      projectId: overrides.projectId ?? owner.projectId,
    },
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    // Callback paths other than the connector route are sanitized; the flow
    // pins the return to SALLA_CALLBACK_PATH regardless (asserted below).
    callbackURL: overrides.callbackURL ?? "/p/project-1/settings",
    publicOrigin,
  });
  const parsed = new URL(url);
  const state = parsed.searchParams.get("state");
  if (!state) throw new Error("Authorization URL did not contain state");
  return { url, parsed, state };
}

function callbackRequest(
  state: string,
  extraParams: Record<string, string> = {},
) {
  const url = new URL("/api/salla/oauth/callback", publicOrigin);
  url.searchParams.set("state", state);
  for (const [key, value] of Object.entries(extraParams)) {
    url.searchParams.set(key, value);
  }
  return new Request(url);
}

const grantsCount = scalarExpr(
  "SELECT count(*) AS value FROM salla_connections",
);
const statesCount = scalarExpr(
  "SELECT count(*) AS value FROM verification WHERE identifier = 'salla-oauth-state'",
);

beforeEach(async () => {
  if (!testState.client) throw new Error("Test database was not initialized");
  testState.envValues = {
    SALLA_CONNECTOR_ENABLED: "true",
    SALLA_CLIENT_ID: "salla-client-id",
    SALLA_CLIENT_SECRET: "salla-client-secret",
    SALLA_TOKEN_ENCRYPTION_KEY: "salla-seal-key",
  };
  await testState.client.execute("DROP TABLE IF EXISTS verification");
  await testState.client.execute("DROP TABLE IF EXISTS salla_connections");
  await testState.client.execute(SALLA_VERIFICATION_TABLE_DDL);
  await testState.client.execute(SALLA_CONNECTIONS_TABLE_DDL);
});

afterAll(() => testState.client?.close());

describe("Salla authorization URL", () => {
  it("points at the verified authorize endpoint with least-privilege scopes", async () => {
    const { parsed } = await makeState();
    expect(parsed.origin + parsed.pathname).toBe(
      "https://accounts.salla.sa/oauth2/auth",
    );
    expect(parsed.searchParams.get("client_id")).toBe(config.clientId);
    expect(parsed.searchParams.get("response_type")).toBe("code");
    expect(parsed.searchParams.get("redirect_uri")).toBe(
      `${publicOrigin}/api/salla/oauth/callback`,
    );
    expect(parsed.searchParams.get("scope")).toBe(
      "products.read categories.read offline_access",
    );
    expect(parsed.searchParams.get("state")).toBeTruthy();
  });

  it("registers a single-use stateNonce before redirecting", async () => {
    await makeState();
    expect(await statesCount()).toBe(1);
  });

  it("seals its user and project into the state, never free text", async () => {
    const { state } = await makeState();
    const casted: unknown = JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(
          atob(state.split(".")[0].replaceAll("-", "+").replaceAll("_", "/")),
          (char) => char.charCodeAt(0),
        ),
      ),
    );
    expect(casted).toMatchObject({
      userId: "user-1",
      projectId: "project-1",
    });
  });
});

describe("Salla token exchange contracts", () => {
  let fetchMock: SallaFetchMock;

  beforeEach(() => {
    fetchMock = stubFetchMock(async (input) => {
      const url = requestUrl(input);
      if (url.startsWith(SALLA_TOKEN_URL)) {
        return tokenGrantResponse();
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });

  it("exchanges the code with form-urlencoded grant_type=authorization_code", async () => {
    const response = await exchangeSallaAuthorizationCode({
      code: "auth-code-1",
      config,
      publicOrigin,
    });
    expect(response.access_token).toBe("ory_at_hello");
    expect(fetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = fetchMock.mock.calls[0];
    expect(calledUrl).toBe(SALLA_TOKEN_URL);
    expect(init?.method).toBe("POST");
    const body = formBody(init);
    expect(body.get("grant_type")).toBe("authorization_code");
    expect(body.get("code")).toBe("auth-code-1");
    expect(body.get("client_id")).toBe(config.clientId);
    expect(body.get("client_secret")).toBe(config.clientSecret);
    expect(body.get("redirect_uri")).toBe(
      `${publicOrigin}/api/salla/oauth/callback`,
    );
  });

  it("rotates the refresh pair for grant_type=refresh_token (single-use)", async () => {
    const refreshFetch = stubFetchMock(async () => refreshGrantResponse());
    const response = await refreshSallaToken({
      refreshToken: "ory_rt_old",
      config,
    });
    expect(response.access_token).toBe("ory_at_rotated");
    expect(response.refresh_token).toBe("ory_rt_rotated");
    const body = formBody(refreshFetch.mock.calls[0][1]);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("ory_rt_old");
  });
});

describe("Salla user info contract", () => {
  it("extracts merchant and store identity from the documented shape", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async () => userInfoResponse()),
    );
    const identity = await fetchSallaUserInfo({
      accessToken: "ory_at_hello",
    });
    expect(identity).toEqual({
      merchantId: "650198123",
      merchantName: "ACME",
      storeId: "760398",
      storeDomain: "acme.salla.sa",
      storeUrl: "https://acme.salla.sa",
      storeStatus: "active",
    });
  });
});

describe("Salla callback boundaries", () => {
  beforeEach(() => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockImplementation(async (input: RequestInfo | URL) => {
        const raw = requestUrl(input);
        if (raw.startsWith(SALLA_TOKEN_URL)) {
          return tokenGrantResponse();
        }
        if (raw.startsWith(SALLA_USER_INFO_URL)) {
          return userInfoResponse();
        }
        throw new Error(`unexpected fetch ${raw}`);
      }),
    );
  });

  it("completes authorization and seals the grant for the owning project", async () => {
    const { state } = await makeState();
    // Routed through the service boundary so the seal-before-store policy is
    // exercised, not just the OAuth mechanics.
    const { outcome, redirectTo } = await SallaService.completeCallback({
      request: callbackRequest(state, { code: "auth-code-1" }),
      user: { userId: owner.userId },
      organizationId: "org-1",
      publicOrigin,
    });
    if (outcome.kind !== "authorized") {
      throw new Error(`Expected authorized, got ${outcome.kind}`);
    }
    expect(await grantsCount()).toBe(1);
    expect(await statesCount()).toBe(0);
    expect(redirectTo).toBe("/p/project-1/settings");
    const ciphertext = await scalarExpr(
      "SELECT token_ciphertext AS value FROM salla_connections",
    )();
    expect(String(ciphertext ?? "")).not.toContain("ory_at_hello");
    expect(String(ciphertext ?? "")).not.toContain("ory_rt_rotate");
    const stored = await scalarExpr(
      "SELECT store_id AS value, connected_by_user_id AS owner FROM salla_connections",
    )();
    expect(stored).not.toBeNull();
  });

  it("rejects a callback from another user without consuming the state", async () => {
    const { state } = await makeState();
    const { outcome } = await handleSallaOAuthCallback({
      request: callbackRequest(state, { code: "auth-code-1" }),
      user: { userId: "user-2" },
      config,
      publicOrigin,
    });
    expect(outcome.kind).toBe("user_mismatch");
    expect(await grantsCount()).toBe(0);
    expect(await statesCount()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("rejects an inconsistent mint (state project differs from its pinned path) without consuming the state", async () => {
    // A caller could mint state for project-B while pinning a /p/project-A
    // return path; the callback binds the two at mint time and must refuse
    // the pair. HMAC prevents forging state to rebind either side.
    const minted = await createSallaAuthorizationUrl({
      owner: { userId: owner.userId, projectId: "project-B" },
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      callbackURL: "/p/project-A/settings",
      publicOrigin,
    });
    const state = new URL(minted).searchParams.get("state");
    if (!state) throw new Error("Authorization URL did not contain state");
    const { outcome } = await handleSallaOAuthCallback({
      request: callbackRequest(state, { code: "auth-code-1" }),
      user: { userId: owner.userId },
      config,
      publicOrigin,
    });
    expect(outcome.kind).toBe("project_mismatch");
    expect(fetch).not.toHaveBeenCalled();
    // The mismatched mint stays until its expiry — never consumed.
    expect(await statesCount()).toBe(1);
    expect(await grantsCount()).toBe(0);
  });

  it("burns the state on provider error and writes no grant", async () => {
    const { state } = await makeState();
    const { outcome } = await handleSallaOAuthCallback({
      request: callbackRequest(state, { error: "access_denied" }),
      user: { userId: owner.userId },
      config,
      publicOrigin,
    });
    expect(outcome.kind).toBe("provider_error");
    expect(await grantsCount()).toBe(0);
    expect(await statesCount()).toBe(0);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses a replayed state after a successful authorization", async () => {
    const { state } = await makeState();
    const first = await SallaService.completeCallback({
      request: callbackRequest(state, { code: "auth-code-1" }),
      user: { userId: owner.userId },
      organizationId: "org-1",
      publicOrigin,
    });
    expect(first.outcome.kind).toBe("authorized");
    await expect(
      handleSallaOAuthCallback({
        request: callbackRequest(state, { code: "auth-code-2" }),
        user: { userId: owner.userId },
        config,
        publicOrigin,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(fetch).toHaveBeenCalledTimes(2); // token + user info, once
    expect(await grantsCount()).toBe(1);
  });

  it("preserves an unconsumed state when the code is missing", async () => {
    const { state } = await makeState();
    await expect(
      handleSallaOAuthCallback({
        request: callbackRequest(state),
        user: { userId: owner.userId },
        config,
        publicOrigin,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await statesCount()).toBe(1);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("accepts a tampered state only by rejecting it wholesale", async () => {
    const { state } = await makeState();
    const [, signature] = state.split(".");
    const forgedPayload = bytesToBase64UrlForTest(
      JSON.stringify({
        userId: "user-1",
        projectId: "project-2",
        exp: Date.now() + 60_000,
        nonce: crypto.randomUUID(),
        callbackPath: "/api/salla/oauth/callback",
      }),
    );
    await expect(
      handleSallaOAuthCallback({
        request: callbackRequest(`${forgedPayload}.${signature}`, {
          code: "auth-code-1",
        }),
        user: { userId: owner.userId },
        config,
        publicOrigin,
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(await grantsCount()).toBe(0);
    // Original state survives (unused).
    expect(await statesCount()).toBe(1);
  });
});

function bytesToBase64UrlForTest(value: string) {
  return btoa(value)
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
}
