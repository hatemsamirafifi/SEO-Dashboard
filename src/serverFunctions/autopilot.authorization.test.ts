import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  startAutopilotRun: vi.fn(),
  getAutopilotRun: vi.fn(),
  listAutopilotRuns: vi.fn(),
  cancelAutopilotRun: vi.fn(),
  resumeAutopilotRun: vi.fn(),
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

vi.mock("@/server/features/autopilot/services/AutopilotService", () => ({
  AutopilotService: {
    startAutopilotRun: mocks.startAutopilotRun,
    getAutopilotRun: mocks.getAutopilotRun,
    listAutopilotRuns: mocks.listAutopilotRuns,
    cancelAutopilotRun: mocks.cancelAutopilotRun,
    resumeAutopilotRun: mocks.resumeAutopilotRun,
  },
}));

import {
  cancelAutopilotRun,
  getAutopilotRun,
  listAutopilotRuns,
  resumeAutopilotRun,
  startAutopilotRun,
} from "./autopilot";
import { globalServerFunctionMiddleware } from "./middleware";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, unknown>;
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
  data: Record<string, unknown>,
) {
  const storage = (
    globalThis as typeof globalThis & {
      [key: symbol]: StartStorage | undefined;
    }
  )[Symbol.for("tanstack-start:start-storage-context")];

  if (!storage) throw new Error("TanStack Start context is unavailable");

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

describe("autopilot server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.startAutopilotRun.mockReset();
    mocks.getAutopilotRun.mockReset();
    mocks.listAutopilotRuns.mockReset();
    mocks.cancelAutopilotRun.mockReset();
    mocks.resumeAutopilotRun.mockReset();
  });

  it.each([
    [
      "startAutopilotRun",
      startAutopilotRun,
      { projectId: "other-project", workflowType: "growth-plan" },
    ],
    [
      "getAutopilotRun",
      getAutopilotRun,
      { projectId: "other-project", runId: "run-1" },
    ],
    ["listAutopilotRuns", listAutopilotRuns, { projectId: "other-project" }],
    [
      "cancelAutopilotRun",
      cancelAutopilotRun,
      { projectId: "other-project", runId: "run-1" },
    ],
    [
      "resumeAutopilotRun",
      resumeAutopilotRun,
      { projectId: "other-project", runId: "run-1" },
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
      expect(mocks.startAutopilotRun).not.toHaveBeenCalled();
      expect(mocks.getAutopilotRun).not.toHaveBeenCalled();
      expect(mocks.listAutopilotRuns).not.toHaveBeenCalled();
      expect(mocks.cancelAutopilotRun).not.toHaveBeenCalled();
      expect(mocks.resumeAutopilotRun).not.toHaveBeenCalled();
    },
  );
});
