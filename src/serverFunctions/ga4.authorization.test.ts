import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
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

vi.mock("@/server/features/ga4/services/Ga4Service", () => ({
  Ga4Service: {
    getConnection: vi.fn(),
    userHasGrant: vi.fn(),
    listPropertiesForUser: vi.fn(),
    setProperty: vi.fn(),
    disconnect: vi.fn(),
    runReportForConnection: vi.fn(),
    getPeriodUsers: vi.fn(),
  },
}));

vi.mock("@/server/features/ga4/services/Ga4SyncService", () => ({
  Ga4SyncService: { runSync: vi.fn() },
}));

vi.mock("@/server/features/ga4/services/Ga4GoalService", () => ({
  Ga4GoalService: {
    createGoal: vi.fn(),
    listGoals: vi.fn(),
    getGoal: vi.fn(),
    updateGoal: vi.fn(),
    archiveGoal: vi.fn(),
    getGoalConversions: vi.fn(),
  },
}));

vi.mock("@/server/features/ga4/repositories/Ga4SyncRepository", () => ({
  Ga4SyncRepository: {
    getLatestSyncRun: vi.fn(),
    getActiveSyncRun: vi.fn(),
    getLastFullyCoveredDate: vi.fn(),
  },
}));

vi.mock("@/server/features/gsc/selfHostedOAuth", () => ({
  createSelfHostedGa4AuthorizationUrl: vi.fn(),
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
  archiveGa4Goal,
  createGa4Goal,
  disconnectGa4,
  getAnalyticsAcquisition,
  getAnalyticsAudience,
  getAnalyticsConversions,
  getAnalyticsEcommerce,
  getAnalyticsEvents,
  getAnalyticsLandingPages,
  getAnalyticsOverview,
  getGa4Connection,
  getGa4SyncStatus,
  getPeriodUsers,
  listGa4Goals,
  listGa4Properties,
  setGa4Property,
  startSelfHostedGa4Link,
  triggerGa4Sync,
  updateGa4Goal,
} from "./ga4";
import { globalServerFunctionMiddleware } from "./middleware";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, string>;
    context: Record<string, never>;
  }): Promise<unknown>;
};

type StartStorage = AsyncLocalStorage<{
  getRouter: () => never;
  request: Request;
  startOptions: { functionMiddleware: typeof globalServerFunctionMiddleware };
  contextAfterGlobalMiddlewares: Record<string, never>;
  executedRequestMiddlewares: Set<unknown>;
  handlerType: "serverFn";
}>;

async function executeServerFunction(
  serverFunction: ServerFunction,
  data: Record<string, string>,
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
    () => serverFunction.__executeServer({ method: "POST", data, context: {} }),
  );
}

describe("GA4 server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
  });

  it.each([
    ["getGa4Connection", getGa4Connection, { projectId: "other-project" }],
    ["listGa4Properties", listGa4Properties, { projectId: "other-project" }],
    [
      "setGa4Property",
      setGa4Property,
      {
        projectId: "other-project",
        accountId: "google-account",
        propertyId: "property-1",
      },
    ],
    ["disconnectGa4", disconnectGa4, { projectId: "other-project" }],
    [
      "startSelfHostedGa4Link",
      startSelfHostedGa4Link,
      {
        projectId: "other-project",
        callbackURL: "/p/other-project/settings",
      },
    ],
    ["triggerGa4Sync", triggerGa4Sync, { projectId: "other-project" }],
    ["getGa4SyncStatus", getGa4SyncStatus, { projectId: "other-project" }],
    [
      "getPeriodUsers",
      getPeriodUsers,
      {
        projectId: "other-project",
        startDate: "2025-01-01",
        endDate: "2025-01-31",
      },
    ],
    [
      "getAnalyticsOverview",
      getAnalyticsOverview,
      { projectId: "other-project" },
    ],
    [
      "getAnalyticsAcquisition",
      getAnalyticsAcquisition,
      { projectId: "other-project" },
    ],
    [
      "getAnalyticsLandingPages",
      getAnalyticsLandingPages,
      { projectId: "other-project" },
    ],
    ["getAnalyticsEvents", getAnalyticsEvents, { projectId: "other-project" }],
    [
      "getAnalyticsConversions",
      getAnalyticsConversions,
      { projectId: "other-project" },
    ],
    [
      "getAnalyticsEcommerce",
      getAnalyticsEcommerce,
      { projectId: "other-project" },
    ],
    [
      "getAnalyticsAudience",
      getAnalyticsAudience,
      { projectId: "other-project" },
    ],
    [
      "createGa4Goal",
      createGa4Goal,
      {
        projectId: "other-project",
        name: "Signup",
        eventName: "signup_completed",
      },
    ],
    ["listGa4Goals", listGa4Goals, { projectId: "other-project" }],
    [
      "updateGa4Goal",
      updateGa4Goal,
      { projectId: "other-project", id: "goal-1", name: "Renamed" },
    ],
    [
      "archiveGa4Goal",
      archiveGa4Goal,
      { projectId: "other-project", id: "goal-1" },
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    },
  );
});
