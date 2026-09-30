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
  STRIKING_DISTANCE_MAX_POSITION,
  STRIKING_DISTANCE_MIN_POSITION,
} from "@/shared/intelligence";
import {
  detectStrikingDistance,
  isStrikingDistanceInput,
  type StrikingDistanceInput,
} from "./strikingDistance";

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
      minPosition: STRIKING_DISTANCE_MIN_POSITION,
      maxPosition: STRIKING_DISTANCE_MAX_POSITION,
    },
    thresholdVersion: 2,
  };
}

function row(overrides: Partial<StrikingDistanceInput["rows"][number]> = {}) {
  return {
    query: "best running shoes",
    impressions: 5000,
    clicks: 25,
    position: 15,
    days: 28,
    previousPosition: null as number | null,
    factIds: ["f1"],
    ...overrides,
  };
}

function input(
  overrides: Partial<StrikingDistanceInput> = {},
): StrikingDistanceInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    rows: [row()],
    thresholds: {
      minWindowDays: 28,
      minImpressions: 100,
      minPosition: STRIKING_DISTANCE_MIN_POSITION,
      maxPosition: STRIKING_DISTANCE_MAX_POSITION,
    },
    ...overrides,
  };
}

describe("striking_distance band constants", () => {
  it("pins the clarified 11–20 band", () => {
    expect(STRIKING_DISTANCE_MIN_POSITION).toBe(11);
    expect(STRIKING_DISTANCE_MAX_POSITION).toBe(20);
  });
});

describe("striking_distance detection", () => {
  it("emits an in-band above-floor query with echoed thresholds", () => {
    const findings = detectStrikingDistance(ctx(), input());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    expect(finding.entityKey).toBe("best running shoes");
    expect(finding.explanationFact).toContain("position 15.0");
    expect(finding.explanationFact).not.toMatch(/caused|because of|due to/i);
    expect(finding.evidence.thresholdsApplied).toMatchObject({
      minPosition: 11,
      maxPosition: 20,
      minImpressions: 100,
    });
    expect(finding.evidence.evidenceType).toBe("observational");
    expect(finding.evidence.sources).toContain("gsc");
    expect(finding.evidence.sourceRefs?.gscFactIds).toEqual(["f1"]);
    expect(finding.evidence.correlations).toEqual([]);
    expect(finding.confidenceScore).toBeGreaterThanOrEqual(60);
  });

  it("keeps band edges: 10 and 21 out, 11 and 20 in", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({
        rows: [
          row({ query: "just above", position: 10 }),
          row({ query: "edge min", position: 11, factIds: ["f11"] }),
          row({ query: "edge max", position: 20, factIds: ["f20"] }),
          row({ query: "just below", position: 21, factIds: ["f21"] }),
        ],
      }),
    );
    expect(
      findings.map((finding) => finding.evidence.metrics.position),
    ).toEqual([11, 20]);
  });

  it("rejects out-of-band edges explicitly", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({
        rows: [
          row({ query: "p1", position: 10 }),
          row({ query: "p21", position: 21, factIds: ["fx"] }),
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores below-floor impressions (insufficient-data negative)", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({ rows: [row({ impressions: 50, position: 14 })] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("collapses multi-URL queries to one per-query entity with potential wording", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({
        rows: [
          row({
            query: "multi url",
            impressions: 400,
            clicks: 30,
            position: 12,
            days: 20,
            factIds: ["m1"],
          }),
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    // Entity is per query (canonical form); the multi-URL page-level split
    // is named "potential" via partialData by the query-grain fetcher, so
    // split attribution never claims a single-URL cause.
    expect(finding.entityKey).toBe("multi url");
    expect(finding.explanationFact).toContain("potential");
  });

  it("rejects mistyped input via the guard", () => {
    expect(isStrikingDistanceInput({ rows: "nope" })).toBe(false);
    expect(isStrikingDistanceInput(input())).toBe(true);
  });
});

describe("striking_distance failure modes (US2)", () => {
  it("ignores every below-floor row while skipping in-band peers", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({
        rows: [
          row({ query: "thin", impressions: 60, position: 13 }),
          row({ query: "healthy", position: 14, factIds: ["h1"] }),
        ],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe("healthy");
  });

  it("surfaces per-query coverage days as skip context, not zeros", () => {
    const findings = detectStrikingDistance(
      ctx(),
      input({
        rows: [row({ days: 9, position: 13 })],
      }),
    );
    // Partial coverage does NOT zero or fabricate; the fetcher layer blocks
    // the whole window pre-invocation (insufficient_coverage skip), and the
    // pure detector records the reduced observation count in evidence.
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    expect(finding.coverageFlags.queryCoverageDays).toBe(9);
  });
});