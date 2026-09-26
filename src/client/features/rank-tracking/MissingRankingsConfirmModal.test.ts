import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn(), env: {} }));
vi.mock("@/serverFunctions/rank-tracking", () => ({
  getMissingRankingsSummary: vi.fn(),
  triggerRankCheck: vi.fn(),
  cancelRankCheckRun: vi.fn(),
}));

import {
  calculateActiveCount,
  calculateEtaSeconds,
  formatEta,
  isRunButtonDisabled,
  STATE_OPTIONS,
} from "./MissingRankingsConfirmModal";
import {
  estimateRankCheckCredits,
  type MissingRankingsBreakdown,
} from "@/shared/rank-tracking";

describe("MissingRankingsConfirmModal dynamic state and count calculations", () => {
  const sampleBreakdown: MissingRankingsBreakdown = {
    ranking_unavailable: 571,
    lost: 15,
    no_ranking: 91,
  };

  it("1. default: all three states are defined in STATE_OPTIONS", () => {
    expect(STATE_OPTIONS.map((o) => o.key)).toEqual([
      "ranking_unavailable",
      "lost",
      "no_ranking",
    ]);
  });

  it("2. all states selected -> full eligible count (677)", () => {
    const count = calculateActiveCount(sampleBreakdown, [
      "ranking_unavailable",
      "lost",
      "no_ranking",
    ]);
    expect(count).toBe(677);
  });

  it("3. Ranking unavailable only -> 571", () => {
    const count = calculateActiveCount(sampleBreakdown, [
      "ranking_unavailable",
    ]);
    expect(count).toBe(571);
  });

  it("4. Lost only -> 15", () => {
    const count = calculateActiveCount(sampleBreakdown, ["lost"]);
    expect(count).toBe(15);
  });

  it("5. No ranking only -> 91", () => {
    const count = calculateActiveCount(sampleBreakdown, ["no_ranking"]);
    expect(count).toBe(91);
  });

  it("6. Ranking unavailable + Lost -> 586", () => {
    const count = calculateActiveCount(sampleBreakdown, [
      "ranking_unavailable",
      "lost",
    ]);
    expect(count).toBe(586);
  });

  it("7. Lost + No ranking (Ranking unavailable OFF) -> 106", () => {
    const count = calculateActiveCount(sampleBreakdown, ["lost", "no_ranking"]);
    expect(count).toBe(106);
  });

  it("8. Clear all -> count 0", () => {
    const count = calculateActiveCount(sampleBreakdown, []);
    expect(count).toBe(0);
  });

  it("9. count 0 -> Run button disabled", () => {
    expect(isRunButtonDisabled(false, 0)).toBe(true);
    expect(isRunButtonDisabled(true, 0)).toBe(true);
    expect(isRunButtonDisabled(true, 677)).toBe(true);
    expect(isRunButtonDisabled(false, 677)).toBe(false);
    expect(isRunButtonDisabled(false, 15)).toBe(false);
  });

  it("10. Select all restores full count (677)", () => {
    const clearCount = calculateActiveCount(sampleBreakdown, []);
    expect(clearCount).toBe(0);
    const restoredCount = calculateActiveCount(sampleBreakdown, [
      "ranking_unavailable",
      "lost",
      "no_ranking",
    ]);
    expect(restoredCount).toBe(677);
  });

  it("11. cost recalculates dynamically with selected count", () => {
    // 677 keywords on desktop (depth 10) matches prompt example (~$1.73)
    const fullCost = estimateRankCheckCredits(677, "desktop", 10, "live");
    expect(fullCost.costUsd).toBeCloseTo(1.73, 2);

    // 106 keywords (Lost + No ranking) -> ~$0.27
    const partialCost = estimateRankCheckCredits(106, "desktop", 10, "live");
    expect(partialCost.costUsd).toBeCloseTo(0.27, 2);
    expect(partialCost.costUsd).toBeLessThan(fullCost.costUsd);

    // 15 keywords (Lost only) -> ~$0.04
    const lostOnlyCost = estimateRankCheckCredits(15, "desktop", 10, "live");
    expect(lostOnlyCost.costUsd).toBeCloseTo(0.04, 2);
    expect(lostOnlyCost.costUsd).toBeLessThan(partialCost.costUsd);

    // 0 keywords -> $0.00
    const zeroCost = estimateRankCheckCredits(0, "desktop", 10, "live");
    expect(zeroCost.costUsd).toBe(0);
  });

  it("12. ETA recalculates dynamically with selected count", () => {
    // 677 keywords on desktop -> ~7 min (matches prompt example)
    const fullEtaSec = calculateEtaSeconds(677, "desktop");
    expect(formatEta(fullEtaSec)).toBe("7 min");

    // 106 keywords on desktop -> ~1-2 min (matches prompt example)
    const partialEtaSec = calculateEtaSeconds(106, "desktop");
    expect(formatEta(partialEtaSec)).toMatch(/^[12] min$/);

    // 15 keywords on desktop -> 12s
    const lostEtaSec = calculateEtaSeconds(15, "desktop");
    expect(lostEtaSec).toBeLessThan(60);
    expect(formatEta(lostEtaSec)).toBe("12s");

    // 0 keywords -> 0s
    expect(formatEta(0)).toBe("0s");
  });

  it("13. explicit table selection breakdown filtering", () => {
    // 20 selected keywords on table: 7 unavailable, 3 lost, 2 no ranking, 8 ranked
    const tableSelectionBreakdown: MissingRankingsBreakdown = {
      ranking_unavailable: 7,
      lost: 3,
      no_ranking: 2,
    };

    // All missing selected: 7 + 3 + 2 = 12
    expect(
      calculateActiveCount(tableSelectionBreakdown, [
        "ranking_unavailable",
        "lost",
        "no_ranking",
      ]),
    ).toBe(12);

    // Lost only: 3
    expect(calculateActiveCount(tableSelectionBreakdown, ["lost"])).toBe(3);

    // No ranking only: 2
    expect(calculateActiveCount(tableSelectionBreakdown, ["no_ranking"])).toBe(
      2,
    );

    // Ranking unavailable only: 7
    expect(
      calculateActiveCount(tableSelectionBreakdown, ["ranking_unavailable"]),
    ).toBe(7);
  });
});
