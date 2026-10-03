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
  detectEngagementDrop,
  engagementDropDetector,
  isEngagementDropInput,
  type EngagementDropInput,
} from "./engagementDrop";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minSessionsPerWindow: 100,
      declineRatio: 0.25,
      rankHoldRequired: true,
    },
    thresholdVersion: 3,
  };
}

function row(
  overrides: Partial<EngagementDropInput["rows"][number]> = {},
): EngagementDropInput["rows"][number] {
  return {
    page: "https://example.com/guide",
    currentSessions: 1400,
    previousSessions: 1400,
    currentEngaged: 560,
    previousEngaged: 1120,
    currentRate: 0.4,
    previousRate: 0.8,
    rankWorsened: false,
    gscClicks: 300,
    factIds: ["f1"],
    ...overrides,
  };
}

function input(
  overrides: Partial<EngagementDropInput> = {},
): EngagementDropInput {
  return {
    periodFrom: "2026-02-01",
    periodTo: "2026-02-28",
    previousFrom: "2026-01-04",
    previousTo: "2026-01-31",
    windowDays: 28,
    rankAvailable: true,
    rows: [row()],
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minSessionsPerWindow: 100,
      declineRatio: 0.25,
      rankHoldRequired: true,
    },
    ...overrides,
  };
}

describe("engagement_drop detection (spec 010, C2c)", () => {
  it("emits a per-page finding with frozen evidence when rank held", () => {
    const findings = detectEngagementDrop(ctx(), input());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    expect(finding.entityKey).toBe("https://example.com/guide");
    expect(finding.entity).toMatchObject({
      page: "https://example.com/guide",
      scope: "page",
    });
    expect(finding.explanationFact).toContain("https://example.com/guide");
    expect(finding.explanationFact).toContain("while tracked rank held");
    expect(finding.explanationFact).not.toMatch(/caused|because of|due to/i);
    expect(finding.evidence.metrics).toMatchObject({
      page: "https://example.com/guide",
      rateBefore: 0.8,
      rateAfter: 0.4,
      sessionsBefore: 1400,
      sessionsAfter: 1400,
      windowDays: 28,
    });
    expect(finding.evidence.metrics.changeRatio).toBeCloseTo(-0.5);
    expect(finding.evidence.sources).toEqual(["ga4", "rank"]);
    expect(finding.evidence.partialData).toEqual([]);
    expect(finding.evidence.evidenceType).toBe("observational");
    expect(finding.confidenceScore).toBe(70);
  });

  it("defers to ranking_drop when rank worsened", () => {
    const findings = detectEngagementDrop(
      ctx(),
      input({ rows: [row({ rankWorsened: true })] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("emits with capped confidence and a partial note when rank is absent", () => {
    const findings = detectEngagementDrop(
      ctx(),
      input({ rows: [row({ rankWorsened: null })], rankAvailable: false }),
    );
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    expect(finding.evidence.sources).toEqual(["ga4"]);
    expect(finding.evidence.partialData).toEqual(["rank_corroboration_absent"]);
    expect(finding.confidenceScore).toBe(55);
  });

  it("enforces the sessions floor on both windows", () => {
    expect(
      detectEngagementDrop(
        ctx(),
        input({ rows: [row({ currentSessions: 50 })] }),
      ),
    ).toHaveLength(0);
    expect(
      detectEngagementDrop(
        ctx(),
        input({ rows: [row({ previousSessions: 50 })] }),
      ),
    ).toHaveLength(0);
    expect(
      detectEngagementDrop(
        ctx(),
        input({
          rows: [row({ currentSessions: 100, previousSessions: 100 })],
        }),
      ),
    ).toHaveLength(1);
  });

  it("needs a baseline rate and emits drops only", () => {
    expect(
      detectEngagementDrop(
        ctx(),
        input({
          rows: [
            row({
              previousRate: 0,
              previousEngaged: 0,
              currentRate: 0.5,
              currentEngaged: 700,
            }),
          ],
        }),
      ),
    ).toHaveLength(0);
    expect(
      detectEngagementDrop(
        ctx(),
        input({
          rows: [
            row({
              previousRate: 0.4,
              currentRate: 0.38,
              previousEngaged: 560,
              currentEngaged: 532,
            }),
          ],
        }),
      ),
    ).toHaveLength(0);
    expect(
      detectEngagementDrop(
        ctx(),
        input({
          rows: [
            row({
              previousRate: 0.4,
              currentRate: 0.6,
              previousEngaged: 560,
              currentEngaged: 840,
            }),
          ],
        }),
      ),
    ).toHaveLength(0);
  });

  it("rejects mistyped inputs loudly", () => {
    expect(() => engagementDropDetector.detect(ctx(), { rows: [] })).toThrow(
      "engagement_drop: mistyped input",
    );
    expect(isEngagementDropInput(input())).toBe(true);
    expect(isEngagementDropInput({ rows: "nope" })).toBe(false);
  });
});
