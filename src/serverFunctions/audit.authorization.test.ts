import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  startAudit: vi.fn(),
  cancelAudit: vi.fn(),
  getAuditStatus: vi.fn(),
  getAuditResults: vi.fn(),
  getAuditHistory: vi.fn(),
  getCrawlProgress: vi.fn(),
  deleteAudit: vi.fn(),
  getPageSchema: vi.fn(),
  getInternalLinkingReport: vi.fn(),
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

vi.mock("@/server/features/audit/services/SchemaService", () => ({
  SchemaService: { getPageSchema: mocks.getPageSchema },
}));

vi.mock("@/server/features/audit/services/InternalLinkingService", () => ({
  InternalLinkingService: {
    getReport: mocks.getInternalLinkingReport,
  },
}));

vi.mock("@/server/features/audit/services/AuditService", () => ({
  AuditService: {
    startAudit: mocks.startAudit,
    cancelAudit: mocks.cancelAudit,
    getStatus: mocks.getAuditStatus,
    getResults: mocks.getAuditResults,
    getHistory: mocks.getAuditHistory,
    getCrawlProgress: mocks.getCrawlProgress,
    remove: mocks.deleteAudit,
    resolveAuditLimitTier: vi.fn().mockResolvedValue("paid"),
  },
}));

import {
  cancelAudit,
  deleteAudit,
  getAuditHistory,
  getAuditPageSchema,
  getAuditResults,
  getAuditStatus,
  getCrawlProgress,
  getInternalLinkingReport,
  startAudit,
} from "./audit";
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

describe("audit server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.startAudit.mockReset();
    mocks.cancelAudit.mockReset();
    mocks.getAuditStatus.mockReset();
    mocks.getAuditResults.mockReset();
    mocks.getAuditHistory.mockReset();
    mocks.getCrawlProgress.mockReset();
    mocks.deleteAudit.mockReset();
    mocks.getPageSchema.mockReset();
    mocks.getInternalLinkingReport.mockReset();
  });

  it.each([
    ["cancelAudit", cancelAudit, { projectId: "other-project", auditId: "a1" }],
    ["deleteAudit", deleteAudit, { projectId: "other-project", auditId: "a1" }],
    [
      "getAuditStatus",
      getAuditStatus,
      { projectId: "other-project", auditId: "a1" },
    ],
    [
      "getAuditResults",
      getAuditResults,
      { projectId: "other-project", auditId: "a1" },
    ],
    ["getAuditHistory", getAuditHistory, { projectId: "other-project" }],
    [
      "getAuditPageSchema",
      getAuditPageSchema,
      { projectId: "other-project", auditId: "a1", pageId: "p1" },
    ],
    [
      "getInternalLinkingReport",
      getInternalLinkingReport,
      { projectId: "other-project", auditId: "a1" },
    ],
    [
      "getCrawlProgress",
      getCrawlProgress,
      { projectId: "other-project", auditId: "a1" },
    ],
    [
      "startAudit",
      startAudit,
      {
        projectId: "other-project",
        startUrl: "https://example.com",
        maxPages: 50,
      },
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
      expect(mocks.startAudit).not.toHaveBeenCalled();
      expect(mocks.cancelAudit).not.toHaveBeenCalled();
      expect(mocks.getAuditStatus).not.toHaveBeenCalled();
      expect(mocks.getAuditResults).not.toHaveBeenCalled();
      expect(mocks.getAuditHistory).not.toHaveBeenCalled();
      expect(mocks.getCrawlProgress).not.toHaveBeenCalled();
      expect(mocks.deleteAudit).not.toHaveBeenCalled();
      expect(mocks.getPageSchema).not.toHaveBeenCalled();
      expect(mocks.getInternalLinkingReport).not.toHaveBeenCalled();
    },
  );

  it("keeps the cancel audit call behind the project lookup", async () => {
    // The TanStack Start plugin is not active under vitest, so the compiled
    // handler never runs here: the project-scope check in the middleware is
    // the observable contract. Service behaviour is covered by
    // AuditService.cancel.test.ts.
    mocks.projectLookup.mockResolvedValue({
      id: "project-1",
      organizationId: "organization-1",
      domain: null,
    });

    await executeServerFunction(cancelAudit, {
      projectId: "project-1",
      auditId: "a1",
    });

    expect(mocks.projectLookup).toHaveBeenCalledWith(
      "project-1",
      "organization-1",
    );
  });
});
