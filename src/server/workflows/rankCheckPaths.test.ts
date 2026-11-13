/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import {
  runLiveCheck,
  runQueuedCheck,
} from "@/server/workflows/rankCheckPaths";
import {
  fetchRankCheckTaskResult,
  MAX_TASKS_PER_POST,
} from "@/server/lib/dataforseo";

// Producer contract: per-call DataForSEO failures must not vanish into a
// generic run label. runLiveCheck keeps identical execution semantics (same
// calls, same skips, same writes, same progress) and additionally returns the
// first sanitized provider reason so the run record names the actual error.
// runQueuedCheck never resubmits bulk queue work to the Live endpoint, keeps
// collecting accepted tasks after later post failures, and persists per-pair
// diagnostics for everything that never produced a queue result.

const repoMocks = vi.hoisted(() => ({
  updateRun:
    vi.fn<(runId: string, patch: Record<string, unknown>) => Promise<void>>(),
  insertSnapshots:
    vi.fn<(snapshots: Array<Record<string, unknown>>) => Promise<void>>(),
  getLatestPositionsMap: vi.fn<() => Promise<Map<string, number | null>>>(),
  getRunById:
    vi.fn<(runId: string) => Promise<{ id: string; status: string } | null>>(),
  getSnapshotsForRun:
    vi.fn<(runId: string) => Promise<Array<{ trackingKeywordId: string }>>>(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);
vi.mock("@/server/workflows/pgStep", () => ({
  // Step stubs can model durable boundaries; the live-only fixtures need no engine.
  pgStep: (
    step: { do?: (name: string, fn: () => unknown) => unknown },
    name: string,
    _config: unknown,
    fn: () => unknown,
  ) => (step.do ? step.do(name, fn) : fn()),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: vi.fn(),
  MAX_TASKS_PER_POST: 100,
  // Bind-to-account-context wrapper: execute immediately (binding semantics
  // are covered by serp.test.ts).
  runWithDataforseoAccountContext: async (
    _scope: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

const organicMocks = vi.hoisted(() => ({
  insertOrganicSnapshots:
    vi.fn<(rows: Array<Record<string, unknown>>) => Promise<void>>(),
}));

vi.mock(
  "@/server/features/serp/clustering/SerpOrganicSnapshotRepository",
  () => ({
    SerpOrganicSnapshotRepository: {
      insertOrganicSnapshots: organicMocks.insertOrganicSnapshots,
    },
  }),
);

type Ctx = Parameters<typeof runLiveCheck>[1];

function makeCtx(
  rankCheck: Ctx["client"]["serp"]["rankCheck"],
  keywordCount = 1,
): Ctx {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only CheckContext stub; runLiveCheck only touches client.serp.rankCheck
    client: { serp: { rankCheck } } as unknown as Ctx["client"],
    keywords: Array.from({ length: keywordCount }, (_, i) => ({
      id: `kw_${i + 1}`,
      keyword: `keyword ${i + 1}`,
    })),
    devices: "desktop",
    serpDepth: 100,
    domain: "powersiment.ae",
    locationCode: 784,
    languageCode: "ar",
    runId: "run_1",
    projectId: "proj_1",
    configId: "cfg_1",
    billingScope: { organizationId: "org_1", projectId: "proj_1" },
  };
}

// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- pgStep is mocked to execute the body; the engine step is never touched
const step = {} as unknown as WorkflowStep;

function okResult(keywordId: string, keyword: string) {
  return {
    keywordId,
    keyword,
    position: 5,
    url: "https://x/",
    serpFeatures: [],
  };
}

describe("runLiveCheck provider-reason capture", () => {
  beforeEach(() => {
    repoMocks.updateRun.mockResolvedValue(undefined);
    repoMocks.insertSnapshots.mockResolvedValue(undefined);
    repoMocks.getLatestPositionsMap.mockResolvedValue(new Map());
    repoMocks.getRunById.mockResolvedValue({ id: "run_1", status: "running" });
    repoMocks.getSnapshotsForRun.mockResolvedValue([]);
    organicMocks.insertOrganicSnapshots.mockReset();
    organicMocks.insertOrganicSnapshots.mockResolvedValue(undefined);
  });

  it("returns null and persists snapshots when every call succeeds", async () => {
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) =>
        okResult(input.keywordId, input.keyword),
    );
    const firstError = await runLiveCheck(step, makeCtx(rankCheck));

    expect(firstError).toBeNull();
    expect(rankCheck).toHaveBeenCalledTimes(1);
    expect(repoMocks.insertSnapshots).toHaveBeenCalledTimes(1);
  });

  it("captures the canonical HTTP 500 reason and persists CHECK_FAILED snapshot", async () => {
    const rankCheck = vi.fn(async () => {
      throw new Error(
        "DataForSEO HTTP 500 on /v3/serp/google/organic/live/advanced: Internal Server Error (50000)",
      );
    });
    const firstError = await runLiveCheck(step, makeCtx(rankCheck));

    expect(firstError).toContain("DataForSEO HTTP 500");
    expect(firstError).toContain("Internal Server Error");
    expect(rankCheck).toHaveBeenCalledTimes(1);
    expect(repoMocks.insertSnapshots).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          rankingStatus: "CHECK_FAILED",
          position: null,
        }),
      ]),
    );
    const firstInsertedSnapshot =
      repoMocks.insertSnapshots.mock.calls[0]?.[0]?.[0];
    expect(firstInsertedSnapshot?.providerStatus).toContain(
      "DataForSEO HTTP 500",
    );
    expect(repoMocks.updateRun).toHaveBeenCalledWith("run_1", {
      keywordsChecked: 1,
    });
  });

  it("keeps the first failure reason across tasks in a batch", async () => {
    const rankCheck = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          "DataForSEO HTTP 500 on /v3/serp/google/organic/live/advanced: Internal Server Error (50000)",
        ),
      )
      .mockRejectedValueOnce(
        new Error(
          "DataForSEO HTTP 429 on /v3/serp/google/organic/live/advanced: Too Many Requests (42900)",
        ),
      );
    const firstError = await runLiveCheck(step, makeCtx(rankCheck, 2));

    expect(firstError).toContain("DataForSEO HTTP 500");
    expect(firstError).not.toContain("429");
    expect(rankCheck).toHaveBeenCalledTimes(2);
  });

  it("scrubs secrets from captured reasons", async () => {
    const rankCheck = vi.fn(async () => {
      throw new Error(
        "boom Authorization: Bearer secret_oauth_token_12345xyz password=hunter2",
      );
    });
    const firstError = await runLiveCheck(step, makeCtx(rankCheck));

    expect(firstError).not.toContain("secret_oauth_token_12345xyz");
    expect(firstError).not.toContain("hunter2");
  });

  it("captures 40201 paused account error and formats canonically", async () => {
    const errorWithDetails = Object.assign(
      new Error(
        "We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access",
      ),
      { statusCode: 40201 },
    );
    const rankCheck = vi.fn(async () => {
      throw errorWithDetails;
    });
    const firstError = await runLiveCheck(step, makeCtx(rankCheck));

    expect(firstError).toContain("DataForSEO task error (40201)");
    expect(firstError).toContain("temporarily paused access");
    expect(repoMocks.insertSnapshots).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          rankingStatus: "CHECK_FAILED",
          providerStatusCode: 40201,
          position: null,
        }),
      ]),
    );
  });

  it("halts execution and stops scheduling provider calls when run status is cancelled", async () => {
    // 3 keywords, but run is cancelled after the first keyword or batch
    let callCount = 0;
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => {
        callCount++;
        return okResult(input.keywordId, input.keyword);
      },
    );

    // Initial check passes, but inside checkBatchLive or next check it returns cancelled
    repoMocks.getRunById.mockImplementation(async () => {
      if (callCount >= 1) {
        return { id: "run_1", status: "cancelled" };
      }
      return { id: "run_1", status: "running" };
    });

    await runLiveCheck(step, makeCtx(rankCheck, 3));

    // The first keyword executed, but subsequent keywords were aborted
    expect(callCount).toBeLessThan(3);
  });

  it("exact 5-keyword case: stops after keyword 1 when cancelled under concurrency 1", async () => {
    process.env.RANK_CHECK_CONCURRENCY = "1";
    let callCount = 0;
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => {
        callCount++;
        return okResult(input.keywordId, input.keyword);
      },
    );

    repoMocks.getRunById.mockImplementation(async () => {
      // Once keyword 1 runs, run status flips to cancelled
      if (callCount >= 1) {
        return { id: "run_1", status: "cancelled" };
      }
      return { id: "run_1", status: "running" };
    });

    try {
      await runLiveCheck(step, makeCtx(rankCheck, 5));
      // Keyword 1 was called; keywords 2-5 were never dispatched
      expect(callCount).toBe(1);
    } finally {
      delete process.env.RANK_CHECK_CONCURRENCY;
    }
  });

  it("exact 5-keyword case: at most 2 in-flight calls before cancellation is observed under concurrency 2", async () => {
    process.env.RANK_CHECK_CONCURRENCY = "2";
    let callCount = 0;
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => {
        callCount++;
        return okResult(input.keywordId, input.keyword);
      },
    );

    repoMocks.getRunById.mockImplementation(async () => {
      // Flips to cancelled after the first chunk (2 keywords) starts/completes
      if (callCount >= 2) {
        return { id: "run_1", status: "cancelled" };
      }
      return { id: "run_1", status: "running" };
    });

    try {
      await runLiveCheck(step, makeCtx(rankCheck, 5));
      // Only first chunk of 2 ran; keywords 3-5 were never dispatched
      expect(callCount).toBe(2);
    } finally {
      delete process.env.RANK_CHECK_CONCURRENCY;
    }
  });

  it("50-keyword bounded concurrency scenario: halts immediately when cancelled and does not run to 50", async () => {
    process.env.RANK_CHECK_CONCURRENCY = "2";
    let callCount = 0;
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => {
        callCount++;
        return okResult(input.keywordId, input.keyword);
      },
    );

    repoMocks.getRunById.mockImplementation(async () => {
      // Cancel after 4 checks (2 chunks)
      if (callCount >= 4) {
        return { id: "run_1", status: "cancelled" };
      }
      return { id: "run_1", status: "running" };
    });

    try {
      await runLiveCheck(step, makeCtx(rankCheck, 50));
      expect(callCount).toBe(4);
      expect(callCount).toBeLessThan(50);
    } finally {
      delete process.env.RANK_CHECK_CONCURRENCY;
    }
  });

  it("checks cancellation immediately before provider dispatch and prevents the call", async () => {
    process.env.RANK_CHECK_CONCURRENCY = "1";
    let dispatchAttempt = 0;
    const rankCheck = vi.fn(async () => {
      return okResult("kw_1", "test");
    });

    repoMocks.getRunById.mockImplementation(async () => {
      dispatchAttempt++;
      // Return cancelled right at pre-dispatch check (dispatchAttempt === 2)
      if (dispatchAttempt >= 2) {
        return { id: "run_1", status: "cancelled" };
      }
      return { id: "run_1", status: "running" };
    });

    try {
      await runLiveCheck(step, makeCtx(rankCheck, 2));
      // rankCheck should never have been called because pre-dispatch caught the cancellation
      expect(rankCheck).not.toHaveBeenCalled();
    } finally {
      delete process.env.RANK_CHECK_CONCURRENCY;
    }
  });

  it("increments keywordsChecked monotonically across multiple batches without resetting backwards", async () => {
    const origDelay = process.env.RANK_CHECK_TEST_DELAY_MS;
    process.env.RANK_CHECK_TEST_DELAY_MS = "0";
    process.env.RANK_CHECK_CONCURRENCY = "5";
    try {
      const rankCheck = vi.fn(
        async (input: { keywordId: string; keyword: string }) =>
          okResult(input.keywordId, input.keyword),
      );

      // 15 keywords => 2 batches (10 + 5)
      await runLiveCheck(step, makeCtx(rankCheck, 15));

      const checkedUpdates = repoMocks.updateRun.mock.calls
        .filter(
          ([runId, patch]) =>
            runId === "run_1" && typeof patch.keywordsChecked === "number",
        )
        .map(([, patch]) =>
          typeof patch.keywordsChecked === "number" ? patch.keywordsChecked : 0,
        );

      expect(checkedUpdates.length).toBeGreaterThan(0);
      // Every update must be >= the previous one (monotonically non-decreasing, no chunk reset to 1-10)
      for (let i = 1; i < checkedUpdates.length; i++) {
        expect(checkedUpdates[i]).toBeGreaterThanOrEqual(checkedUpdates[i - 1]);
      }
      // Final progress reaches total keywords
      expect(checkedUpdates.at(-1)).toBe(15);
    } finally {
      if (origDelay !== undefined) {
        process.env.RANK_CHECK_TEST_DELAY_MS = origDelay;
      } else {
        delete process.env.RANK_CHECK_TEST_DELAY_MS;
      }
      delete process.env.RANK_CHECK_CONCURRENCY;
    }
  }, 15000);
});

// ---------------------------------------------------------------------------
// runQueuedCheck: bulk queue semantics. Bulk queue work NEVER falls back to
// the Live endpoint; accepted tasks keep being collected after later post
// failures; every pair that never produces a queue result is persisted as a
// CHECK_FAILED snapshot with a diagnostic.
// ---------------------------------------------------------------------------

interface PostedTaskPayload {
  keywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  taskId: string;
}

function postResultOf(
  tasks: Array<{
    keywordId: string;
    keyword: string;
    device: "desktop" | "mobile";
  }>,
): {
  posted: PostedTaskPayload[];
  rejected: [];
} {
  return {
    posted: tasks.map((task, i) => ({ ...task, taskId: `task-${i + 1}` })),
    rejected: [],
  };
}

function completedOutcome(task: { keywordId: string; keyword: string }) {
  return {
    status: "completed" as const,
    result: {
      keywordId: task.keywordId,
      keyword: task.keyword,
      position: 4,
      url: "https://x/",
      serpFeatures: [],
    },
  };
}

function makeQueuedCtx(input: {
  keywordCount: number;
  rankCheckTaskPost: Ctx["client"]["serp"]["rankCheckTaskPost"];
  rankCheck?: Ctx["client"]["serp"]["rankCheck"];
}): Ctx {
  return {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only CheckContext stub; the queued path touches client.serp.rankCheckTaskPost (and must NEVER touch rankCheck)
    client: {
      serp: {
        rankCheck: input.rankCheck ?? vi.fn(),
        rankCheckTaskPost: input.rankCheckTaskPost,
      },
    } as unknown as Ctx["client"],
    keywords: Array.from({ length: input.keywordCount }, (_, i) => ({
      id: `kw_${i + 1}`,
      keyword: `keyword ${i + 1}`,
    })),
    devices: "desktop",
    serpDepth: 100,
    domain: "powersiment.ae",
    locationCode: 784,
    languageCode: "ar",
    runId: "run_1",
    projectId: "proj_1",
    configId: "cfg_1",
    billingScope: { organizationId: "org_1", projectId: "proj_1" },
  };
}

/** Step stub with an instant sleep (collect rounds poll on it). */
const queuedStep = {
  do: (name: string, arg2: unknown, arg3?: unknown) => {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- step callbacks are always functions at the call sites we exercise
    const fn = (arg3 ?? arg2) as () => unknown;
    return Promise.resolve(fn());
  },
  sleep: () => Promise.resolve(),
} as unknown as WorkflowStep;

/** All CHECK_FAILED snapshots recorded so far (across every insert call). */
function failedSnapshots(): Array<Record<string, unknown>> {
  return repoMocks.insertSnapshots.mock.calls.flatMap(([rows]) => rows);
}

function resetQueuedMocks() {
  repoMocks.updateRun.mockResolvedValue(undefined);
  repoMocks.insertSnapshots.mockResolvedValue(undefined);
  repoMocks.getLatestPositionsMap.mockResolvedValue(new Map());
  repoMocks.getRunById.mockResolvedValue({ id: "run_1", status: "running" });
  repoMocks.getSnapshotsForRun.mockResolvedValue([]);
  organicMocks.insertOrganicSnapshots.mockReset();
  organicMocks.insertOrganicSnapshots.mockResolvedValue(undefined);
}

describe("runQueuedCheck bulk queue semantics", () => {
  beforeEach(resetQueuedMocks);

  it("posts chunks and collects accepted tasks into snapshots", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
        isCancelled?: () => Promise<boolean>;
      }) => postResultOf(tasks),
    );
    const ctx = makeQueuedCtx({ keywordCount: 3, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult).mockImplementation(
      async ({ keywordId, keyword }: { keywordId: string; keyword: string }) =>
        completedOutcome({ keywordId, keyword }),
    );

    const stats = await runQueuedCheck(queuedStep, ctx);

    expect(rankCheckTaskPost).toHaveBeenCalledTimes(1);
    expect(rankCheckTaskPost.mock.calls[0][0].isCancelled).toBeTypeOf(
      "function",
    );
    expect(stats).toEqual({
      queueTasks: 3,
      queueCollected: 3,
      uncollectedTasks: 0,
    });
    // Snapshots exist (3 collected), but none is a failure row.
    expect(failedSnapshots().length).toBeGreaterThanOrEqual(3);
    expect(
      failedSnapshots().filter((row) => row.rankingStatus === "CHECK_FAILED"),
    ).toEqual([]);
  });

  it("uses durable collect batches and preserves completed results when a later batch fails", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => postResultOf(tasks),
    );
    const ctx = makeQueuedCtx({ keywordCount: 120, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult).mockImplementation(
      async ({ keywordId, keyword }: { keywordId: string; keyword: string }) =>
        completedOutcome({ keywordId, keyword }),
    );
    const collectSteps: string[] = [];
    const batchStep = {
      sleep: () => Promise.resolve(),
      do: (name: string, arg2: unknown, arg3?: unknown) => {
        if (name.startsWith("collect-")) collectSteps.push(name);
        if (name === "collect-0-1") throw new Error("One collect batch failed");
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same workflow callback seam as queuedStep
        const fn = (arg3 ?? arg2) as () => unknown;
        return Promise.resolve(fn());
      },
    } as unknown as WorkflowStep;

    const stats = await runQueuedCheck(batchStep, ctx);
    expect(collectSteps).toEqual([
      "collect-0-0",
      "collect-0-1",
      "collect-0-2",
      "collect-1-0",
    ]);
    expect(stats).toEqual({
      queueTasks: 120,
      queueCollected: 120,
      uncollectedTasks: 0,
    });
    expect(fetchRankCheckTaskResult).toHaveBeenCalledTimes(120);
    const rows = failedSnapshots();
    expect(rows).toHaveLength(120);
    expect(rows.every((row) => row.rankingStatus === "RANKED")).toBe(true);
  });

  it("a thrown post batch records diagnostics, never resubmits to Live, and earlier accepted tasks are still collected", async () => {
    // 150 keywords => chunk 0 (100 tasks) posts fine; chunk 1 (50) throws.
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => {
        if (tasks.length === MAX_TASKS_PER_POST) return postResultOf(tasks);
        throw new Error(
          "DataForSEO HTTP 500 on /v3/serp/google/organic/task_post: boom (50000)",
        );
      },
    );
    const liveRankCheck = vi.fn();
    const ctx = makeQueuedCtx({
      keywordCount: 150,
      rankCheckTaskPost,
      rankCheck: liveRankCheck,
    });
    vi.mocked(fetchRankCheckTaskResult).mockImplementation(
      async ({ keywordId, keyword }: { keywordId: string; keyword: string }) =>
        completedOutcome({ keywordId, keyword }),
    );

    const stats = await runQueuedCheck(queuedStep, ctx);

    // The failed chunk's pairs were persisted as CHECK_FAILED diagnostics...
    const failed = failedSnapshots().filter(
      (row) => row.rankingStatus === "CHECK_FAILED",
    );
    expect(failed).toHaveLength(50);
    expect(failed[0]?.trackingKeywordId).toBe("kw_101");
    expect(failed[0]?.errorMessage).toContain("task_post failed");
    // ...the LIVE endpoint was never invoked (no fallback for bulk queue)...
    expect(liveRankCheck).not.toHaveBeenCalled();
    // ...and the 100 tasks accepted by the first chunk were still collected.
    expect(vi.mocked(fetchRankCheckTaskResult)).toHaveBeenCalledTimes(100);
    expect(stats).toEqual({
      queueTasks: 100,
      queueCollected: 100,
      uncollectedTasks: 50,
    });
  });

  it("persists per-entry post rejections with the provider reason (even with zero accepted tasks)", async () => {
    const rankCheckTaskPost = vi.fn(async () => ({
      posted: [
        {
          keywordId: "kw_1",
          keyword: "keyword 1",
          device: "desktop" as const,
          taskId: "task-1",
        },
      ],
      rejected: [
        {
          task: {
            keywordId: "kw_2",
            keyword: "keyword 2",
            device: "desktop" as const,
          },
          statusCode: 40006,
          statusMessage: "Task Limit Exceeded",
        },
      ],
    }));
    const ctx = makeQueuedCtx({ keywordCount: 2, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult).mockImplementation(
      async ({ keywordId, keyword }: { keywordId: string; keyword: string }) =>
        completedOutcome({ keywordId, keyword }),
    );

    const stats = await runQueuedCheck(queuedStep, ctx);

    const failed = failedSnapshots().filter(
      (row) => row.rankingStatus === "CHECK_FAILED",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.trackingKeywordId).toBe("kw_2");
    expect(failed[0]?.errorMessage).toContain("rejected the task at post");
    expect(String(failed[0]?.errorMessage)).toContain("Task Limit Exceeded");
    expect(String(failed[0]?.errorMessage)).toContain("40006");
    // The accepted pair was collected; the rejected one is uncollected.
    expect(stats).toEqual({
      queueTasks: 1,
      queueCollected: 1,
      uncollectedTasks: 1,
    });
  });

  it("records a rejection-only batch even when nothing was accepted (pending stays empty)", async () => {
    const rankCheckTaskPost = vi.fn(async () => ({
      posted: [],
      rejected: [
        {
          task: {
            keywordId: "kw_1",
            keyword: "keyword 1",
            device: "desktop" as const,
          },
          statusCode: 40006,
          statusMessage: "Task Limit Exceeded",
        },
      ],
    }));
    const ctx = makeQueuedCtx({ keywordCount: 1, rankCheckTaskPost });

    const stats = await runQueuedCheck(queuedStep, ctx);

    // pending.length === 0 skips the poll loop entirely, but the rejection
    // still must be persisted — never dropped into stats-only accounting.
    expect(vi.mocked(fetchRankCheckTaskResult)).not.toHaveBeenCalled();
    const failed = failedSnapshots().filter(
      (row) => row.rankingStatus === "CHECK_FAILED",
    );
    expect(failed).toHaveLength(1);
    expect(stats).toEqual({
      queueTasks: 0,
      queueCollected: 0,
      uncollectedTasks: 1,
    });
  });
});

describe("runQueuedCheck cancellation and collection failures", () => {
  beforeEach(resetQueuedMocks);

  it("records tasks still pending at window close as CHECK_FAILED with window diagnostics", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => postResultOf(tasks),
    );
    const ctx = makeQueuedCtx({ keywordCount: 1, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult).mockResolvedValue({
      status: "pending",
    });

    const stats = await runQueuedCheck(queuedStep, ctx);

    // Six poll rounds (sleeps resolve instantly), then the window closes.
    expect(vi.mocked(fetchRankCheckTaskResult)).toHaveBeenCalledTimes(6);
    const failed = failedSnapshots().filter(
      (row) => row.rankingStatus === "CHECK_FAILED",
    );
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.errorMessage)).toContain(
      "not collected within the polling window",
    );
    expect(stats).toEqual({
      queueTasks: 1,
      queueCollected: 0,
      uncollectedTasks: 1,
    });
  });

  it("a cancelled run stops posting further chunks and dispatches nothing more", async () => {
    // 150 keywords => 2 chunks; the run is cancelled after the first post.
    let firstPostDone = false;
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => {
        firstPostDone = true;
        return postResultOf(tasks);
      },
    );
    repoMocks.getRunById.mockImplementation(async () => ({
      id: "run_1",
      status: firstPostDone ? "cancelled" : "running",
    }));
    const ctx = makeQueuedCtx({ keywordCount: 150, rankCheckTaskPost });

    const stats = await runQueuedCheck(queuedStep, ctx);

    // Only the first chunk was posted; the second was never attempted...
    expect(rankCheckTaskPost).toHaveBeenCalledTimes(1);
    // ...no diagnostics were invented for the unposted pairs...
    expect(failedSnapshots()).toEqual([]);
    // ...and no collection happened after cancellation was observed.
    expect(vi.mocked(fetchRankCheckTaskResult)).not.toHaveBeenCalled();
    expect(stats).toEqual({
      queueTasks: 100,
      queueCollected: 0,
      uncollectedTasks: 0,
    });
  });

  it("cancellation observed after the durable polling sleep skips the collect round", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => postResultOf(tasks),
    );
    // getRunById calls: (1) pre-post check, (2) pre-sleep check, (3) the
    // post-sleep re-check — the third observation flips to cancelled.
    let statusChecks = 0;
    repoMocks.getRunById.mockImplementation(async () => {
      statusChecks += 1;
      return {
        id: "run_1",
        status: statusChecks >= 3 ? "cancelled" : "running",
      };
    });
    const ctx = makeQueuedCtx({ keywordCount: 1, rankCheckTaskPost });

    const stats = await runQueuedCheck(queuedStep, ctx);

    expect(vi.mocked(fetchRankCheckTaskResult)).not.toHaveBeenCalled();
    expect(failedSnapshots()).toEqual([]);
    expect(stats).toEqual({
      queueTasks: 1,
      queueCollected: 0,
      uncollectedTasks: 0,
    });
  });

  it("persists DataForSEO-failed tasks with the task message and counts them uncollected", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => postResultOf(tasks),
    );
    const ctx = makeQueuedCtx({ keywordCount: 1, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult).mockResolvedValue({
      status: "failed",
      message: "task exploded",
    });

    const stats = await runQueuedCheck(queuedStep, ctx);

    const failed = failedSnapshots().filter(
      (row) => row.rankingStatus === "CHECK_FAILED",
    );
    expect(failed).toHaveLength(1);
    expect(String(failed[0]?.errorMessage)).toContain(
      "DataForSEO task failed: task exploded",
    );
    expect(stats).toEqual({
      queueTasks: 1,
      queueCollected: 0,
      uncollectedTasks: 1,
    });
  });

  it("a transient task_get failure stays pending and is collected on the next round", async () => {
    const rankCheckTaskPost = vi.fn(
      async ({
        tasks,
      }: {
        tasks: Array<{
          keywordId: string;
          keyword: string;
          device: "desktop" | "mobile";
        }>;
      }) => postResultOf(tasks),
    );
    const ctx = makeQueuedCtx({ keywordCount: 1, rankCheckTaskPost });
    vi.mocked(fetchRankCheckTaskResult)
      .mockRejectedValueOnce(new Error("transient network error"))
      .mockImplementationOnce(
        async ({
          keywordId,
          keyword,
        }: {
          keywordId: string;
          keyword: string;
        }) => completedOutcome({ keywordId, keyword }),
      );

    const stats = await runQueuedCheck(queuedStep, ctx);

    expect(vi.mocked(fetchRankCheckTaskResult)).toHaveBeenCalledTimes(2);
    expect(stats).toEqual({
      queueTasks: 1,
      queueCollected: 1,
      uncollectedTasks: 0,
    });
  });
});

describe("runLiveCheck organic snapshot capture (spec 019)", () => {
  beforeEach(() => {
    repoMocks.updateRun.mockResolvedValue(undefined);
    repoMocks.insertSnapshots.mockResolvedValue(undefined);
    repoMocks.getLatestPositionsMap.mockResolvedValue(new Map());
    repoMocks.getRunById.mockResolvedValue({ id: "run_1", status: "running" });
    repoMocks.getSnapshotsForRun.mockResolvedValue([]);
    organicMocks.insertOrganicSnapshots.mockReset();
    organicMocks.insertOrganicSnapshots.mockResolvedValue(undefined);
  });

  it("stores the organic results the provider already returned", async () => {
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => ({
        keywordId: input.keywordId,
        keyword: input.keyword,
        position: 5,
        url: "https://x/",
        serpFeatures: [],
        organicResults: [
          {
            position: 1,
            title: "Top result",
            url: "https://example.com/a",
            domain: "example.com",
          },
          {
            position: 2,
            title: "Second result",
            url: "https://example.com/b",
            domain: "example.com",
          },
        ],
      }),
    );

    await runLiveCheck(step, makeCtx(rankCheck));

    expect(organicMocks.insertOrganicSnapshots).toHaveBeenCalledTimes(1);
    const rows = organicMocks.insertOrganicSnapshots.mock.calls[0]?.[0] ?? [];
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      runId: "run_1",
      projectId: "proj_1",
      configId: "cfg_1",
      keyword: "keyword 1",
      device: "desktop",
      locationCode: 784,
      languageCode: "ar",
      position: 1,
      url: "https://example.com/a",
      provider: "dataforseo",
    });
  });

  it("keeps the rank check intact when the organic write fails", async () => {
    organicMocks.insertOrganicSnapshots.mockRejectedValue(
      new Error("D1 write failed"),
    );
    const rankCheck = vi.fn(
      async (input: { keywordId: string; keyword: string }) => ({
        keywordId: input.keywordId,
        keyword: input.keyword,
        position: 5,
        url: "https://x/",
        serpFeatures: [],
        organicResults: [
          {
            position: 1,
            title: "Top result",
            url: "https://example.com/a",
            domain: "example.com",
          },
        ],
      }),
    );

    const firstError = await runLiveCheck(step, makeCtx(rankCheck));

    expect(firstError).toBeNull();
    expect(repoMocks.insertSnapshots).toHaveBeenCalledTimes(1);
    expect(organicMocks.insertOrganicSnapshots).toHaveBeenCalledTimes(1);
  });
});
