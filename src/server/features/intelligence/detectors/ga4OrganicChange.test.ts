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
  detectGa4Change,
  isGa4ChangeInput,
  type Ga4ChangeInput,
} from "./ga4OrganicChange";

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

function input(overrides: Partial<Ga4ChangeInput> = {}): Ga4ChangeInput {
  return {
    periodFrom: "2026-01-08",
    periodTo: "2026-01-14",
    previousFrom: "2026-01-01",
    previousTo: "2026-01-07",
    current: { sessions: 670, days: 7, expectedDays: 7 },
    previous: { sessions: 1000, days: 7, expectedDays: 7 },
    propertyId: "properties/123",
    thresholds: { minWindowDays: 7, minCoverageRatio: 0.8, declineRatio: 0.2 },
    ...overrides,
  };
}

describe("ga4_organic_change", () => {
  it("emits a sessions decline with GA4 provenance", () => {
    const findings = detectGa4Change(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe("site");
    expect(findings[0]?.evidence.metrics.changeRatio).toBeCloseTo(-0.33, 5);
    expect(findings[0]?.evidence.sources).toEqual(["ga4"]);
    expect(findings[0]?.evidence.sourceRefs?.ga4Keys).toHaveLength(1);
    expect(findings[0]?.explanationFact).toContain("GA4 sessions fell");
  });

  it("emits growth past the ratio", () => {
    const findings = detectGa4Change(
      ctx(),
      input({
        current: { sessions: 1300, days: 7, expectedDays: 7 },
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.explanationFact).toContain("grew");
  });

  it("stays silent inside the band and on zero baselines", () => {
    expect(
      detectGa4Change(
        ctx(),
        input({ current: { sessions: 900, days: 7, expectedDays: 7 } }),
      ),
    ).toHaveLength(0);
    expect(
      detectGa4Change(
        ctx(),
        input({
          previous: { sessions: 0, days: 7, expectedDays: 7 },
          current: { sessions: 50, days: 7, expectedDays: 7 },
        }),
      ),
    ).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isGa4ChangeInput(null)).toBe(false);
    expect(isGa4ChangeInput({ current: { sessions: 1 } })).toBe(false);
    expect(isGa4ChangeInput(input())).toBe(true);
  });
});
