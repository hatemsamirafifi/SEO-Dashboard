import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("pure detector tests must not touch the database");
      },
    },
  ),
}));

import {
  detectRankingDrop,
  isRankDropInput,
  type RankDropInput,
} from "./rankingDrop";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: { dropPositions: 5, topNTier: 20 },
    thresholdVersion: 2,
  };
}

function pair(overrides: Partial<RankDropInput["pairs"][number]> = {}) {
  return {
    trackingKeywordId: "kw-1",
    keyword: "Running Shoes",
    device: "desktop",
    locationCode: 2840,
    previousPosition: 8,
    currentPosition: 15 as number | null,
    previousSnapshotId: 1,
    currentSnapshotId: 2,
    previousRunAt: "2026-01-01T00:00:00.000Z",
    currentRunAt: "2026-01-08T00:00:00.000Z",
    url: "https://example.com/shoes",
    ...overrides,
  };
}

function input(overrides: Partial<RankDropInput> = {}): RankDropInput {
  return {
    pairs: [pair()],
    clicksAgreementByKeyword: {},
    gscAvailable: false,
    thresholds: { dropPositions: 5, topNTier: 20 },
    ...overrides,
  };
}

describe("ranking_drop", () => {
  it("emits a top-tier drop with device+market identity", () => {
    const findings = detectRankingDrop(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe("rank:running shoes:desktop:2840");
    expect(findings[0]?.evidence.metrics.dropPositions).toBe(7);
    expect(findings[0]?.evidence.sourceRefs?.rankSnapshotIds).toEqual([1, 2]);
    expect(findings[0]?.evidence.partialData).toContain(
      "gsc_corroboration_unavailable",
    );
  });

  it("treats index exit (null) as a drop to 101", () => {
    const findings = detectRankingDrop(
      ctx(),
      input({ pairs: [pair({ currentPosition: null })] }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.metrics.positionAfter).toBe(101);
  });

  it("raises confidence on GSC click agreement", () => {
    const findings = detectRankingDrop(
      ctx(),
      input({
        clicksAgreementByKeyword: { "running shoes": true },
        gscAvailable: true,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidenceScore).toBeGreaterThan(60);
    expect(findings[0]?.explanationFact).toContain("matching click declines");
  });

  it("ignores sub-tier baselines and small moves", () => {
    expect(
      detectRankingDrop(
        ctx(),
        input({ pairs: [pair({ previousPosition: 35, currentPosition: 50 })] }),
      ),
    ).toHaveLength(0);
    expect(
      detectRankingDrop(
        ctx(),
        input({ pairs: [pair({ previousPosition: 8, currentPosition: 10 })] }),
      ),
    ).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isRankDropInput(null)).toBe(false);
    expect(isRankDropInput({ pairs: [] })).toBe(false);
    expect(isRankDropInput(input())).toBe(true);
  });
});
