import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  googleAdsConnectionTestSchema,
  googleAdsDiscoverySchema,
  googleAdsDisconnectSchema,
  googleAdsLinkSchema,
  googleAdsManagerChildrenSchema,
  googleAdsProjectSchema,
  googleAdsSelectCustomerSchema,
} from "@/types/schemas/google-ads";

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

// The analytics and sync services are never invoked here; mocking them keeps
// their repository and database module graphs out of the import entirely.
vi.mock("@/server/features/google-ads/services/GoogleAdsSyncService", () => ({
  GoogleAdsSyncService: { runSync: vi.fn() },
}));

vi.mock(
  "@/server/features/google-ads/services/GoogleAdsAnalyticsService",
  () => ({
    getCampaigns: vi.fn(),
    getAdGroups: vi.fn(),
    getKeywords: vi.fn(),
    getSearchTerms: vi.fn(),
    getDevices: vi.fn(),
    getLandingPages: vi.fn(),
    getOverview: vi.fn(),
    getSyncState: vi.fn(),
  }),
);

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
  disconnectGoogleAds,
  discoverGoogleAdsCustomers,
  getGoogleAdsAdGroups,
  getGoogleAdsCampaigns,
  getGoogleAdsConnectionStatus,
  getGoogleAdsDevices,
  getGoogleAdsGrantStatus,
  getGoogleAdsKeywords,
  getGoogleAdsLandingPages,
  getGoogleAdsOverview,
  getGoogleAdsSearchTerms,
  getGoogleAdsSyncStatus,
  googleAdsProjectScope,
  listGoogleAdsManagerChildren,
  selectGoogleAdsCustomer,
  startSelfHostedGoogleAdsLink,
  testGoogleAdsConnection,
  triggerGoogleAdsSync,
} from "./google-ads";
import { globalServerFunctionMiddleware } from "./middleware";

type ServerFunction = {
  method: string;
  __executeServer(input: {
    method: "POST" | "GET";
    data: unknown;
    context: Record<string, never>;
  }): Promise<unknown>;
};

/** The server-function harness answers with the handler result or the
 *  translated error. */
const serverFunctionResultSchema = z.object({
  result: z.unknown().optional(),
  error: z.unknown().optional(),
});

type StartStorage = AsyncLocalStorage<{
  getRouter: () => never;
  request: Request;
  startOptions: { functionMiddleware: typeof globalServerFunctionMiddleware };
  contextAfterGlobalMiddlewares: Record<string, never>;
  executedRequestMiddlewares: Set<unknown>;
  handlerType: "serverFn";
}>;

const PROJECT_ID = "project-1";
const CUSTOMER_ID = "4897513260";
const MANAGER_ID = "3216549870";

async function executeServerFunction(
  serverFunction: ServerFunction,
  data: unknown,
  method: "POST" | "GET" = "POST",
) {
  const storage = (
    globalThis as typeof globalThis & {
      [key: symbol]: StartStorage | undefined;
    }
  )[Symbol.for("tanstack-start:start-storage-context")];

  if (!storage) throw new Error("TanStack Start test context is unavailable");

  return storage.run(
    {
      getRouter: () => {
        throw new Error("Router is not used by this server-function test");
      },
      request: new Request("https://openseo.test/_server", {
        method: "POST",
      }),
      startOptions: { functionMiddleware: globalServerFunctionMiddleware },
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      handlerType: "serverFn",
    },
    () => serverFunction.__executeServer({ method, data, context: {} }),
  );
}

beforeEach(() => {
  mocks.resolveUser.mockResolvedValue({
    userId: "user-1",
    userEmail: "owner@example.com",
    emailVerified: true,
    organizationId: "organization-1",
  });
  mocks.projectLookup.mockImplementation((projectId: string) =>
    projectId === PROJECT_ID
      ? { id: PROJECT_ID, organizationId: "organization-1" }
      : null,
  );
  mocks.getConnection.mockResolvedValue(null);
  mocks.userHasGrant.mockResolvedValue(false);
  mocks.disconnect.mockResolvedValue(undefined);
  mocks.selectCustomer.mockResolvedValue({
    customerId: CUSTOMER_ID,
    customerDisplayName: "Client store",
    loginCustomerId: null,
    currencyCode: "EUR",
    timeZone: null,
    isTestAccount: false,
  });
  mocks.testConnection.mockResolvedValue({
    ok: false,
    errorClass: "NOT_CONNECTED",
    message: "Google Ads is not connected for this project.",
    retryable: false,
  });
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
  mocks.getPublicOrigin.mockReturnValue("https://openseo.test");
});

describe("Google Ads server-function project authorization", () => {
  it.each([
    ["getGoogleAdsConnectionStatus", getGoogleAdsConnectionStatus, {}],
    ["discoverGoogleAdsCustomers", discoverGoogleAdsCustomers, {}],
    [
      "listGoogleAdsManagerChildren",
      listGoogleAdsManagerChildren,
      { grantAccountId: "google-sub-1", managerId: MANAGER_ID },
    ],
    [
      "selectGoogleAdsCustomer",
      selectGoogleAdsCustomer,
      { grantAccountId: "google-sub-1", customerId: CUSTOMER_ID },
    ],
    ["testGoogleAdsConnection", testGoogleAdsConnection, {}],
    ["disconnectGoogleAds", disconnectGoogleAds, {}],
    ["startSelfHostedGoogleAdsLink", startSelfHostedGoogleAdsLink, {}],
    ["triggerGoogleAdsSync", triggerGoogleAdsSync, {}],
    ["getGoogleAdsSyncStatus", getGoogleAdsSyncStatus, {}],
    ["getGoogleAdsOverview", getGoogleAdsOverview, {}],
    ["getGoogleAdsCampaigns", getGoogleAdsCampaigns, {}],
    ["getGoogleAdsAdGroups", getGoogleAdsAdGroups, {}],
    ["getGoogleAdsKeywords", getGoogleAdsKeywords, {}],
    ["getGoogleAdsSearchTerms", getGoogleAdsSearchTerms, {}],
    ["getGoogleAdsDevices", getGoogleAdsDevices, {}],
    ["getGoogleAdsLandingPages", getGoogleAdsLandingPages, {}],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, extra) => {
      const result = await executeServerFunction(fn, {
        projectId: "other-project",
        ...extra,
      });

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
      expect(mocks.selectCustomer).not.toHaveBeenCalled();
      expect(mocks.disconnect).not.toHaveBeenCalled();
      expect(mocks.testConnection).not.toHaveBeenCalled();
      expect(mocks.getConnection).not.toHaveBeenCalled();
      expect(mocks.discoverAccessibleCustomers).not.toHaveBeenCalled();
      expect(mocks.listManagerChildren).not.toHaveBeenCalled();
      expect(mocks.createAuthorizationUrl).not.toHaveBeenCalled();
    },
  );
});

describe("Google Ads server-function input validation", () => {
  it("rejects a payload that tries to set the organization or the user", async () => {
    const result = await executeServerFunction(selectGoogleAdsCustomer, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
      customerId: CUSTOMER_ID,
      organizationId: "other-organization",
      userId: "other-user",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
    expect(mocks.selectCustomer).not.toHaveBeenCalled();
  });

  it("rejects a payload carrying a raw token", async () => {
    const result = await executeServerFunction(discoverGoogleAdsCustomers, {
      projectId: PROJECT_ID,
      accessToken: "ya29.secret-token",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
    expect(mocks.discoverAccessibleCustomers).not.toHaveBeenCalled();
  });

  it("rejects a malformed customer id", async () => {
    const result = await executeServerFunction(selectGoogleAdsCustomer, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
      customerId: "12345",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
    expect(mocks.selectCustomer).not.toHaveBeenCalled();
  });

  it("rejects a malformed manager id", async () => {
    const result = await executeServerFunction(listGoogleAdsManagerChildren, {
      projectId: PROJECT_ID,
      grantAccountId: "google-sub-1",
      managerId: "not-a-customer",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
    expect(mocks.listManagerChildren).not.toHaveBeenCalled();
  });

  it("rejects a one-sided analytics window", async () => {
    const result = await executeServerFunction(getGoogleAdsOverview, {
      projectId: PROJECT_ID,
      startDate: "2026-10-01",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
    expect(mocks.getConnection).not.toHaveBeenCalled();
  });

  it("rejects a window that exceeds the 37-month cap", async () => {
    const result = await executeServerFunction(getGoogleAdsCampaigns, {
      projectId: PROJECT_ID,
      startDate: "2020-01-01",
      endDate: "2026-10-01",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
  });

  it("rejects a calendar date that does not exist", async () => {
    const result = await executeServerFunction(getGoogleAdsOverview, {
      projectId: PROJECT_ID,
      startDate: "2026-02-30",
      endDate: "2026-03-01",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
  });

  it("rejects combining the exact and fuzzy search terms", async () => {
    const result = await executeServerFunction(getGoogleAdsSearchTerms, {
      projectId: PROJECT_ID,
      searchText: "red shoes",
      searchTextLike: "%red%",
    });

    expect(result).toMatchObject({ error: new Error("VALIDATION_ERROR") });
  });
});

describe("Google Ads server-function trusted context", () => {
  // Positive handler execution is proven behaviorally in
  // google-ads.execution.test.ts, which runs the real middleware chain and
  // handlers. Here the structural invariants stay asserted: no schema ever
  // carries the organization, the user or a token.
  const schemas = [
    googleAdsProjectSchema,
    googleAdsDiscoverySchema,
    googleAdsManagerChildrenSchema,
    googleAdsSelectCustomerSchema,
    googleAdsConnectionTestSchema,
    googleAdsDisconnectSchema,
    googleAdsLinkSchema,
  ];

  it("never accepts the organization, the user or a token from client input", () => {
    for (const schema of schemas) {
      expect("organizationId" in schema.shape).toBe(false);
      expect("userId" in schema.shape).toBe(false);
      expect("accessToken" in schema.shape).toBe(false);
      expect("refreshToken" in schema.shape).toBe(false);
    }
  });

  it("builds the action scope from the trusted context alone", () => {
    expect(
      googleAdsProjectScope({
        projectId: PROJECT_ID,
        organizationId: "organization-1",
        userId: "user-1",
      }),
    ).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      userId: "user-1",
    });
    // The scope carries nothing but the trusted identifiers.
    expect(
      Object.keys(
        googleAdsProjectScope({
          projectId: PROJECT_ID,
          organizationId: "organization-1",
          userId: "user-1",
        }),
      ).toSorted(),
    ).toEqual(["organizationId", "projectId", "userId"]);
  });
});

describe("Google Ads server-function transport", () => {
  it("uses POST for every explicit remote action and GET for the grant status", () => {
    for (const fn of [
      getGoogleAdsConnectionStatus,
      discoverGoogleAdsCustomers,
      listGoogleAdsManagerChildren,
      selectGoogleAdsCustomer,
      testGoogleAdsConnection,
      disconnectGoogleAds,
      startSelfHostedGoogleAdsLink,
      triggerGoogleAdsSync,
      getGoogleAdsSyncStatus,
      getGoogleAdsOverview,
      getGoogleAdsCampaigns,
      getGoogleAdsAdGroups,
      getGoogleAdsKeywords,
      getGoogleAdsSearchTerms,
      getGoogleAdsDevices,
      getGoogleAdsLandingPages,
    ]) {
      expect(fn.method).toBe("POST");
    }
    expect(getGoogleAdsGrantStatus.method).toBe("GET");
  });

  it("resolves the grant status without a project context", async () => {
    const result = serverFunctionResultSchema.parse(
      await executeServerFunction(getGoogleAdsGrantStatus, undefined, "GET"),
    );

    expect(result.error).toBeUndefined();
    expect(mocks.projectLookup).not.toHaveBeenCalled();
  });
});
