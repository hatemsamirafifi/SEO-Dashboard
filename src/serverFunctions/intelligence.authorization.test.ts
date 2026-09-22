import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  triggerManualScan: vi.fn(),
  getLatestRun: vi.fn(),
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

vi.mock("@/server/features/intelligence/services/FindingService", () => ({
  FindingService: {
    triggerManualScan: mocks.triggerManualScan,
  },
}));

vi.mock(
  "@/server/features/intelligence/repositories/ScanLedgerRepository",
  () => ({
    ScanLedgerRepository: {
      getLatestRun: mocks.getLatestRun,
    },
  }),
);

import {
  getIntelligenceScanStatus,
  toScanStatusResponse,
  toTriggerScanResponse,
  triggerIntelligenceScan,
} from "./intelligence";
import { globalServerFunctionMiddleware } from "./middleware";
import { runRowFixture } from "@/server/features/intelligence/intelligenceTestFixtures";

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

describe("intelligence server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.triggerManualScan.mockReset();
    mocks.getLatestRun.mockReset();
  });

  it.each([
    ["triggerIntelligenceScan", triggerIntelligenceScan],
    ["getIntelligenceScanStatus", getIntelligenceScanStatus],
  ])("rejects wrong-organization access before %s runs", async (_name, fn) => {
    const result = await executeServerFunction(fn, {
      projectId: "other-project",
    });

    expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    expect(mocks.triggerManualScan).not.toHaveBeenCalled();
    expect(mocks.getLatestRun).not.toHaveBeenCalled();
  });

  // Positive-path handler execution is not reachable through the TanStack
  // server-function test harness (handlers resolve to `{ context }`
  // without running), so response shaping is covered via the pure mappers
  // the handlers delegate to. Service wiring is covered in
  // FindingService.test.ts.
  it("shapes the trigger response for success, rate limit, deferral, and failure", () => {
    expect(
      toTriggerScanResponse({
        ok: true,
        run: runRowFixture({ findingsCount: 3 }),
        inputHash: "a".repeat(64),
        findingsCount: 3,
      }),
    ).toMatchObject({ ok: true, runId: "run-1", findingsCount: 3 });

    expect(
      toTriggerScanResponse({
        ok: false,
        rateLimited: true,
        retryAfterMs: 42_000,
      }),
    ).toMatchObject({ ok: false, rateLimited: true, retryAfterMs: 42_000 });

    expect(
      toTriggerScanResponse({
        ok: false,
        deferred: "active_mutation",
        active: ["gsc sync sync-9 is mutating"],
      }),
    ).toMatchObject({ ok: false, deferred: "active_mutation" });

    expect(
      toTriggerScanResponse({
        ok: false,
        deferred: false,
        run: runRowFixture({
          id: "run-2",
          status: "failed",
          error: "SOURCE_CHANGED_DURING_DETECTION: ...",
          errorClass: "SOURCE_CHANGED_DURING_DETECTION",
        }),
      }),
    ).toMatchObject({
      ok: false,
      runId: "run-2",
      errorClass: "SOURCE_CHANGED_DURING_DETECTION",
    });
  });

  it("shapes the status response for missing and present runs", () => {
    expect(toScanStatusResponse(null)).toMatchObject({ run: null });
    expect(
      toScanStatusResponse(
        runRowFixture({
          status: "failed",
          currentStage: "detecting",
          startedAt: "2026-01-01T00:00:00.000Z",
          completedAt: "2026-01-01T00:01:00.000Z",
          findingsCount: 0,
          error: "boom",
          errorClass: "DETECTOR_THREW",
        }),
      ),
    ).toMatchObject({
      run: { id: "run-1", status: "failed", errorClass: "DETECTOR_THREW" },
    });
  });
});
