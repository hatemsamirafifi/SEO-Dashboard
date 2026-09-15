/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { runLiveCheck } from "@/server/workflows/rankCheckPaths";

// Producer contract: per-call DataForSEO failures must not vanish into a
// generic run label. runLiveCheck keeps identical execution semantics (same
// calls, same skips, same writes, same progress) and additionally returns the
// first sanitized provider reason so the run record names the actual error.

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
  // Execute the step body immediately; persistence is the engine's concern.
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  fetchRankCheckTaskResult: vi.fn(),
  MAX_TASKS_PER_POST: 100,
}));

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
});
