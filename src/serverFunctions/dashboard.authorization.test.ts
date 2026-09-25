import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  getDashboardInsights: vi.fn(),
  dismissInsight: vi.fn(),
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

vi.mock(
  "@/server/features/intelligence/services/InsightService",
  () => ({
    InsightService: {
      getDashboardInsights: mocks.getDashboardInsights,
      dismissInsight: mocks.dismissInsight,
    },
  }),
);

vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: vi.fn() },
}));

import { dismissInsight, getDashboardInsights } from "./dashboard";
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

describe("dashboard insights server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.getDashboardInsights.mockReset();
    mocks.dismissInsight.mockReset();
  });

  it.each([
    ["getDashboardInsights", getDashboardInsights, { projectId: "other-project" }],
    [
      "dismissInsight",
      dismissInsight,
      { projectId: "other-project", insightKey: "dashboard:ranking_drop" },
    ],
  ])("rejects wrong-organization access before %s runs", async (_name, fn, data) => {
    const result = await executeServerFunction(fn, data);

    expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    expect(mocks.getDashboardInsights).not.toHaveBeenCalled();
    expect(mocks.dismissInsight).not.toHaveBeenCalled();
  });
});
