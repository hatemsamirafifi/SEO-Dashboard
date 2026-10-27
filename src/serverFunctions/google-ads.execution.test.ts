import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  getConnection: vi.fn(),
  userHasGrant: vi.fn(),
  selectCustomer: vi.fn(),
  testConnection: vi.fn(),
  disconnect: vi.fn(),
  discoverAccessibleCustomers: vi.fn(),
  listManagerChildren: vi.fn(),
  createAuthorizationUrl: vi.fn(),
  hasSelfHostedConfig: vi.fn(),
  isHostedAuthMode: vi.fn(),
  getPublicOrigin: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));

vi.mock("@tanstack/react-start", async (importOriginal) => {
  const { compiledCreateServerFnModule } =
    await import("./googleAdsServerFnHarness");
  return compiledCreateServerFnModule(await importOriginal());
});

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://openseo.test/_server", { method: "POST" }),
}));

vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUser,
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.projectLookup,
  },
}));

vi.mock("@/server/features/google-ads/services/GoogleAdsService", () => ({
  GoogleAdsService: {
    getConnection: mocks.getConnection,
    userHasGrant: mocks.userHasGrant,
    selectCustomer: mocks.selectCustomer,
    testConnection: mocks.testConnection,
    disconnect: mocks.disconnect,
  },
}));

vi.mock("@/server/features/google-ads/services/googleAdsDiscovery", () => ({
  discoverAccessibleCustomers: mocks.discoverAccessibleCustomers,
  listManagerChildren: mocks.listManagerChildren,
}));

vi.mock("@/server/features/gsc/selfHostedOAuth", () => ({
  createSelfHostedGoogleAdsAuthorizationUrl: mocks.createAuthorizationUrl,
}));

vi.mock("@/server/features/gsc/oauth-config", () => ({
  hasSelfHostedGscConfig: mocks.hasSelfHostedConfig,
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedAuthMode,
}));

vi.mock("@/server/mcp/public-origin", () => ({
  getPublicOrigin: mocks.getPublicOrigin,
}));

import {
  discoverGoogleAdsCustomers,
  disconnectGoogleAds,
  listGoogleAdsManagerChildren,
  selectGoogleAdsCustomer,
  startSelfHostedGoogleAdsLink,
  testGoogleAdsConnection,
} from "./google-ads";
import { executeServerFunction } from "./googleAdsServerFnHarness";

/* Positive behavioral suite: every project-scoped handler is executed for
 * real, through the global ensure-user middleware, the project authorization,
 * the Zod validators and the function-level middleware - all unmocked. The
 * mocks only replace the downstream service, discovery and OAuth modules. */

const PROJECT_ID = "project-1";
const CUSTOMER_ID = "4897513260";
const MANAGER_ID = "3216549870";
const AUTH_CONTEXT = {
  userId: "user-1",
  userEmail: "owner@example.com",
  emailVerified: true,
  organizationId: "organization-1",
};

type ServerFnExecution = {
  result?: unknown;
  error?: unknown;
  context?: unknown;
};

function isServerFnExecution(value: unknown): value is ServerFnExecution {
  return typeof value === "object" && value !== null && "result" in value;
}

type AnyVitestMock = { mock: { calls: unknown[][] } };

function firstCallArg(mock: AnyVitestMock): unknown {
  return mock.mock.calls[0]?.[0];
}

function sortedKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an object to project its keys");
  }
  return Object.keys(value).toSorted();
}

async function run(
  serverFunction: Parameters<typeof executeServerFunction>[0],
  data: unknown,
  method: "POST" | "GET" = "POST",
) {
  const execution: unknown = await executeServerFunction(
    serverFunction,
    data,
    method,
  );
  if (!isServerFnExecution(execution)) {
    throw new Error("Expected the middleware-chain execution envelope");
  }
  return execution;
}

beforeEach(() => {
  mocks.resolveUser.mockResolvedValue(AUTH_CONTEXT);
  mocks.projectLookup.mockImplementation((projectId: string) =>
    projectId === PROJECT_ID
      ? { id: PROJECT_ID, organizationId: "organization-1" }
      : null,
  );
  mocks.getConnection.mockResolvedValue(null);
  mocks.userHasGrant.mockResolvedValue(true);
  mocks.selectCustomer.mockResolvedValue({
    customerId: CUSTOMER_ID,
    customerDisplayName: "Client store",
    loginCustomerId: null,
    currencyCode: "EUR",
    timeZone: null,
    isTestAccount: false,
  });
  mocks.testConnection.mockResolvedValue({
    ok: true,
    errorClass: null,
    message: "The Google Ads connection works.",
    retryable: false,
  });
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.discoverAccessibleCustomers.mockResolvedValue({
    grants: [],
    partial: false,
    skippedGrants: 0,
    skippedCustomers: 0,
  });
  mocks.listManagerChildren.mockResolvedValue({
    managerId: MANAGER_ID,
    grantAccountId: "google-sub-1",
    children: [],
    truncated: false,
    malformedRows: 0,
    partial: false,
    failure: null,
  });
  mocks.createAuthorizationUrl.mockResolvedValue(
    "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
  );
  mocks.hasSelfHostedConfig.mockResolvedValue(true);
  mocks.isHostedAuthMode.mockResolvedValue(false);
  mocks.getPublicOrigin.mockReturnValue("https://openseo.test");
});

/* Every downstream spy that must stay untouched while status or disconnect
 * run - those handlers are database-only by design. */
function expectNoAdsApi() {
  expect(mocks.discoverAccessibleCustomers).not.toHaveBeenCalled();
  expect(mocks.listManagerChildren).not.toHaveBeenCalled();
  expect(mocks.selectCustomer).not.toHaveBeenCalled();
  expect(mocks.testConnection).not.toHaveBeenCalled();
  expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
}

describe("Google Ads server-function execution", () => {
  it("disconnect runs the handler and removes exactly the authenticated project scope", async () => {
    const { result, error } = await run(disconnectGoogleAds, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: false });
    expect(mocks.disconnect).toHaveBeenCalledTimes(1);
    const scope = firstCallArg(mocks.disconnect);
    expect(scope).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      userId: "user-1",
    });
    // The scope carries nothing but the trusted identifiers.
    expect(sortedKeys(scope)).toEqual([
      "organizationId",
      "projectId",
      "userId",
    ]);
    expectNoAdsApi();
  });

  it("discovery runs the handler with the authenticated user and the named grant", async () => {
    await run(discoverGoogleAdsCustomers, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
    });

    const call = firstCallArg(mocks.discoverAccessibleCustomers);
    expect(call).toEqual({
      userId: "user-1",
      grantAccountId: "google-sub-1",
    });
    expect(sortedKeys(call)).toEqual(["grantAccountId", "userId"]);
    expect(mocks.listManagerChildren).not.toHaveBeenCalled();
  });

  it("discovery runs the handler for every owned grant and carries no other identifiers", async () => {
    await run(discoverGoogleAdsCustomers, { projectId: PROJECT_ID });

    const call = firstCallArg(mocks.discoverAccessibleCustomers);
    expect(call).toEqual({ userId: "user-1" });
    expect(sortedKeys(call)).toEqual(["userId"]);
  });

  it("manager expansion runs the handler with ids normalized by the validator", async () => {
    const { result, error } = await run(listGoogleAdsManagerChildren, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
      managerId: "321 654 9870",
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      managerId: MANAGER_ID,
      grantAccountId: "google-sub-1",
      children: [],
      truncated: false,
      malformedRows: 0,
      partial: false,
      failure: null,
    });
    const call = firstCallArg(mocks.listManagerChildren);
    expect(call).toEqual({
      userId: "user-1",
      grantAccountId: "google-sub-1",
      managerId: MANAGER_ID,
    });
    expect(sortedKeys(call)).toEqual(["grantAccountId", "managerId", "userId"]);
  });

  it("customer selection runs the handler with validated ids and returns the safe projection", async () => {
    const { result, error } = await run(selectGoogleAdsCustomer, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
      customerId: "489-751-3260",
      loginCustomerId: "321 654 9870",
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connected: true,
      customerId: CUSTOMER_ID,
      customerDisplayName: "Client store",
      loginCustomerId: null,
      currencyCode: "EUR",
      timeZone: null,
      isTestAccount: false,
    });
    expect(sortedKeys(result)).toEqual([
      "connected",
      "currencyCode",
      "customerDisplayName",
      "customerId",
      "isTestAccount",
      "loginCustomerId",
      "timeZone",
    ]);
    const call = firstCallArg(mocks.selectCustomer);
    expect(call).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      userId: "user-1",
      grantAccountId: "google-sub-1",
      customerId: CUSTOMER_ID,
      loginCustomerId: MANAGER_ID,
    });
    expect(sortedKeys(call)).toEqual([
      "customerId",
      "grantAccountId",
      "loginCustomerId",
      "organizationId",
      "projectId",
      "userId",
    ]);
  });

  it("connection test runs the handler with exactly the trusted scope", async () => {
    const { result, error } = await run(testGoogleAdsConnection, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      ok: true,
      errorClass: null,
      message: "The Google Ads connection works.",
      retryable: false,
    });
    const call = firstCallArg(mocks.testConnection);
    expect(call).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      userId: "user-1",
    });
    expect(sortedKeys(call)).toEqual(["organizationId", "projectId", "userId"]);
  });

  it("self-hosted link runs the handler with the trusted project id and public origin", async () => {
    const { result, error } = await run(startSelfHostedGoogleAdsLink, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      url: "https://accounts.google.com/o/oauth2/v2/auth?state=abc",
    });
    expect(mocks.createAuthorizationUrl).toHaveBeenCalledTimes(1);
    const call = firstCallArg(mocks.createAuthorizationUrl);
    // The return path is built from the trusted project id and the server
    // origin - never from client input.
    expect(call).toEqual({
      user: { userId: "user-1", userEmail: "owner@example.com" },
      projectId: PROJECT_ID,
      callbackURL: `/p/${PROJECT_ID}/settings`,
      publicOrigin: "https://openseo.test",
    });
    expect(mocks.getPublicOrigin).toHaveBeenCalledTimes(1);
  });
});
