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
  getGoogleAdsConnectionStatus,
  getGoogleAdsGrantStatus,
} from "./google-ads";
import { executeServerFunction } from "./googleAdsServerFnHarness";

/* Positive behavioral suite for the status handlers: they run for real
 * through the global ensure-user middleware and the project authorization,
 * and must answer from the database alone - the connection status listens on
 * reads only and never touches the Ads API or the OAuth flow. */

const PROJECT_ID = "project-1";
const CUSTOMER_ID = "4897513260";
const AUTH_CONTEXT = {
  userId: "user-1",
  userEmail: "owner@example.com",
  emailVerified: true,
  organizationId: "organization-1",
};

type ServerFnExecution = {
  result?: unknown;
  error?: unknown;
};

function isServerFnExecution(value: unknown): value is ServerFnExecution {
  return typeof value === "object" && value !== null && "result" in value;
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
  mocks.hasSelfHostedConfig.mockResolvedValue(true);
  mocks.isHostedAuthMode.mockResolvedValue(false);
});

function sortedKeys(value: unknown): string[] {
  if (typeof value !== "object" || value === null) {
    throw new Error("Expected an object to project its keys");
  }
  return Object.keys(value).toSorted();
}

/* Every downstream spy that must stay untouched while the status handlers
 * run - they are database-only by design. */
function expectNoAdsApi() {
  expect(mocks.discoverAccessibleCustomers).not.toHaveBeenCalled();
  expect(mocks.listManagerChildren).not.toHaveBeenCalled();
  expect(mocks.selectCustomer).not.toHaveBeenCalled();
  expect(mocks.testConnection).not.toHaveBeenCalled();
  expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
}

describe("Google Ads server-function database-only status", () => {
  it("connection status runs the handler and returns the safe database-only projection", async () => {
    mocks.getConnection.mockResolvedValue({
      id: "connection-1",
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      customerId: CUSTOMER_ID,
      loginCustomerId: null,
      customerDisplayName: "Client store",
      grantAccountId: "google-sub-1",
      connectedByUserId: "user-1",
      currencyCode: null,
      timeZone: null,
      isTestAccount: false,
      createdAt: new Date("2026-01-01T00:00:00.000Z"),
      updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    });

    const { result, error } = await run(getGoogleAdsConnectionStatus, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connected: true,
      currentUserHasGrant: true,
      googleOAuthConfigured: true,
      customerId: CUSTOMER_ID,
      customerDisplayName: "Client store",
      loginCustomerId: null,
      currencyCode: null,
      timeZone: null,
      isTestAccount: false,
      grantAccountId: "google-sub-1",
      connectedAt: new Date("2026-01-01T00:00:00.000Z"),
      connectedByEmail: "owner@example.com",
    });
    // No token, no refresh token: the projection is safe to send to the client.
    expect(sortedKeys(result)).toEqual([
      "connected",
      "connectedAt",
      "connectedByEmail",
      "currencyCode",
      "currentUserHasGrant",
      "customerDisplayName",
      "customerId",
      "googleOAuthConfigured",
      "grantAccountId",
      "isTestAccount",
      "loginCustomerId",
      "timeZone",
    ]);
    expect(mocks.getConnection).toHaveBeenCalledTimes(1);
    expect(mocks.getConnection).toHaveBeenCalledWith(
      PROJECT_ID,
      "organization-1",
    );
    expect(mocks.userHasGrant).toHaveBeenCalledTimes(1);
    expect(mocks.userHasGrant).toHaveBeenCalledWith("user-1");
    expectNoAdsApi();
  });

  it("connection status still answers safely with no connection stored", async () => {
    const { result, error } = await run(getGoogleAdsConnectionStatus, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connected: false,
      currentUserHasGrant: true,
      googleOAuthConfigured: true,
      customerId: null,
      customerDisplayName: null,
      loginCustomerId: null,
      currencyCode: null,
      timeZone: null,
      isTestAccount: false,
      grantAccountId: null,
      connectedAt: null,
      connectedByEmail: null,
    });
    expectNoAdsApi();
  });

  it("grant status runs the GET handler without touching the project scope", async () => {
    const { result, error } = await run(
      getGoogleAdsGrantStatus,
      undefined,
      "GET",
    );

    expect(error).toBeUndefined();
    expect(result).toEqual({ hasGrant: true });
    expect(mocks.userHasGrant).toHaveBeenCalledTimes(1);
    expect(mocks.userHasGrant).toHaveBeenCalledWith("user-1");
    expect(mocks.projectLookup).not.toHaveBeenCalled();
    expectNoAdsApi();
  });
});
