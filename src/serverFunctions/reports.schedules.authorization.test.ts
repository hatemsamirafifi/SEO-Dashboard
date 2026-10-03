import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  createSchedule: vi.fn(),
  updateSchedule: vi.fn(),
  pauseSchedule: vi.fn(),
  resumeSchedule: vi.fn(),
  listSchedules: vi.fn(),
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

vi.mock("@/server/features/reports/services/ReportScheduleService", () => ({
  ReportScheduleService: {
    createSchedule: mocks.createSchedule,
    updateSchedule: mocks.updateSchedule,
    pauseSchedule: mocks.pauseSchedule,
    resumeSchedule: mocks.resumeSchedule,
    listSchedules: mocks.listSchedules,
  },
}));

// oxlint-disable-next-line import/first -- mocks must load before the fns under test
import {
  createReportSchedule,
  listReportSchedules,
  pauseReportSchedule,
  resumeReportSchedule,
  updateReportSchedule,
} from "./reports";
import { globalServerFunctionMiddleware } from "./middleware";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, string | string[]>;
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
  data: Record<string, string | string[]>,
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

describe("report schedules server-function project authorization (spec 012)", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    // Unknown project for this organization: every schedule fn must reject
    // before reaching the service layer.
    mocks.projectLookup.mockResolvedValue(null);
    for (const mock of [
      mocks.createSchedule,
      mocks.updateSchedule,
      mocks.pauseSchedule,
      mocks.resumeSchedule,
      mocks.listSchedules,
    ]) {
      mock.mockReset();
    }
  });

  it.each([
    [
      "createReportSchedule",
      createReportSchedule,
      {
        projectId: "other-project",
        reportType: "overview",
        cadence: "weekly",
        recipients: ["owner@example.com"],
      },
    ],
    [
      "updateReportSchedule",
      updateReportSchedule,
      { projectId: "other-project", id: "sched-1", cadence: "monthly" },
    ],
    [
      "pauseReportSchedule",
      pauseReportSchedule,
      { projectId: "other-project", id: "sched-1" },
    ],
    [
      "resumeReportSchedule",
      resumeReportSchedule,
      { projectId: "other-project", id: "sched-1" },
    ],
    [
      "listReportSchedules",
      listReportSchedules,
      { projectId: "other-project" },
    ],
  ])("%s rejects cross-project access", async (_name, fn, data) => {
    // Fails until T013 exports the five schedule functions from ./reports.
    expect(typeof fn).toBe("function");
    // House pattern (ga4.authorization.test.ts): middleware rejections arrive
    // as a resolved error envelope, not a thrown rejection.
    const result = await executeServerFunction(fn, data);
    expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    expect(mocks.createSchedule).not.toHaveBeenCalled();
    expect(mocks.updateSchedule).not.toHaveBeenCalled();
    expect(mocks.pauseSchedule).not.toHaveBeenCalled();
    expect(mocks.resumeSchedule).not.toHaveBeenCalled();
    expect(mocks.listSchedules).not.toHaveBeenCalled();
  });

  it("rejects unauthenticated access before the service layer", async () => {
    mocks.resolveUser.mockResolvedValue(null);
    const result = await executeServerFunction(listReportSchedules, {
      projectId: "project-1",
    });
    expect(result).toHaveProperty("error");
    expect(mocks.listSchedules).not.toHaveBeenCalled();
  });
});
