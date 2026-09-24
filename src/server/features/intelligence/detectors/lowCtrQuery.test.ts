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

import { detectLowCtr, isLowCtrInput, type LowCtrInput } from "./lowCtrQuery";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minImpressions: 100,
      positionBandMin: 5,
      positionBandMax: 20,
      ctrFloor: 0.01,
    },
    thresholdVersion: 2,
  };
}

function input(overrides: Partial<LowCtrInput> = {}): LowCtrInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    rows: [
      {
        query: "best running shoes",
        impressions: 5000,
        clicks: 20,
        position: 8.5,
        days: 28,
        factIds: ["f1"],
      },
    ],
    windowDays: 28,
    thresholds: {
      minWindowDays: 28,
      minImpressions: 100,
      positionBandMin: 5,
      positionBandMax: 20,
      ctrFloor: 0.01,
    },
    ...overrides,
  };
}

describe("low_ctr_query", () => {
  it("emits an in-band low-CTR query with echoed thresholds", () => {
    const findings = detectLowCtr(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe("best running shoes");
    expect(findings[0]?.evidence.metrics.ctr).toBeCloseTo(0.004, 5);
    expect(findings[0]?.evidence.thresholdsApplied).toMatchObject({
      minImpressions: 100,
      ctrFloor: 0.01,
    });
    expect(findings[0]?.evidence.partialData).toEqual([]);
  });

  it("ignores below-floor impressions (insufficient-data negative)", () => {
    const findings = detectLowCtr(
      ctx(),
      input({
        rows: [
          {
            query: "tiny query",
            impressions: 50,
            clicks: 0,
            position: 8,
            days: 28,
            factIds: ["f2"],
          },
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores out-of-band positions", () => {
    const rows = [
      {
        query: "top query",
        impressions: 5000,
        clicks: 10,
        position: 2,
        days: 28,
        factIds: ["f3"],
      },
      {
        query: "deep query",
        impressions: 5000,
        clicks: 5,
        position: 45,
        days: 28,
        factIds: ["f4"],
      },
    ];
    expect(detectLowCtr(ctx(), input({ rows }))).toHaveLength(0);
  });

  it("ignores CTR at or above the floor", () => {
    const findings = detectLowCtr(
      ctx(),
      input({
        rows: [
          {
            query: "good query",
            impressions: 5000,
            clicks: 300,
            position: 8,
            days: 28,
            factIds: ["f5"],
          },
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isLowCtrInput(null)).toBe(false);
    expect(isLowCtrInput({ rows: [] })).toBe(false);
    expect(isLowCtrInput(input())).toBe(true);
  });
});
