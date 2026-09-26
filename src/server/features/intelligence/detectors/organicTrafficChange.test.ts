import { describe, expect, it, vi } from "vitest";

// Pure detect tests never touch the database; the fetcher's repository
// imports pull in `@/db`, so fail loudly if anything reaches for it.
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
  detectOrganicTrafficChange,
  isTrafficChangeInput,
  type TrafficChangeInput,
} from "./organicTrafficChange";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: { minWindowDays: 7, minCoverageRatio: 0.8, declineRatio: 0.2 },
    thresholdVersion: 2,
  };
}

function input(
  overrides: Partial<TrafficChangeInput> = {},
): TrafficChangeInput {
  return {
    periodFrom: "2026-01-08",
    periodTo: "2026-01-14",
    previousFrom: "2026-01-01",
    previousTo: "2026-01-07",
    current: { clicks: 845, impressions: 12000, days: 7, expectedDays: 7 },
    previous: { clicks: 1240, impressions: 15000, days: 7, expectedDays: 7 },
    factIds: ["fact-1"],
    thresholds: { minWindowDays: 7, minCoverageRatio: 0.8, declineRatio: 0.2 },
    ...overrides,
  };
}

describe("organic_traffic_change", () => {
  it("emits a decline finding with the exact change ratio", () => {
    const findings = detectOrganicTrafficChange(ctx(), input());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    expect(finding?.entityKey).toBe("site");
    expect(finding?.evidence.metrics.changeRatio).toBeCloseTo(
      (845 - 1240) / 1240,
      5,
    );
    expect(finding?.evidence.thresholdsApplied).toMatchObject({
      minWindowDays: 7,
      minCoverageRatio: 0.8,
      declineRatio: 0.2,
    });
    expect(finding?.explanationFact).toContain("fell");
    expect(finding?.confidenceScore).toBeGreaterThanOrEqual(40);
  });

  it("emits growth past the ratio with growth wording", () => {
    const findings = detectOrganicTrafficChange(
      ctx(),
      input({
        current: { clicks: 1600, impressions: 18000, days: 7, expectedDays: 7 },
        previous: {
          clicks: 1240,
          impressions: 15000,
          days: 7,
          expectedDays: 7,
        },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.explanationFact).toContain("grew");
  });

  it("stays silent inside the ratio band", () => {
    const findings = detectOrganicTrafficChange(
      ctx(),
      input({
        current: { clicks: 1150, impressions: 14000, days: 7, expectedDays: 7 },
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("stays silent on zero baselines (no ratio without a baseline)", () => {
    const empty = {
      clicks: 0,
      impressions: 0,
      days: 7,
      expectedDays: 7,
    };
    expect(
      detectOrganicTrafficChange(
        ctx(),
        input({ current: empty, previous: empty }),
      ),
    ).toHaveLength(0);
    expect(
      detectOrganicTrafficChange(
        ctx(),
        input({
          previous: empty,
          current: { clicks: 50, impressions: 400, days: 7, expectedDays: 7 },
        }),
      ),
    ).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isTrafficChangeInput(null)).toBe(false);
    expect(isTrafficChangeInput({ current: { clicks: 1 } })).toBe(false);
    expect(isTrafficChangeInput(input())).toBe(true);
  });
});
