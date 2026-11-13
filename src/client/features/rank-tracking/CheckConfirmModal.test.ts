import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ waitUntil: vi.fn(), env: {} }));

import { runNowCopy } from "./CheckConfirmModal";
import {
  estimateRankCheckCredits,
  QUEUED_RESULTS_WINDOW_TEXT,
} from "@/shared/rank-tracking";

describe("CheckConfirmModal run-now copy", () => {
  it("a single keyword: live method, instant ETA, live price", () => {
    const copy = runNowCopy({
      keywordCount: 1,
      devices: "both",
      serpDepth: 40,
    });
    expect(copy.method).toBe("live");
    // 1 keyword x 2 devices = 2 checks = 1 batch = ~6s (instant copy shown).
    expect(copy.etaText).toBe("Results in ~6s");
    const queuedCost = estimateRankCheckCredits(1, "both", 40, "queued");
    expect(copy.costUsd).toBeGreaterThan(queuedCost.costUsd);
  });

  it("multiple keywords: queued method, no instant time copy, queued price", () => {
    const copy = runNowCopy({
      keywordCount: 901,
      devices: "desktop",
      serpDepth: 20,
    });
    expect(copy.method).toBe("queued");
    // Bulk queued checks never show instant-results time.
    expect(copy.etaText).toBe(QUEUED_RESULTS_WINDOW_TEXT);
    expect(copy.etaText).not.toMatch(/~\d+(s| min)$/);
    const liveCost = estimateRankCheckCredits(901, "desktop", 20, "live");
    expect(copy.costUsd).toBeLessThan(liveCost.costUsd);
  });
});
