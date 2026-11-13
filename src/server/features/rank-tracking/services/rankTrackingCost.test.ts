import { describe, expect, it } from "vitest";
import { formatRankTrackingCost } from "./rankTrackingCost";

// The server-side cost estimate must price a manual "check now" the way it
// will actually run: single keyword live, anything larger queued — the same
// resolveRankCheckMethod rule the workflow and the client copy use.

describe("formatRankTrackingCost method-aware estimation", () => {
  const config = { devices: "both" as const, serpDepth: 40 };

  it("prices a single-keyword config at the LIVE method", () => {
    const result = formatRankTrackingCost(config, 1);
    expect(result.method).toBe("live");
    // The live price for the same scope is strictly higher than queued.
    const queuedShape = formatRankTrackingCost(config, 2);
    expect(queuedShape.method).toBe("queued");
    expect(result.costUsd).toBeGreaterThan(queuedShape.costUsd / 2);
  });

  it("prices a multi-keyword config at the QUEUED method", () => {
    const result = formatRankTrackingCost(config, 50);
    expect(result.method).toBe("queued");
    const single = formatRankTrackingCost(config, 1);
    // Per-check queued price is ~3.3x cheaper than live.
    expect(result.costUsd / 50).toBeLessThan(single.costUsd / 3);
  });

  it("still reports the check shape alongside the method", () => {
    const result = formatRankTrackingCost(config, 3);
    expect(result.keywordCount).toBe(3);
    expect(result.devicesCount).toBe(2);
  });
});
