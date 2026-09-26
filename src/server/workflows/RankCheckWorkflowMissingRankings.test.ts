import { beforeEach, describe, expect, it, vi } from "vitest";
import type { WorkflowStep } from "cloudflare:workers";

// Missing-rankings mode inside the workflow: prepare re-resolves eligibility
// against fresh pair facts at execution time so a keyword that recovered on
// EVERY tracked device between trigger and execution is dropped before any
// provider call. Keywords with a ranked device but a still-missing device
// stay in the run. The provider pipeline, retries, and cancellation paths
// are untouched.

const repoMocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  insertSnapshots: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  getConfigById: vi.fn(),
  updateConfig: vi.fn(),
}));

const pathsMocks = vi.hoisted(() => ({
  runLiveCheck:
    vi.fn<
      (
        step: unknown,
        ctx: { keywords: Array<{ id: string }> },
      ) => Promise<string | null>
    >(),
  runQueuedCheck: vi.fn(),
}));

const factsMocks = vi.hoisted(() => ({
  getLatestRankingFactsForConfig: vi.fn(),
}));

const guardModule = vi.hoisted(() => ({
  failRunIfActive: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  NonRetryableError: class NonRetryableError extends Error {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- mock base class must be constructible
  WorkflowEntrypoint: class WorkflowEntrypointMock {
    public readonly __mockEngine = true;
  },
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>) => fn(),
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/missingRankingQueries",
  () => ({
    getLatestRankingFactsForConfig: factsMocks.getLatestRankingFactsForConfig,
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankCheckRunGuards", () => ({
  failRunIfActive: guardModule.failRunIfActive,
}));
vi.mock("@/server/workflows/rankCheckPaths", () => ({
  runLiveCheck: pathsMocks.runLiveCheck,
  runQueuedCheck: pathsMocks.runQueuedCheck,
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({}),
}));
vi.mock("@/server/features/serp/providerResolver", () => ({
  createRankSerpResolver: vi.fn().mockResolvedValue({}),
}));
vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));
vi.mock("@/server/billing/autumn", () => ({
  autumn: { check: vi.fn() },
}));
vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: vi.fn().mockResolvedValue(false),
}));

const activeRun = { id: "run_1", status: "pending", keywordsTotal: 0 };

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

async function runWorkflow(params: {
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: any[];
}) {
  const { RankCheckWorkflow } = await import("./RankCheckWorkflow");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- engine ctor args are unused by the workflow body
  const instance = new RankCheckWorkflow({} as never, {} as never);
  const step = {
    do: (_name: string, arg2: unknown, arg3?: unknown) => {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- step callbacks are always functions at the call sites we exercise
      const fn = (arg3 ?? arg2) as () => unknown;
      return Promise.resolve(fn());
    },
    sleep: () => Promise.resolve(),
    sleepUntil: () => Promise.resolve(),
    waitForEvent:
      ((): // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- placeholder value for a stub that is never awaited by the workflow under test
      Promise<never> =>
        Promise.resolve(
          {} as never,
        )) as unknown as WorkflowStep["waitForEvent"],
  };
  const event = {
    payload: {
      runId: "run_1",
      configId: "config_1",
      billingCustomer,
      projectId: "project_1",
      domain: "acme.com",
      locationCode: 2840,
      languageCode: "en",
      devices: "both" as const,
      serpDepth: 20,
      trigger: "manual" as const,
      keywordIds: params.keywordIds,
      missingRankings: params.missingRankings,
      missingRankingStates: params.missingRankingStates,
    },
    timestamp: new Date(),
    instanceId: "run_1",
  };
  return instance.run(event, step);
}

function makeKeywords(count: number): Array<{ id: string; keyword: string }> {
  return Array.from({ length: count }, (_, i) => ({
    id: `keyword_${i + 1}`,
    keyword: `tracked query ${i + 1}`,
  }));
}

function pairFacts(entries: Record<string, string>): Map<string, unknown> {
  const map = new Map<string, unknown>();
  for (const [key, state] of Object.entries(entries)) {
    if (state === "never") continue;
    if (state === "CHECK_FAILED") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "CHECK_FAILED",
      });
    } else if (state === "lost") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: 8,
        rankingStatus: "NO_RESULT",
      });
    } else if (state === "NO_RESULT") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      });
    } else {
      const position = parseInt(state, 10);
      map.set(key, {
        hasSnapshot: true,
        position,
        previousPosition: position,
        rankingStatus: "RANKED",
      });
    }
  }
  return map;
}

describe("RankCheckWorkflow missing-rankings re-resolution", () => {
  beforeEach(() => {
    vi.resetModules();
    for (const mock of Object.values(repoMocks)) mock.mockReset();
    for (const mock of Object.values(pathsMocks)) mock.mockReset();
    factsMocks.getLatestRankingFactsForConfig.mockReset();
    guardModule.failRunIfActive.mockReset();

    repoMocks.getRunById.mockResolvedValue(activeRun);
    repoMocks.getConfigById.mockResolvedValue({ isActive: true });
    repoMocks.getSnapshotsForRun.mockResolvedValue([]);
    repoMocks.updateRun.mockResolvedValue(undefined);
    repoMocks.updateConfig.mockResolvedValue(undefined);
    pathsMocks.runLiveCheck.mockResolvedValue(null);
  });

  it("drops only keywords that recovered on EVERY tracked device before execution", async () => {
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(3));
    // keyword_2 recovered on both devices; keyword_1 recovered on desktop
    // but is still CHECK_FAILED on mobile (visible Ranking unavailable).
    factsMocks.getLatestRankingFactsForConfig.mockResolvedValue(
      pairFacts({
        "keyword_1:desktop": "5",
        "keyword_1:mobile": "CHECK_FAILED",
        "keyword_2:desktop": "6",
        "keyword_2:mobile": "6",
        "keyword_3:desktop": "lost",
        "keyword_3:mobile": "lost",
      }),
    );

    await runWorkflow({
      keywordIds: ["keyword_1", "keyword_2", "keyword_3"],
      missingRankings: true,
    });

    expect(pathsMocks.runLiveCheck).toHaveBeenCalledTimes(1);
    const ctx = pathsMocks.runLiveCheck.mock.calls[0][1];
    expect(ctx.keywords.map((kw) => kw.id)).toEqual(["keyword_1", "keyword_3"]);
  });

  it("without missingRankings mode no re-resolution happens (pipeline reused)", async () => {
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(2));

    await runWorkflow({ keywordIds: ["keyword_1", "keyword_2"] });

    expect(factsMocks.getLatestRankingFactsForConfig).not.toHaveBeenCalled();
    expect(pathsMocks.runLiveCheck).toHaveBeenCalledTimes(1);
    const ctx = pathsMocks.runLiveCheck.mock.calls[0][1];
    expect(ctx.keywords).toHaveLength(2);
  });

  it("fails the run when every keyword recovered (no empty provider run)", async () => {
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(2));
    factsMocks.getLatestRankingFactsForConfig.mockResolvedValue(
      pairFacts({
        "keyword_1:desktop": "3",
        "keyword_1:mobile": "3",
        "keyword_2:desktop": "4",
        "keyword_2:mobile": "4",
      }),
    );

    await expect(
      runWorkflow({
        keywordIds: ["keyword_1", "keyword_2"],
        missingRankings: true,
      }),
    ).rejects.toThrow("No keywords to track");
    expect(pathsMocks.runLiveCheck).not.toHaveBeenCalled();
  });

  it("missing-rankings run still finalizes from snapshots (retries/fallback unchanged)", async () => {
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    factsMocks.getLatestRankingFactsForConfig.mockResolvedValue(
      pairFacts({ "keyword_1:desktop": "lost", "keyword_1:mobile": "lost" }),
    );
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        trackingKeywordId: "keyword_1",
        rankingStatus: "RANKED",
        position: 12,
      },
    ]);

    await runWorkflow({
      keywordIds: ["keyword_1"],
      missingRankings: true,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_1",
      expect.objectContaining({ status: "completed", keywordsChecked: 1 }),
    );
  });

  it("re-resolution applies missingRankingStates: drops keywords whose current state is not in the selection", async () => {
    // User selected Lost only.
    // keyword_1 was lost, still lost -> kept
    // keyword_2 was lost, but changed to CHECK_FAILED (Ranking unavailable) -> dropped!
    // keyword_3 was lost, but recovered to Ranked #8 -> dropped!
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(3));
    factsMocks.getLatestRankingFactsForConfig.mockResolvedValue(
      pairFacts({
        "keyword_1:desktop": "lost",
        "keyword_1:mobile": "lost",
        "keyword_2:desktop": "CHECK_FAILED",
        "keyword_2:mobile": "CHECK_FAILED",
        "keyword_3:desktop": "8",
        "keyword_3:mobile": "8",
      }),
    );

    await runWorkflow({
      keywordIds: ["keyword_1", "keyword_2", "keyword_3"],
      missingRankings: true,
      missingRankingStates: ["lost"],
    });

    expect(pathsMocks.runLiveCheck).toHaveBeenCalledTimes(1);
    const ctx = pathsMocks.runLiveCheck.mock.calls[0][1];
    expect(ctx.keywords.map((kw) => kw.id)).toEqual(["keyword_1"]);
  });

  it("re-resolution applies multi-state missingRankingStates filter", async () => {
    // User selected ranking_unavailable + no_ranking
    // keyword_1: CHECK_FAILED (ranking_unavailable) -> kept
    // keyword_2: lost -> dropped!
    // keyword_3: NO_RESULT (no_ranking) -> kept
    repoMocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(3));
    factsMocks.getLatestRankingFactsForConfig.mockResolvedValue(
      pairFacts({
        "keyword_1:desktop": "CHECK_FAILED",
        "keyword_1:mobile": "CHECK_FAILED",
        "keyword_2:desktop": "lost",
        "keyword_2:mobile": "lost",
        "keyword_3:desktop": "NO_RESULT",
        "keyword_3:mobile": "NO_RESULT",
      }),
    );

    await runWorkflow({
      keywordIds: ["keyword_1", "keyword_2", "keyword_3"],
      missingRankings: true,
      missingRankingStates: ["ranking_unavailable", "no_ranking"],
    });

    expect(pathsMocks.runLiveCheck).toHaveBeenCalledTimes(1);
    const ctx = pathsMocks.runLiveCheck.mock.calls[0][1];
    expect(ctx.keywords.map((kw) => kw.id)).toEqual(["keyword_1", "keyword_3"]);
  });
});
