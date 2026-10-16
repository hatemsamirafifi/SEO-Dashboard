// Spec 014 (T009): deterministic verdict evaluation tests (pure functions, no DB)
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({ db: {} }));
vi.mock("@/db/runBatch", () => ({ runBatch: vi.fn() }));

import { evaluateVerdict } from "./verdictLedger";
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapSpikeThresholds,
} from "@/shared/competitorGap";

const THRESHOLDS: CompetitorGapSpikeThresholds = {
  minKeywordCoverageRatio: 0.5,
  minFirstPartyCoverageRatio: 0.5,
  maxCostPerAnalysisCredits: 100,
  repeatCacheHitRate: 1.0,
  identityCollisionsAllowed: 0,
};

function passingEvidence(): CompetitorGapSpikeEvidence {
  return {
    quality: {
      status: "measured",
      value: { keywordCoverageRatio: 0.9, requiredFieldMissingRate: 0.01 },
    },
    coverage: {
      status: "measured",
      value: {
        firstPartyCoverageRatio: 0.9,
        window: { from: "2026-09-11", to: "2026-10-09" },
      },
    },
    cost: {
      status: "measured",
      value: {
        measuredCreditsPerAnalysis: 50,
        extrapolatedMonthlyPerProject: 200,
      },
    },
    identity: {
      status: "measured",
      value: { collisionsObserved: 0, nonDeterministicMappings: 0 },
    },
    cache: {
      status: "measured",
      value: { repeatAnalysisPaidCalls: 0, repeatCacheHitRate: 1 },
    },
  };
}

function patchEvidence(
  evidence: CompetitorGapSpikeEvidence,
  dimension: keyof CompetitorGapSpikeEvidence,
  patch: Record<string, number>,
): CompetitorGapSpikeEvidence {
  const dimensionResult = evidence[dimension];
  if (dimensionResult.status !== "measured") {
    throw new Error("fixture must be measured");
  }
  return {
    ...evidence,
    [dimension]: {
      status: "measured",
      value: { ...dimensionResult.value, ...patch },
    },
  };
}

function unavailableEvidence(
  dimension: keyof CompetitorGapSpikeEvidence,
  reason: string,
): CompetitorGapSpikeEvidence {
  return {
    ...passingEvidence(),
    [dimension]: { status: "unavailable", reason },
  };
}

describe("evaluateVerdict (T009 — deterministic evaluation)", () => {
  it("returns READY when every dimension passes every threshold", () => {
    const verdict = evaluateVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
    });
    expect(verdict).toBe("COMPETITOR_GAP_READY");
  });

  it("boundary equality passes (strict < and > only)", () => {
    const atBoundary = patchEvidence(passingEvidence(), "quality", {
      keywordCoverageRatio: THRESHOLDS.minKeywordCoverageRatio,
    });
    expect(
      evaluateVerdict({ evidence: atBoundary, thresholds: THRESHOLDS }),
    ).toBe("COMPETITOR_GAP_READY");
  });

  it("BLOCKED when identity collisions exceed the allowance", () => {
    const evidence = patchEvidence(passingEvidence(), "identity", {
      collisionsObserved: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when identity is non-deterministic at all", () => {
    const evidence = patchEvidence(passingEvidence(), "identity", {
      nonDeterministicMappings: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when repeat cache hit rate is below the required rate", () => {
    const evidence = patchEvidence(passingEvidence(), "cache", {
      repeatCacheHitRate: 0.5,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when the repeat analysis made any paid calls", () => {
    const evidence = patchEvidence(passingEvidence(), "cache", {
      repeatAnalysisPaidCalls: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when measured credits exceed the cap", () => {
    const evidence = patchEvidence(passingEvidence(), "cost", {
      measuredCreditsPerAnalysis: THRESHOLDS.maxCostPerAnalysisCredits + 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when keyword coverage is below the minimum", () => {
    const evidence = patchEvidence(passingEvidence(), "quality", {
      keywordCoverageRatio: THRESHOLDS.minKeywordCoverageRatio - 0.01,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when first-party coverage is below the minimum", () => {
    const evidence = patchEvidence(passingEvidence(), "coverage", {
      firstPartyCoverageRatio: THRESHOLDS.minFirstPartyCoverageRatio - 0.01,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when ANY dimension is unavailable — failure is never data (P8/P9)", () => {
    for (const dimension of [
      "quality",
      "coverage",
      "cost",
      "identity",
      "cache",
    ] as const) {
      const evidence = unavailableEvidence(
        dimension,
        "provider failure during measurement",
      );
      expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
        "COMPETITOR_GAP_BLOCKED",
      );
    }
  });
});
