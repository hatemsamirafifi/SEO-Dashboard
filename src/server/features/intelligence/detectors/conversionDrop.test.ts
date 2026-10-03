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
  conversionDropDetector,
  detectConversionDrop,
  isConversionDropInput,
  type ConversionDropInput,
} from "./conversionDrop";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minEventsPerWindow: 10,
      declineRatio: 0.3,
    },
    thresholdVersion: 3,
  };
}

function goal(
  overrides: Partial<ConversionDropInput["goals"][number]> = {},
): ConversionDropInput["goals"][number] {
  return {
    goalId: "goal-1",
    goalName: "Newsletter signup",
    eventName: "signup_completed",
    propertyId: "properties/42",
    current: { conversions: 3, days: 28 },
    previous: { conversions: 12, days: 28 },
    ...overrides,
  };
}

function input(
  overrides: Partial<ConversionDropInput> = {},
): ConversionDropInput {
  return {
    periodFrom: "2026-02-01",
    periodTo: "2026-02-28",
    previousFrom: "2026-01-04",
    previousTo: "2026-01-31",
    windowDays: 28,
    goals: [goal()],
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minEventsPerWindow: 10,
      declineRatio: 0.3,
    },
    ...overrides,
  };
}

describe("conversion_drop detection (spec 010, C2b)", () => {
  it("emits one site-level finding per goal with frozen evidence", () => {
    const findings = detectConversionDrop(ctx(), input());
    expect(findings).toHaveLength(1);
    const finding = findings[0];
    if (!finding) throw new Error("expected a finding");
    // Site-level entity: goal, not page.
    expect(finding.entityKey).toBe("goal:goal-1");
    expect(finding.entity).toMatchObject({
      scope: "goal",
      goalId: "goal-1",
      goalName: "Newsletter signup",
    });
    expect(finding.explanationFact).toContain("Newsletter signup");
    expect(finding.explanationFact).toContain("12 → 3");
    expect(finding.explanationFact).not.toMatch(/caused|because of|due to/i);
    expect(finding.evidence.metrics).toMatchObject({
      goalName: "Newsletter signup",
      goalId: "goal-1",
      conversionsBefore: 12,
      conversionsAfter: 3,
      windowDays: 28,
    });
    expect(finding.evidence.metrics.changeRatio).toBeCloseTo(-0.75);
    expect(finding.evidence.sources).toEqual(["ga4"]);
    expect(finding.evidence.sourceRefs?.ga4Keys).toHaveLength(1);
    expect(finding.evidence.evidenceType).toBe("observational");
    expect(finding.evidence.correlations).toEqual([]);
    // Separate impact/confidence scores (P26).
    expect(finding.confidenceScore).toBeGreaterThanOrEqual(40);
  });

  it("enforces the baseline floor: 12→3 emits, 2→0 never does", () => {
    expect(
      detectConversionDrop(
        ctx(),
        input({
          goals: [
            goal({
              goalId: "g-small",
              previous: { conversions: 2, days: 28 },
              current: { conversions: 0, days: 28 },
            }),
          ],
        }),
      ),
    ).toHaveLength(0);
    expect(
      detectConversionDrop(
        ctx(),
        input({
          goals: [
            goal({
              goalId: "g-edge",
              previous: { conversions: 10, days: 28 },
              current: { conversions: 6, days: 28 },
            }),
          ],
        }),
      ),
    ).toHaveLength(1);
  });

  it("emits drops only: growth and sub-threshold moves stay silent", () => {
    const growth = detectConversionDrop(
      ctx(),
      input({
        goals: [
          goal({
            previous: { conversions: 12, days: 28 },
            current: { conversions: 30, days: 28 },
          }),
        ],
      }),
    );
    expect(growth).toHaveLength(0);
    const drift = detectConversionDrop(
      ctx(),
      input({
        goals: [
          goal({
            previous: { conversions: 100, days: 28 },
            current: { conversions: 85, days: 28 },
          }),
        ],
      }),
    );
    expect(drift).toHaveLength(0);
  });

  it("needs a baseline: zero previous conversions never emit", () => {
    const findings = detectConversionDrop(
      ctx(),
      input({
        goals: [
          goal({
            previous: { conversions: 0, days: 28 },
            current: { conversions: 50, days: 28 },
          }),
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("emits one finding per goal, each with its own frozen name", () => {
    const findings = detectConversionDrop(
      ctx(),
      input({
        goals: [
          goal(),
          goal({
            goalId: "goal-2",
            goalName: "Demo request",
            eventName: "demo_request",
            previous: { conversions: 20, days: 28 },
            current: { conversions: 10, days: 28 },
          }),
          goal({
            goalId: "goal-3",
            goalName: "Steady",
            eventName: "steady_event",
            previous: { conversions: 50, days: 28 },
            current: { conversions: 48, days: 28 },
          }),
        ],
      }),
    );
    expect(findings.map((finding) => finding.entityKey).toSorted()).toEqual([
      "goal:goal-1",
      "goal:goal-2",
    ]);
  });

  it("rejects mistyped inputs loudly", () => {
    expect(() => conversionDropDetector.detect(ctx(), { goals: [] })).toThrow(
      "conversion_drop: mistyped input",
    );
    expect(isConversionDropInput(input())).toBe(true);
    expect(isConversionDropInput({ goals: "nope" })).toBe(false);
  });
});
