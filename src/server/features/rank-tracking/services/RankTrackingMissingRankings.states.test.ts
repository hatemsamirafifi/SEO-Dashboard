import { beforeEach, describe, expect, it, vi } from "vitest";
import type { MissingRankingBucket } from "@/shared/rank-tracking";
import {
  activeConfig,
  billingCustomer,
  facts,
  makeKeywords,
} from "./RankTrackingMissingRankings.fixtures";

// "Check missing rankings" with an explicit missingRankingStates filter.
// Eligibility follows the LATEST ATTEMPT state per (keyword, device) pair:
// ranking unavailable, lost, no ranking and never-checked are INCLUDED;
// genuinely current RANKED is EXCLUDED; devices never mask each other.

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getKeywordCountForConfig: vi.fn(),
  getLatestRankingFactsForConfig: vi.fn(),
}));

const guardMocks = vi.hoisted(() => ({
  beginRankCheckRun:
    vi.fn<
      (input: {
        keywordsTotal: number;
        keywordIds?: string[];
        missingRankings?: boolean;
        missingRankingStates?: MissingRankingBucket[];
      }) => Promise<{ ok: true; runId: string }>
    >(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => ({ route: vi.fn() }),
}));
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
      getKeywordCountForConfig: mocks.getKeywordCountForConfig,
      getLatestRankingFactsForConfig: mocks.getLatestRankingFactsForConfig,
    },
  }),
);
vi.mock("./rankCheckRunGuards", () => ({
  beginRankCheckRun: guardMocks.beginRankCheckRun,
  reconcileActiveRankCheckRun: vi.fn(),
}));

interface BeginRunCall {
  keywordsTotal: number;
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: MissingRankingBucket[];
}

function runStartCall(): BeginRunCall {
  const first = guardMocks.beginRankCheckRun.mock.calls[0]?.[0];
  if (!first) throw new Error("beginRankCheckRun was not called");
  return first;
}

async function triggerMissing(input?: {
  keywordIds?: string[];
  missingRankingStates?: MissingRankingBucket[];
}) {
  const { RankTrackingService } = await import("./RankTrackingService");
  return RankTrackingService.triggerCheck({
    configId: "config_1",
    projectId: "project_1",
    billingCustomer,
    keywordIds: input?.keywordIds,
    missingRankings: true,
    missingRankingStates: input?.missingRankingStates,
  });
}

describe("RankTrackingService.triggerCheck selectable missingRankingStates filter", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    guardMocks.beginRankCheckRun.mockReset();
    mocks.getConfigById.mockResolvedValue(activeConfig);
    guardMocks.beginRankCheckRun.mockResolvedValue({
      ok: true,
      runId: "run_1",
    });
    mocks.getKeywordCountForConfig.mockResolvedValue(5);
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(5));
    // keyword_1: Ranking unavailable (CHECK_FAILED)
    // keyword_2: Lost (previous 8, latest NO_RESULT)
    // keyword_3: No ranking (NO_RESULT)
    // keyword_4: No ranking (never checked)
    // keyword_5: Ranked #10 (both devices)
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "CHECK_FAILED",
        "keyword_1:mobile": "CHECK_FAILED",
        "keyword_2:desktop": "lost",
        "keyword_2:mobile": "lost",
        "keyword_3:desktop": "NO_RESULT",
        "keyword_3:mobile": "NO_RESULT",
        "keyword_4:desktop": "never",
        "keyword_4:mobile": "never",
        "keyword_5:desktop": "10",
        "keyword_5:mobile": "10",
      }),
    );
  });

  it("1. default (undefined missingRankingStates) checks all missing keywords", async () => {
    const result = await triggerMissing();
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual([
      "keyword_1",
      "keyword_2",
      "keyword_3",
      "keyword_4",
    ]);
  });

  it("2. all three states explicitly selected checks all missing keywords", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["ranking_unavailable", "lost", "no_ranking"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual([
      "keyword_1",
      "keyword_2",
      "keyword_3",
      "keyword_4",
    ]);
    expect(runStartCall().missingRankingStates).toEqual([
      "ranking_unavailable",
      "lost",
      "no_ranking",
    ]);
  });

  it("3. ranking_unavailable only checks only CHECK_FAILED keywords", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["ranking_unavailable"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
  });

  it("4. lost only checks only lost keywords", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["lost"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_2"]);
  });

  it("5. no_ranking only checks only no-result and never-checked keywords", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["no_ranking"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_3", "keyword_4"]);
  });

  it("6. ranking_unavailable + lost checks both buckets", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["ranking_unavailable", "lost"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1", "keyword_2"]);
  });

  it("7. lost + no_ranking checks lost and no_ranking buckets", async () => {
    const result = await triggerMissing({
      missingRankingStates: ["lost", "no_ranking"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual([
      "keyword_2",
      "keyword_3",
      "keyword_4",
    ]);
  });

  it("8. clear all (empty array) returns no_missing_rankings and creates NO run", async () => {
    const result = await triggerMissing({
      missingRankingStates: [],
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_missing_rankings");
      expect(result.eligibleCount).toBe(0);
    }
    expect(guardMocks.beginRankCheckRun).not.toHaveBeenCalled();
  });

  it("9. server rejects/ignores invalid state values safely", async () => {
    const requested: MissingRankingBucket[] = ["lost"];
    (requested as string[]).push("unrecognized_bucket");
    const result = await triggerMissing({
      missingRankingStates: requested,
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_2"]);
  });

  it("10. server applies state filter with explicit keyword selection", async () => {
    // User selected keyword_1 (unavailable), keyword_2 (lost), and keyword_5 (ranked)
    // and chose "lost" only
    const result = await triggerMissing({
      keywordIds: ["keyword_1", "keyword_2", "keyword_5"],
      missingRankingStates: ["lost"],
    });
    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_2"]);
  });
});
