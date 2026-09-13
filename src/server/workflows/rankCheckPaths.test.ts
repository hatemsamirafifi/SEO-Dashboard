/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";
import { runLiveCheck } from "@/server/workflows/rankCheckPaths";

// Producer contract: per-call DataForSEO failures must not vanish into a
// generic run label. runLiveCheck keeps identical execution semantics (same
// calls, same skips, same writes, same progress) and additionally returns the
// first sanitized provider reason so the run record names the actual error.

const repoMocks = vi.hoisted(() => ({
  updateRun: vi.fn<() => Promise<void>>(),
  insertSnapshots: vi.fn<() => Promise<void>>(),
  getLatestPositionsMap: vi.fn<() => Promise<Map<string, number | null>>>(),
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
    const firstInsertedSnapshot = repoMocks.insertSnapshots.mock.calls[0]?.[0]?.[0];
    expect(firstInsertedSnapshot?.providerStatus).toContain("DataForSEO HTTP 500");
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
});
