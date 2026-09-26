import { describe, expect, it } from "vitest";
import {
  classifyDeviceRankingState,
  classifyKeywordFromPairFacts,
  classifyKeywordMissingRankings,
  isMissingRankingState,
  missingRankingBucket,
  noRankingFacts,
  type DeviceRankingFacts,
} from "./rank-tracking";

// The "Check missing rankings" eligibility predicate. The three missing
// states stay semantically distinct — the action only changes eligibility,
// never collapses CHECK_FAILED / lost / NO_RESULT into one another.

function facts(
  overrides: Partial<Parameters<typeof classifyDeviceRankingState>[0]> = {},
) {
  return {
    hasSnapshot: true,
    position: null,
    previousPosition: null,
    rankingStatus: null,
    ...overrides,
  };
}

describe("classifyDeviceRankingState", () => {
  it("A. CHECK_FAILED → ranking_unavailable (INCLUDED)", () => {
    expect(
      classifyDeviceRankingState(
        facts({ rankingStatus: "CHECK_FAILED", position: null }),
      ),
    ).toBe("ranking_unavailable");
  });

  it("A2. CHECK_FAILED with a preserved last-valid position is still ranking_unavailable", () => {
    // The state model preserves the last valid position on a failed attempt;
    // the UI shows "Ranking unavailable", so eligibility must agree.
    expect(
      classifyDeviceRankingState(
        facts({ rankingStatus: "CHECK_FAILED", position: 5 }),
      ),
    ).toBe("ranking_unavailable");
  });

  it("B. lost: position null + previousPosition present → lost (INCLUDED)", () => {
    expect(
      classifyDeviceRankingState(
        facts({
          position: null,
          previousPosition: 8,
          rankingStatus: "NO_RESULT",
        }),
      ),
    ).toBe("lost");
  });

  it("C. NO_RESULT with no previous position → no_ranking (INCLUDED)", () => {
    expect(
      classifyDeviceRankingState(
        facts({
          position: null,
          previousPosition: null,
          rankingStatus: "NO_RESULT",
        }),
      ),
    ).toBe("no_ranking");
  });

  it("C2. legacy row with null rankingStatus and no position → no_ranking", () => {
    expect(
      classifyDeviceRankingState(
        facts({ rankingStatus: null, position: null }),
      ),
    ).toBe("no_ranking");
  });

  it("D. never checked (no snapshot) → not_checked (INCLUDED)", () => {
    expect(classifyDeviceRankingState(facts({ hasSnapshot: false }))).toBe(
      "not_checked",
    );
  });

  it("E. currently ranked #5 → ranked (EXCLUDED)", () => {
    expect(
      classifyDeviceRankingState(
        facts({ position: 5, rankingStatus: "RANKED" }),
      ),
    ).toBe("ranked");
    expect(
      isMissingRankingState(
        classifyDeviceRankingState(
          facts({ position: 5, rankingStatus: "RANKED" }),
        ),
      ),
    ).toBe(false);
  });

  it("position #1 and #34 are excluded the same as #8 — validity, not value", () => {
    for (const position of [1, 8, 34]) {
      expect(
        classifyDeviceRankingState(
          facts({ position, rankingStatus: "RANKED" }),
        ),
      ).toBe("ranked");
    }
  });
});

describe("classifyKeywordMissingRankings", () => {
  it("eligible when any tracked device is missing", () => {
    expect(
      classifyKeywordMissingRankings(["ranked", "ranking_unavailable"]),
    ).toEqual({ eligible: true, bucket: "ranking_unavailable" });
  });

  it("excluded when every tracked device is ranked", () => {
    expect(classifyKeywordMissingRankings(["ranked", "ranked"])).toEqual({
      eligible: false,
      bucket: null,
    });
  });

  it("breakdown bucket is deterministic across mixed missing devices", () => {
    // ranking_unavailable outranks lost outranks no_ranking for the label.
    expect(
      classifyKeywordMissingRankings([
        "no_ranking",
        "lost",
        "ranking_unavailable",
      ]),
    ).toEqual({ eligible: true, bucket: "ranking_unavailable" });
    expect(classifyKeywordMissingRankings(["no_ranking", "lost"])).toEqual({
      eligible: true,
      bucket: "lost",
    });
  });

  it("not_checked reports in the no_ranking bucket", () => {
    expect(missingRankingBucket("not_checked")).toBe("no_ranking");
    expect(classifyKeywordMissingRankings(["not_checked"])).toEqual({
      eligible: true,
      bucket: "no_ranking",
    });
  });

  it("single-device config: mobile lost while desktop untracked", () => {
    expect(classifyKeywordMissingRankings(["lost"])).toEqual({
      eligible: true,
      bucket: "lost",
    });
  });
});

describe("classifyKeywordFromPairFacts (pair-level, no any-ranked veto)", () => {
  function pairMap(
    entries: Record<string, string>,
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
        map.set(key, {
          hasSnapshot: true,
          position: null,
          previousPosition: 7,
          rankingStatus: "CHECK_FAILED",
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

  it("A. latest CHECK_FAILED with preserved #7 (UI: Ranking unavailable) -> eligible", () => {
    const map = pairMap({
      "k1:desktop": "CHECK_FAILED_preserved_7",
      "k1:mobile": "CHECK_FAILED_preserved_7",
    });
    expect(classifyKeywordFromPairFacts(map, "k1", "both")).toEqual({
      eligible: true,
      bucket: "ranking_unavailable",
    });
  });

  it("E. Desktop RANKED #5 + Mobile CHECK_FAILED (both scope) -> eligible, desktop never masks mobile", () => {
    const map = pairMap({
      "k1:desktop": "5",
      "k1:mobile": "CHECK_FAILED",
    });
    expect(classifyKeywordFromPairFacts(map, "k1", "both")).toEqual({
      eligible: true,
      bucket: "ranking_unavailable",
    });
  });

  it("F. Desktop RANKED #5 + Mobile LOST (both scope) -> eligible", () => {
    const map = pairMap({ "k1:desktop": "5", "k1:mobile": "lost" });
    expect(classifyKeywordFromPairFacts(map, "k1", "both")).toEqual({
      eligible: true,
      bucket: "lost",
    });
  });

  it("device scope: mobile-only config ignores the desktop pair entirely", () => {
    const map = pairMap({ "k1:desktop": "5", "k1:mobile": "5" });
    // Mobile is ranked; desktop's rank must not leak into a mobile scope.
    expect(classifyKeywordFromPairFacts(map, "k1", "mobile")).toEqual({
      eligible: false,
      bucket: null,
    });
    // Same pairs, desktop scope is irrelevant when only mobile is tracked.
    const mobileMissing = pairMap({ "k1:desktop": "5", "k1:mobile": "lost" });
    expect(classifyKeywordFromPairFacts(mobileMissing, "k1", "mobile")).toEqual(
      {
        eligible: true,
        bucket: "lost",
      },
    );
  });

  it("untracked device pairs fall back to not_checked (never checked)", () => {
    expect(classifyKeywordFromPairFacts(new Map(), "k1", "both")).toEqual({
      eligible: true,
      bucket: "no_ranking",
    });
  });
});

describe("state transitions after a retry (H/I)", () => {
  it("H. previous #5 + CHECK_FAILED, retry succeeds #8 -> becomes RANKED, leaves the missing set; #5 preserved in facts", () => {
    // Before retry: latest attempt failed, older valid #5 preserved.
    const before = {
      hasSnapshot: true,
      position: null,
      previousPosition: 5,
      rankingStatus: "CHECK_FAILED" as const,
    };
    expect(classifyDeviceRankingState(before)).toBe("ranking_unavailable");

    // After retry succeeds: the NEW snapshot is the latest attempt —
    // RANKED #8 with previousPosition pointing at the failed attempt's
    // preserved baseline. The historical #5 stays in the snapshot history
    // (this classifier only reads the latest row; nothing is rewritten).
    const after = {
      hasSnapshot: true,
      position: 8,
      previousPosition: 5,
      rankingStatus: "RANKED" as const,
    };
    expect(classifyDeviceRankingState(after)).toBe("ranked");
    expect(isMissingRankingState(classifyDeviceRankingState(after))).toBe(
      false,
    );
  });

  it("I. previous #5 + CHECK_FAILED, retry fails again -> remains Ranking unavailable, still eligible", () => {
    const after = {
      hasSnapshot: true,
      position: null,
      previousPosition: 5,
      rankingStatus: "CHECK_FAILED" as const,
    };
    expect(classifyDeviceRankingState(after)).toBe("ranking_unavailable");
    expect(isMissingRankingState(classifyDeviceRankingState(after))).toBe(true);
  });

  it("lost keyword rechecked and still absent -> latest row classifies from its own facts (stays eligible)", () => {
    // New NO_RESULT row: previousPosition is resolved from the prior valid
    // observation (which was itself NO_RESULT) — either bucket keeps the
    // keyword eligible.
    const stillAbsent = {
      hasSnapshot: true,
      position: null,
      previousPosition: null,
      rankingStatus: "NO_RESULT" as const,
    };
    const stillEligible = classifyDeviceRankingState(stillAbsent);
    expect(["no_ranking", "lost"]).toContain(stillEligible);
    expect(isMissingRankingState(stillEligible)).toBe(true);
  });

  it("noRankingFacts() yields the never-checked state", () => {
    expect(classifyDeviceRankingState(noRankingFacts())).toBe("not_checked");
  });
});
