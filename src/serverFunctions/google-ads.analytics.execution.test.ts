import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn<(projectId: string) => unknown>(),
  resolveUser: vi.fn<() => unknown>(),
  getConnection: vi.fn<() => unknown>(),
  runSync: vi.fn<(input: unknown) => unknown>(),
  getSyncState: vi.fn<(scope: unknown) => unknown>(),
  getOverview: vi.fn<(input: { scope: unknown; window: unknown }) => unknown>(),
  getCampaigns:
    vi.fn<(input: { scope: unknown; window: unknown }) => unknown>(),
  getAdGroups: vi.fn<(input: { scope: unknown; window: unknown }) => unknown>(),
  getKeywords: vi.fn<(input: { scope: unknown; window: unknown }) => unknown>(),
  getSearchTerms:
    vi.fn<
      (input: { scope: unknown; window: unknown }, options: unknown) => unknown
    >(),
  getDevices:
    vi.fn<
      (input: { scope: unknown; window: unknown }, options: unknown) => unknown
    >(),
  getLandingPages:
    vi.fn<
      (input: { scope: unknown; window: unknown }, options: unknown) => unknown
    >(),
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
    userHasGrant: vi.fn(),
    selectCustomer: vi.fn(),
    testConnection: vi.fn(),
    disconnect: vi.fn(),
  },
}));

vi.mock("@/server/features/google-ads/services/googleAdsDiscovery", () => ({
  discoverAccessibleCustomers: vi.fn(),
  listManagerChildren: vi.fn(),
}));

vi.mock("@/server/features/google-ads/services/GoogleAdsSyncService", () => ({
  GoogleAdsSyncService: { runSync: mocks.runSync },
}));

vi.mock(
  "@/server/features/google-ads/services/GoogleAdsAnalyticsService",
  () => ({
    getOverview: mocks.getOverview,
    getSyncState: mocks.getSyncState,
    getCampaigns: mocks.getCampaigns,
    getAdGroups: mocks.getAdGroups,
    getKeywords: mocks.getKeywords,
    getSearchTerms: mocks.getSearchTerms,
    getDevices: mocks.getDevices,
    getLandingPages: mocks.getLandingPages,
  }),
);

vi.mock("@/server/features/gsc/selfHostedOAuth", () => ({
  createSelfHostedGoogleAdsAuthorizationUrl: vi.fn(),
}));

vi.mock("@/server/features/gsc/oauth-config", () => ({
  hasSelfHostedGscConfig: vi.fn(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn(),
}));

vi.mock("@/server/mcp/public-origin", () => ({
  getPublicOrigin: vi.fn(),
}));

import {
  getGoogleAdsAdGroups,
  getGoogleAdsCampaigns,
  getGoogleAdsDevices,
  getGoogleAdsKeywords,
  getGoogleAdsLandingPages,
  getGoogleAdsOverview,
  getGoogleAdsSearchTerms,
  getGoogleAdsSyncStatus,
  triggerGoogleAdsSync,
} from "./google-ads";
import { executeServerFunction } from "./googleAdsServerFnHarness";

/* Positive behavioral suite for the stored analytics + durable sync server
 * functions: every handler is executed for real, through the global
 * ensure-user middleware, the project authorization, the Zod validators and
 * the function-level middleware - all unmocked. The mocks only replace the
 * downstream service modules. */

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
  context?: unknown;
};

function isServerFnExecution(value: unknown): value is ServerFnExecution {
  return typeof value === "object" && value !== null && "result" in value;
}

function firstCallArg(mock: { mock: { calls: unknown[][] } }): unknown {
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

function rollingDefaultWindow() {
  const endDate = new Date().toISOString().slice(0, 10);
  const startDate = new Date(Date.now() - 27 * 24 * 60 * 60 * 1000)
    .toISOString()
    .slice(0, 10);
  return { startDate, endDate };
}

beforeEach(() => {
  mocks.resolveUser.mockResolvedValue(AUTH_CONTEXT);
  mocks.projectLookup.mockImplementation((projectId: string) =>
    projectId === PROJECT_ID
      ? { id: PROJECT_ID, organizationId: "organization-1" }
      : null,
  );
  mocks.getConnection.mockResolvedValue(null);
  mocks.runSync.mockResolvedValue({
    ok: true,
    status: "success",
    mode: "manual",
    startDate: "2026-10-01",
    endDate: "2026-10-07",
    unitsPlanned: 7,
    unitsSucceeded: 7,
    unitsFailed: 0,
    alreadyRunning: false,
  });
  mocks.getSyncState.mockResolvedValue({ lastRun: null });
  mocks.getOverview.mockResolvedValue({ totals: { impressions: 42 } });
  for (const breakdown of [
    mocks.getCampaigns,
    mocks.getAdGroups,
    mocks.getKeywords,
    mocks.getSearchTerms,
    mocks.getDevices,
    mocks.getLandingPages,
  ]) {
    breakdown.mockResolvedValue({ rows: [] });
  }
});

describe("Google Ads analytics + sync server functions", () => {
  const CONNECTED_CONNECTION = {
    id: "connection-1",
    customerId: CUSTOMER_ID,
    customerDisplayName: "Client store",
  };

  it("trigger returns the disconnected envelope and never syncs", async () => {
    const { result, error } = await run(triggerGoogleAdsSync, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: false });
    expect(mocks.runSync).not.toHaveBeenCalled();
  });

  it("trigger runs the sync in manual mode with the trusted scope", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(triggerGoogleAdsSync, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toMatchObject({ ok: true, status: "success" });
    const call = firstCallArg(mocks.runSync);
    expect(call).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      mode: "manual",
    });
    expect(sortedKeys(call)).toEqual(["mode", "organizationId", "projectId"]);
  });

  it("trigger passes an explicit backfill window to the sync service", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { error } = await run(triggerGoogleAdsSync, {
      projectId: PROJECT_ID,
      startDate: "2026-10-01",
      endDate: "2026-10-07",
    });

    expect(error).toBeUndefined();
    expect(firstCallArg(mocks.runSync)).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      mode: "manual",
      startDate: "2026-10-01",
      endDate: "2026-10-07",
    });
  });

  it("sync status answers the disconnected envelope database-only", async () => {
    const { result, error } = await run(getGoogleAdsSyncStatus, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: false, syncState: null });
    expect(mocks.getSyncState).not.toHaveBeenCalled();
  });

  it("sync status reads the durable ledger for the connected customer", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(getGoogleAdsSyncStatus, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connected: true,
      syncState: { lastRun: null },
    });
    expect(firstCallArg(mocks.getSyncState)).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      customerId: CUSTOMER_ID,
    });
  });

  it("overview answers the disconnected envelope without reading facts", async () => {
    const { result, error } = await run(getGoogleAdsOverview, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: false, overview: null });
    expect(mocks.getOverview).not.toHaveBeenCalled();
  });

  it("overview defaults to the rolling 28-day window server-side", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(getGoogleAdsOverview, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({
      connected: true,
      overview: { totals: { impressions: 42 } },
    });
    const call = firstCallArg(mocks.getOverview);
    expect(call).toEqual({
      scope: {
        projectId: PROJECT_ID,
        organizationId: "organization-1",
        customerId: CUSTOMER_ID,
      },
      window: rollingDefaultWindow(),
      // The overview always computes the preceding equal-length window
      // comparison for the UI's period-over-period cards.
      compare: true,
    });
  });

  it("overview passes an explicit window through untouched", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    await run(getGoogleAdsOverview, {
      projectId: PROJECT_ID,
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });

    expect(mocks.getOverview.mock.calls[0]?.[0]?.window).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-30",
    });
  });

  it("campaigns reads the breakdown behind the connected envelope", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(getGoogleAdsCampaigns, {
      projectId: PROJECT_ID,
      startDate: "2026-10-01",
      endDate: "2026-10-07",
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: true, breakdown: { rows: [] } });
    expect(firstCallArg(mocks.getCampaigns)).toEqual({
      scope: {
        projectId: PROJECT_ID,
        organizationId: "organization-1",
        customerId: CUSTOMER_ID,
      },
      window: { startDate: "2026-10-01", endDate: "2026-10-07" },
    });
  });

  it("breakdowns answer the disconnected envelope without reading facts", async () => {
    const { result, error } = await run(getGoogleAdsAdGroups, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: false, breakdown: null });
    expect(mocks.getAdGroups).not.toHaveBeenCalled();
  });

  it("search terms carry the search options to the service", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    await run(getGoogleAdsSearchTerms, {
      projectId: PROJECT_ID,
      searchTextLike: "%red%",
    });

    const call = mocks.getSearchTerms.mock.calls[0];
    expect(call?.[0]?.window).toEqual(rollingDefaultWindow());
    expect(call?.[1]).toEqual({ searchTextLike: "%red%" });
  });

  it("devices pass the campaign filter only when the payload carries one", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    await run(getGoogleAdsDevices, {
      projectId: PROJECT_ID,
      campaignResourceId: "campaign-1",
    });

    expect(mocks.getDevices.mock.calls[0]?.[1]).toEqual({
      campaignResourceId: "campaign-1",
    });

    await run(getGoogleAdsDevices, { projectId: PROJECT_ID });

    expect(mocks.getDevices.mock.calls[1]?.[1]).toEqual({});
  });

  it("landing pages sit behind the same envelope and filter plumbing", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(getGoogleAdsLandingPages, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: true, breakdown: { rows: [] } });
    expect(mocks.getCampaigns).not.toHaveBeenCalled();
    expect(mocks.getLandingPages).toHaveBeenCalledTimes(1);
  });

  it("keywords run through the same connected envelope", async () => {
    mocks.getConnection.mockResolvedValue(CONNECTED_CONNECTION);
    const { result, error } = await run(getGoogleAdsKeywords, {
      projectId: PROJECT_ID,
    });

    expect(error).toBeUndefined();
    expect(result).toEqual({ connected: true, breakdown: { rows: [] } });
    expect(mocks.getKeywords.mock.calls[0]?.[0]?.scope).toEqual({
      projectId: PROJECT_ID,
      organizationId: "organization-1",
      customerId: CUSTOMER_ID,
    });
  });
});
