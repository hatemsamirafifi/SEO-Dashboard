import { describe, expect, it } from "vitest";
import {
  autopilotRecommendationSchema,
  containsUpliftPattern,
  serializeRecommendation,
  serializeRecommendations,
} from "./autopilotSerializer";

function baseRecommendation(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    evidence: { metrics: "clicks 120 → 80", periods: "28d vs prior 28d" },
    dataSource: "opportunity:organic_traffic_change:/pricing",
    reasoningSummary:
      "Pricing traffic decreased during the same period as the overlapping signals",
    confidence: {
      value: 65,
      why: "overlap across signals without proving a link",
    },
    expectedImpact: {
      kind: "qualitative",
      explanation: "Direction is clear; sizing needs a stable baseline",
    },
    suggestedAction:
      "Inspect /pricing in analytics and compare the same windows",
    ...overrides,
  };
}

describe("autopilotSerializer", () => {
  it("accepts an observational recommendation with correlation-only phrasing", () => {
    const parsed = serializeRecommendation(baseRecommendation());
    expect(parsed.evidenceType).toBe("observational");
    expect(parsed.confidence.value).toBe(65);
  });

  it("rejects banned causal verbs under observational evidence", () => {
    expect(() =>
      serializeRecommendation(
        baseRecommendation({ reasoningSummary: "The update caused the drop" }),
      ),
    ).toThrow("causal");
  });

  it("rejects due-to and led-to phrasing under observational evidence", () => {
    expect(() =>
      serializeRecommendation(
        baseRecommendation({ reasoningSummary: "Drop due to the migration" }),
      ),
    ).toThrow();
    expect(() =>
      serializeRecommendation(
        baseRecommendation({ suggestedAction: "Fix what led to the drop" }),
      ),
    ).toThrow();
  });

  it("allows causal phrasing for provider-confirmed evidence", () => {
    const parsed = serializeRecommendation(
      baseRecommendation({
        evidenceType: "provider_confirmed",
        reasoningSummary: "Provider confirmed the outage caused the drop",
      }),
    );
    expect(parsed.evidenceType).toBe("provider_confirmed");
  });

  it("rejects quantified impact without a basis", () => {
    expect(() =>
      serializeRecommendation(
        baseRecommendation({
          expectedImpact: { kind: "quantified", value: "+22%" },
        }),
      ),
    ).toThrow();
  });

  it("rejects qualitative impact without an explanation", () => {
    expect(() =>
      serializeRecommendation(
        baseRecommendation({ expectedImpact: { kind: "qualitative" } }),
      ),
    ).toThrow();
  });

  it("accepts quantified impact with a basis", () => {
    const parsed = serializeRecommendation(
      baseRecommendation({
        expectedImpact: {
          kind: "quantified",
          value: "+12%",
          basis: "prior 28d baseline of 1,000 sessions",
        },
      }),
    );
    expect(parsed.expectedImpact.kind).toBe("quantified");
  });

  it("rejects a causedBy field (no causal key exists)", () => {
    expect(() =>
      autopilotRecommendationSchema.parse({
        ...baseRecommendation(),
        causedBy: "migration",
      }),
    ).toThrow();
  });

  // Spec 013 (Setup T003): mechanical uplift ban over synthesized recommendation
  // JSON — new workflows may never emit unsupported uplift percentages (SC-001).
  it("detects uplift percentages in recommendation text", () => {
    expect(containsUpliftPattern("increase traffic by 25%")).toBe(true);
    expect(containsUpliftPattern("expect +12% more sessions")).toBe(true);
    expect(
      containsUpliftPattern(
        "Sessions decreased during the same period as the overlapping signals",
      ),
    ).toBe(false);
    expect(
      containsUpliftPattern("Direction is clear; sizing needs a baseline"),
    ).toBe(false);
  });

  it("bulk serializes with an observational default", () => {
    const [first, second] = serializeRecommendations([
      baseRecommendation(),
      baseRecommendation({
        dataSource: "opportunity:ranking_drop:head-term",
        reasoningSummary: "Head term decreased during the same period",
      }),
    ]);
    expect(first?.evidenceType).toBe("observational");
    expect(second?.dataSource).toContain("ranking_drop");
  });
});
