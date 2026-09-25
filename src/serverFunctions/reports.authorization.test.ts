import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  listReports: vi.fn(),
  generateReport: vi.fn(),
  getReport: vi.fn(),
  deleteReport: vi.fn(),
  createReportShare: vi.fn(),
  getReportShares: vi.fn(),
  revokeReportShare: vi.fn(),
  requestExport: vi.fn(),
  getExportStatus: vi.fn(),
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

vi.mock("@/server/features/reports/services/ReportService", () => ({
  ReportService: {
    listReports: mocks.listReports,
    generateReport: mocks.generateReport,
    getReport: mocks.getReport,
    deleteReport: mocks.deleteReport,
  },
}));

vi.mock("@/server/features/reports/services/ShareService", () => ({
  ShareService: {
    createReportShare: mocks.createReportShare,
    listReportShares: mocks.getReportShares,
    revokeReportShare: mocks.revokeReportShare,
  },
}));

vi.mock("@/server/features/reports/services/ExportService", () => ({
  ExportService: {
    requestExport: mocks.requestExport,
    getExportStatus: mocks.getExportStatus,
  },
}));

import {
  createReportShare,
  deleteReport,
  exportReportPdf,
  generateReport,
  getExportStatus,
  getReport,
  getReportShares,
  listReports,
  revokeReportShare,
} from "./reports";
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

describe("reports server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.listReports.mockReset();
    mocks.generateReport.mockReset();
    mocks.getReport.mockReset();
    mocks.deleteReport.mockReset();
    mocks.createReportShare.mockReset();
    mocks.getReportShares.mockReset();
    mocks.revokeReportShare.mockReset();
    mocks.requestExport.mockReset();
    mocks.getExportStatus.mockReset();
  });

  it.each([
    ["listReports", listReports, { projectId: "other-project" }],
    [
      "generateReport",
      generateReport,
      {
        projectId: "other-project",
        type: "overview",
        period: { from: "2026-01-01", to: "2026-01-14" },
      },
    ],
    ["getReport", getReport, { projectId: "other-project", id: "rep-1" }],
    ["deleteReport", deleteReport, { projectId: "other-project", id: "rep-1" }],
    [
      "createReportShare",
      createReportShare,
      { projectId: "other-project", reportId: "rep-1" },
    ],
    [
      "getReportShares",
      getReportShares,
      { projectId: "other-project", reportId: "rep-1" },
    ],
    [
      "revokeReportShare",
      revokeReportShare,
      { projectId: "other-project", shareId: "share-1" },
    ],
    [
      "exportReportPdf",
      exportReportPdf,
      { projectId: "other-project", reportId: "rep-1", format: "pdf" },
    ],
    [
      "getExportStatus",
      getExportStatus,
      { projectId: "other-project", reportId: "rep-1", format: "pdf" },
    ],
  ])(
    "rejects wrong-organization access before %s runs",
    async (_name, fn, data) => {
      const result = await executeServerFunction(fn, data);

      expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
      expect(mocks.listReports).not.toHaveBeenCalled();
      expect(mocks.generateReport).not.toHaveBeenCalled();
      expect(mocks.getReport).not.toHaveBeenCalled();
      expect(mocks.deleteReport).not.toHaveBeenCalled();
      expect(mocks.createReportShare).not.toHaveBeenCalled();
      expect(mocks.getReportShares).not.toHaveBeenCalled();
      expect(mocks.revokeReportShare).not.toHaveBeenCalled();
      expect(mocks.requestExport).not.toHaveBeenCalled();
      expect(mocks.getExportStatus).not.toHaveBeenCalled();
    },
  );

  it("rejects reversed periods at the validator", async () => {
    mocks.projectLookup.mockResolvedValue({
      id: "project-1",
      organizationId: "organization-1",
      domain: null,
    });
    const result = await executeServerFunction(generateReport, {
      projectId: "project-1",
      type: "overview",
      period: { from: "2026-01-14", to: "2026-01-01" },
    });
    expect(result).toHaveProperty("error");
    expect(mocks.generateReport).not.toHaveBeenCalled();
  });
});
