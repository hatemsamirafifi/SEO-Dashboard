import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DeviceRankingFacts } from "@/shared/rank-tracking";

// "Check missing rankings" — service-level eligibility resolution. The exact
// keyword IDs handed to the run are the persisted missing-ranking set (never
// derived from rendered UI strings). Eligibility follows the LATEST ATTEMPT
// state per (keyword, device) pair:
// - Ranking unavailable (latest CHECK_FAILED) is INCLUDED even when an older
//   valid ranking position is preserved — history serves deltas, never
//   suppression of the retry.
// - Lost / No ranking / never checked are INCLUDED.
// - Genuinely current RANKED is EXCLUDED.
// - Mixed devices never mask each other: desktop ranked + mobile missing
//   stays eligible, because there is no keyword-level "any ranked" veto.
// - Zero eligible keywords creates NO run.

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
        missingRankingStates?: any[];
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

const activeConfig = {
  id: "config_1",
  projectId: "project_1",
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  locationName: null,
  devices: "both" as const,
  serpDepth: 20,
  scheduleInterval: "weekly" as const,
  isActive: true,
};

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

interface KeywordRow {
  id: string;
  configId: string;
  keyword: string;
}

function makeKeywords(count: number): KeywordRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `keyword_${i + 1}`,
    configId: "config_1",
    keyword: `tracked query ${i + 1}`,
  }));
}

/** Latest-attempt pair facts keyed "keywordId:device". */
function facts(
  entries: Record<
    string,
    | "CHECK_FAILED"
    | "CHECK_FAILED_preserved_7"
    | "NO_RESULT"
    | "lost"
    | "never"
    | (string & {})
  >,
): Map<string, DeviceRankingFacts> {
  const map = new Map<string, DeviceRankingFacts>();
  for (const [key, state] of Object.entries(entries)) {
    if (state === "never") continue;
    if (state === "CHECK_FAILED") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "CHECK_FAILED",
      });
    } else if (state === "CHECK_FAILED_preserved_7") {
      // Latest attempt failed; the state model preserves the older valid #7.
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: 7,
        rankingStatus: "CHECK_FAILED",
      });
    } else if (state === "NO_RESULT") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      });
    } else if (state === "lost") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: 8,
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

interface BeginRunCall {
  keywordsTotal: number;
  keywordIds?: string[];
  missingRankings?: boolean;
  missingRankingStates?: any[];
}

function runStartCall(): BeginRunCall {
  const first = guardMocks.beginRankCheckRun.mock.calls[0]?.[0];
  if (!first) throw new Error("beginRankCheckRun was not called");
  return first;
}

async function triggerMissing(input?: {
  keywordIds?: string[];
  missingRankingStates?: any[];
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

describe("RankTrackingService.triggerCheck missing-rankings scope", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    guardMocks.beginRankCheckRun.mockReset();
    mocks.getConfigById.mockResolvedValue(activeConfig);
    guardMocks.beginRankCheckRun.mockResolvedValue({
      ok: true,
      runId: "run_1",
    });
    mocks.getKeywordCountForConfig.mockResolvedValue(878);
  });

  it("A. previous #7 + latest CHECK_FAILED (UI: Ranking unavailable) -> INCLUDED", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(2));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "CHECK_FAILED_preserved_7",
        "keyword_1:mobile": "CHECK_FAILED_preserved_7",
        "keyword_2:desktop": "12",
        "keyword_2:mobile": "12",
      }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
    expect(runStartCall().missingRankings).toBe(true);
  });

  it("B. previous #7 + latest NO_RESULT (UI: lost) -> INCLUDED", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(2));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "lost",
        "keyword_1:mobile": "lost",
        "keyword_2:desktop": "6",
        "keyword_2:mobile": "6",
      }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
  });

  it("C. NO_RESULT with no previous position (never ranked) -> INCLUDED", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "NO_RESULT",
        "keyword_1:mobile": "NO_RESULT",
      }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
  });

  it("D. genuinely current RANKED #7 on both devices -> EXCLUDED", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "7",
        "keyword_1:mobile": "7",
      }),
    );

    const result = await triggerMissing();

    // Zero eligible: NO run is created at all.
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("no_missing_rankings");
    expect(guardMocks.beginRankCheckRun).not.toHaveBeenCalled();
  });

  it("E. Desktop RANKED #5 + Mobile CHECK_FAILED (both-device scope) -> INCLUDED (mobile retried)", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "5",
        "keyword_1:mobile": "CHECK_FAILED",
      }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
  });

  it("F. Desktop RANKED #5 + Mobile LOST (both-device scope) -> INCLUDED", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "5",
        "keyword_1:mobile": "lost",
      }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual(["keyword_1"]);
  });

  it("mobile-only config: desktop state is irrelevant to eligibility", async () => {
    mocks.getConfigById.mockResolvedValue({
      ...activeConfig,
      devices: "mobile" as const,
    });
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "5",
        "keyword_1:mobile": "5",
      }),
    );

    const result = await triggerMissing();

    // Mobile scope is ranked — desktop's rank must not make it eligible.
    expect(result.ok).toBe(false);
    expect(guardMocks.beginRankCheckRun).not.toHaveBeenCalled();
  });

  it("G. location specificity: resolution is scoped to the config's own snapshots", async () => {
    // Configs are (project, domain, location) rows; the facts query is
    // config-scoped, so UAE #4 never suppresses Egypt's Ranking unavailable.
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(1));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({ "keyword_1:desktop": "CHECK_FAILED" }),
    );

    const result = await triggerMissing();

    expect(result.ok).toBe(true);
    expect(mocks.getLatestRankingFactsForConfig).toHaveBeenCalledWith(
      "config_1",
      expect.anything(),
    );
    expect(result.ok && result.validatedKeywordIds).toEqual(["keyword_1"]);
  });

  it("explicit selection only executes the eligible subset (K)", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(5));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        // keyword_1 selected but ranked (excluded); keyword_2 and keyword_4
        // missing; keyword_5 selected with no snapshot (never checked ->
        // included). keyword_3 not selected even though it is missing.
        "keyword_1:desktop": "4",
        "keyword_1:mobile": "4",
        "keyword_2:desktop": "NO_RESULT",
        "keyword_2:mobile": "NO_RESULT",
        "keyword_4:desktop": "lost",
        "keyword_4:mobile": "lost",
        "keyword_3:desktop": "never",
        "keyword_3:mobile": "never",
      }),
    );

    const result = await triggerMissing({
      keywordIds: ["keyword_1", "keyword_2", "keyword_4", "keyword_5"],
    });

    expect(result.ok).toBe(true);
    expect(runStartCall().keywordIds).toEqual([
      "keyword_2",
      "keyword_4",
      "keyword_5",
    ]);
  });

  it("zero eligible selection creates no run and reports the truthful breakdown", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(2));
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_1:desktop": "2",
        "keyword_1:mobile": "2",
        "keyword_2:desktop": "9",
        "keyword_2:mobile": "9",
      }),
    );

    const result = await triggerMissing({ keywordIds: ["keyword_1"] });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe("no_missing_rankings");
      expect(result.breakdown).toEqual({
        ranking_unavailable: 0,
        lost: 0,
        no_ranking: 0,
      });
    }
    expect(guardMocks.beginRankCheckRun).not.toHaveBeenCalled();
  });

  it("eligible count/breakdown is truthful (28/74/136 example shape)", async () => {
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(5));
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
        "keyword_5:desktop": "30",
        "keyword_5:mobile": "30",
      }),
    );

    const { RankTrackingService } = await import("./RankTrackingService");
    const summary = await RankTrackingService.getMissingRankingsSummary({
      configId: "config_1",
      projectId: "project_1",
    });

    expect(summary.eligibleCount).toBe(4);
    expect(summary.breakdown).toEqual({
      ranking_unavailable: 1,
      lost: 1,
      no_ranking: 2,
    });
    expect(summary.total).toBe(878);
  });
});

describe("RankTrackingService.getMissingRankingsSummary selection scoping", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    mocks.getConfigById.mockResolvedValue(activeConfig);
    mocks.getKeywordCountForConfig.mockResolvedValue(20);
    mocks.getKeywordsForConfig.mockResolvedValue(makeKeywords(20));
  });

  it("scopes the summary to the requested selection and validates membership", async () => {
    mocks.getLatestRankingFactsForConfig.mockResolvedValue(
      facts({
        "keyword_2:desktop": "NO_RESULT",
        "keyword_2:mobile": "NO_RESULT",
      }),
    );

    const { RankTrackingService } = await import("./RankTrackingService");
    const summary = await RankTrackingService.getMissingRankingsSummary({
      configId: "config_1",
      projectId: "project_1",
      keywordIds: ["keyword_2", "keyword_7", "foreign_id", "keyword_2"],
    });

    // keyword_2 + keyword_7 survive membership + dedupe (foreign_id dropped).
    // keyword_2 is NO_RESULT, keyword_7 has no snapshot (never checked) —
    // both eligible.
    expect(summary.total).toBe(2);
    expect(summary.eligibleCount).toBe(2);
  });
});

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
    const result = await triggerMissing({
      missingRankingStates: ["unrecognized_bucket" as any, "lost"],
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
