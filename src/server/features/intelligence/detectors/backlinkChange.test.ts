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
  detectBacklinkChange,
  isBacklinkChangeInput,
  type BacklinkChangeInput,
} from "./backlinkChange";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: { minSnapshots: 2, freshnessDays: 30 },
    thresholdVersion: 2,
  };
}

function totals(overrides = {}) {
  return {
    backlinks: 1000,
    referringDomains: 120,
    brokenBacklinks: 5,
    newBacklinks: 10,
    lostBacklinks: 4,
    newReferringDomains: 3,
    lostReferringDomains: 1,
    ...overrides,
  };
}

function input(
  overrides: Partial<BacklinkChangeInput> = {},
): BacklinkChangeInput {
  return {
    domain: "example.com",
    before: totals({ referringDomains: 118 }),
    after: totals({ referringDomains: 120 }),
    beforeCapturedAt: "2026-01-01T00:00:00.000Z",
    afterCapturedAt: "2026-01-10T00:00:00.000Z",
    thresholds: { minSnapshots: 2, freshnessDays: 30 },
    ...overrides,
  };
}

describe("backlink_change", () => {
  it("emits a labeled heuristic on movement", () => {
    const findings = detectBacklinkChange(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe("backlinks:example.com");
    expect(findings[0]?.explanationFact).toContain("Heuristic (two snapshots)");
    expect(findings[0]?.evidence.partialData).toContain("two_point_heuristic");
    expect(findings[0]?.evidence.metrics.referringDomainsDelta).toBe(2);
    expect(findings[0]?.confidenceScore).toBeLessThanOrEqual(69);
  });

  it("stays silent on zero movement (valid zero input)", () => {
    const still = totals({
      newBacklinks: 0,
      lostBacklinks: 0,
      newReferringDomains: 0,
      lostReferringDomains: 0,
    });
    expect(
      detectBacklinkChange(ctx(), input({ before: still, after: still })),
    ).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isBacklinkChangeInput(null)).toBe(false);
    expect(isBacklinkChangeInput({ domain: "x" })).toBe(false);
    expect(isBacklinkChangeInput(input())).toBe(true);
  });
});
