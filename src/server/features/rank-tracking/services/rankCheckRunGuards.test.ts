import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_ACTIVE_RUN_AGE_MS,
  reconcileActiveRankCheckRun,
  failRunIfActive,
} from "./rankCheckRunGuards";
import type { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";

const mocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  workflowGet: vi.fn(),
  workflowTerminate: vi.fn(),
  workflowStatus: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    RANK_CHECK_WORKFLOW: {
      get: mocks.workflowGet,
    },
  },
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getRunById: mocks.getRunById,
      updateRun: mocks.updateRun,
    },
  }),
);

type RunRow = NonNullable<
  Awaited<ReturnType<typeof RankTrackingRepository.getRunById>>
>;

function makeRunRow(overrides: Partial<RunRow> = {}): RunRow {
  return {
    id: "run-1",
    configId: "cfg-1",
    projectId: "proj-1",
    status: "running",
    keywordsTotal: 27,
    keywordsChecked: 0,
    isSubsetRun: false,
    errorMessage: null,
    startedAt: new Date().toISOString(),
    completedAt: null,
    ...overrides,
  };
}

describe("rankCheckRunGuards watchdog and reconciliation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.workflowGet.mockResolvedValue({
      status: mocks.workflowStatus,
      terminate: mocks.workflowTerminate,
    });
  });

  describe("reconcileActiveRankCheckRun", () => {
    it("returns timeout stale reason when active run exceeds MAX_ACTIVE_RUN_AGE_MS even if workflow reports running", async () => {
      mocks.workflowStatus.mockResolvedValue({ status: "running" });

      const oldStartedAt = new Date(
        Date.now() - (MAX_ACTIVE_RUN_AGE_MS + 60 * 1000),
      ).toISOString();

      const run = makeRunRow({
        id: "run-stuck-1",
        status: "running",
        startedAt: oldStartedAt,
        keywordsChecked: 12,
        isSubsetRun: true,
      });

      const result = await reconcileActiveRankCheckRun(run);

      expect(result).not.toBeNull();
      expect(result?.errorMessage).toContain(
        "Workflow run exceeded maximum active duration",
      );
    });

    it("returns null when run is running and within active age", async () => {
      mocks.workflowStatus.mockResolvedValue({ status: "running" });

      const recentStartedAt = new Date(
        Date.now() - 5 * 60 * 1000,
      ).toISOString();

      const run = makeRunRow({
        id: "run-active-1",
        status: "running",
        startedAt: recentStartedAt,
        keywordsChecked: 5,
      });

      const result = await reconcileActiveRankCheckRun(run);

      expect(result).toBeNull();
    });

    it("returns null for runs that are already completed or failed", async () => {
      const run = makeRunRow({
        id: "run-done-1",
        status: "completed",
        completedAt: new Date().toISOString(),
        keywordsChecked: 27,
      });

      const result = await reconcileActiveRankCheckRun(run);
      expect(result).toBeNull();
    });
  });

  describe("failRunIfActive", () => {
    it("updates active running run to failed and terminates workflow", async () => {
      const run = makeRunRow({
        id: "run-1",
        status: "running",
      });
      mocks.getRunById.mockResolvedValue(run);

      await failRunIfActive("run-1", "Workflow timed out", run);

      expect(mocks.updateRun).toHaveBeenCalledWith("run-1", {
        status: "failed",
        errorMessage: "Workflow timed out",
        completedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}/),
      });
      expect(mocks.workflowTerminate).toHaveBeenCalled();
    });

    it("does not update run if already completed or cancelled", async () => {
      const run = makeRunRow({
        id: "run-2",
        status: "cancelled",
      });
      mocks.getRunById.mockResolvedValue(run);

      await failRunIfActive("run-2", "Some error", run);

      expect(mocks.updateRun).not.toHaveBeenCalled();
    });
  });
});
