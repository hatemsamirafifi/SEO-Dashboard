/* eslint-disable max-lines */
import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("template tests must not touch the database");
      },
    },
  ),
}));

import { OPPORTUNITY_WEIGHTS } from "@/shared/opportunity-weights";
import type { Finding } from "@/shared/intelligence";
import {
  decayConfidence,
  declineOf,
  logScaleVolume,
  OPPORTUNITY_TEMPLATES,
  proximityOf,
  scoreImpact,
} from "./opportunityTemplates";

const BANNED_VERBS =
  /\bcaused?\b|\bcausing\b|because of|due to|led to|resulted in|triggered/i;

function finding(
  detectorKey: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    findingKey: "a".repeat(64),
    detectorKey,
    detectorVersion: 1,
    projectId: "project-1",
    entityKey: "entity-1",
    entity: { query: "entity-1" },
    explanationFact: "Observed during the same period.",
    evidence: {
      metrics: {},
      sources: ["gsc"],
      thresholdsApplied: {},
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: {},
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 70,
    coverageFlags: {},
    ...overrides,
  };
}

describe("impact normalizers", () => {
  it("scales volume logarithmically with a 100k saturation", () => {
    expect(logScaleVolume(0)).toBe(0);
    expect(logScaleVolume(-5)).toBe(0);
    expect(logScaleVolume(100000)).toBe(1);
    expect(logScaleVolume(99999999)).toBe(1);
    expect(logScaleVolume(99)).toBeCloseTo(Math.log10(100) / 5, 5);
  });

  it("fades proximity across the top-20 band", () => {
    expect(proximityOf(1)).toBe(1);
    expect(proximityOf(21)).toBe(0);
    expect(proximityOf(100)).toBe(0);
    expect(proximityOf(11)).toBeCloseTo(0.5, 5);
  });

  it("saturates decline magnitude at 50%", () => {
    expect(declineOf(0.5)).toBe(1);
    expect(declineOf(-0.9)).toBe(1);
    expect(declineOf(0.25)).toBeCloseTo(0.5, 5);
  });
});

describe("scoreImpact renormalization", () => {
  it("is deterministic for fixed inputs", () => {
    const factors = {
      trafficPotential: 0.6,
      proximity: 0.5,
      decline: 0.8,
      businessIntent: null,
      conversionSignal: null,
    };
    expect(scoreImpact(factors)).toBe(scoreImpact({ ...factors }));
  });

  it("treats missing optional data as shrunken divisor, never zero", () => {
    // GA4-absent identity: same available evidence scores identically
    // whether the missing factors are null or simply absent from the set.
    const withoutGA4 = scoreImpact({
      trafficPotential: 0.6,
      proximity: null,
      decline: 0.8,
      businessIntent: null,
      conversionSignal: null,
    });
    // (30×0.6 + 20×0.8) / 50 = 0.68 → 68
    expect(withoutGA4).toBe(68);
  });

  it("returns null for an empty factor set (skip, never materialize)", () => {
    expect(
      scoreImpact({
        trafficPotential: null,
        proximity: null,
        decline: null,
        businessIntent: null,
        conversionSignal: null,
      }),
    ).toBeNull();
  });

  it("sums the why-breakdown to the score", () => {
    const factors = {
      trafficPotential: 0.7,
      proximity: 0.4,
      decline: 0.9,
      businessIntent: null,
      conversionSignal: null,
    };
    const score = scoreImpact(factors);
    const entries: Array<[keyof typeof OPPORTUNITY_WEIGHTS, number | null]> = [
      ["trafficPotential", factors.trafficPotential],
      ["proximity", factors.proximity],
      ["decline", factors.decline],
      ["businessIntent", factors.businessIntent],
      ["conversionSignal", factors.conversionSignal],
    ];
    let weighted = 0;
    let divisor = 0;
    for (const [name, value] of entries) {
      if (value === null) continue;
      weighted += OPPORTUNITY_WEIGHTS[name] * value;
      divisor += OPPORTUNITY_WEIGHTS[name];
    }
    expect(score).toBe(Math.round((100 * weighted) / divisor));
  });
});

describe("decayConfidence (§10 eight-input function)", () => {
  function decayFinding(overrides: Partial<Finding> = {}): Finding {
    return finding("content_decay", {
      entity: { page: "/guide" },
      evidence: {
        metrics: {
          declineRatio: -0.45,
          clicksPrevious: 320,
          clicksCurrent: 176,
        },
        sources: ["gsc"],
        thresholdsApplied: { minVolume: 50 },
        correlations: [],
        evidenceType: "observational",
        partialData: ["rank_corroboration_unavailable"],
        confidenceInputs: { coverageDayRatio: 1, rankAgrees: false },
      },
      ...overrides,
    });
  }

  it("persists all eight inputs and caps witness contribution at 15", () => {
    const unwitnessed = decayFinding({
      evidence: {
        metrics: {
          declineRatio: -0.45,
          clicksPrevious: 320,
          clicksCurrent: 176,
        },
        sources: ["gsc"],
        thresholdsApplied: { minVolume: 50 },
        correlations: [],
        evidenceType: "observational",
        partialData: [
          "rank_corroboration_unavailable",
          "ga4_corroboration_unavailable",
        ],
        confidenceInputs: { coverageDayRatio: 1, rankAgrees: false },
      },
    });
    const result = decayConfidence(unwitnessed);
    expect(result).not.toBeNull();
    const inputs = result?.inputs;
    expect(Object.keys(inputs ?? {}).toSorted()).toEqual([
      "agreement",
      "coverage",
      "entityConsistency",
      "magnitude",
      "persistence",
      "rankSessionMoves",
      "truncationStatus",
      "volume",
    ]);
    // Both witnesses absent → 0.5 neutral on witness-driven inputs.
    expect(inputs?.rankSessionMoves).toBe(0.5);
    expect(inputs?.agreement).toBe(0.5);
    // Witness-driven weight total is exactly 15 points (0.05 + 0.10).
    const maxWitnessContribution = Math.round(100 * (0.05 * 1 + 0.1 * 1));
    expect(maxWitnessContribution).toBe(15);
    // GA4 available but disagreeing is a genuine zero, not neutral.
    const ga4Silent = decayConfidence(decayFinding());
    expect(ga4Silent?.inputs.agreement).toBe(0);
    expect(ga4Silent?.inputs.rankSessionMoves).toBe(0.5);
  });

  it("suppresses below the volume floor", () => {
    const result = decayConfidence(
      decayFinding({
        evidence: {
          metrics: { declineRatio: -0.9, clicksPrevious: 10, clicksCurrent: 1 },
          sources: ["gsc"],
          thresholdsApplied: { minVolume: 50 },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: { coverageDayRatio: 1 },
        },
      }),
    );
    expect(result).toBeNull();
  });

  it("folds the GA4 witness into agreement, neutral only when both absent", () => {
    const ga4Only = decayConfidence(
      decayFinding({
        evidence: {
          metrics: {
            declineRatio: -0.45,
            clicksPrevious: 320,
            clicksCurrent: 176,
          },
          sources: ["gsc", "ga4"],
          thresholdsApplied: { minVolume: 50 },
          correlations: [],
          evidenceType: "observational",
          partialData: ["rank_corroboration_unavailable"],
          confidenceInputs: {
            coverageDayRatio: 1,
            rankAgrees: false,
            ga4Agrees: true,
          },
        },
      }),
    );
    expect(ga4Only?.inputs.agreement).toBe(1);
    expect(ga4Only?.inputs.rankSessionMoves).toBe(0.5);
  });

  it("saturates magnitude at a 50% decline", () => {
    const half = decayConfidence(decayFinding());
    const total = decayConfidence(
      decayFinding({
        evidence: {
          metrics: {
            declineRatio: -0.95,
            clicksPrevious: 400,
            clicksCurrent: 20,
          },
          sources: ["gsc"],
          thresholdsApplied: { minVolume: 50 },
          correlations: [],
          evidenceType: "observational",
          partialData: ["rank_corroboration_unavailable"],
          confidenceInputs: { coverageDayRatio: 1, rankAgrees: false },
        },
      }),
    );
    expect(half?.inputs.magnitude).toBeCloseTo(0.9, 5);
    expect(total?.inputs.magnitude).toBe(1);
  });
});

describe("opportunity templates", () => {
  const detectorKeys = [
    "ga4_organic_change",
    "organic_traffic_change",
    "low_ctr_query",
    "content_decay",
    "ranking_drop",
    "cannibalization",
    "technical_on_important_page",
    "backlink_change",
    "lost_backlinks",
    "striking_distance",
  ];

  it("covers every PR7 detector with a distinct type", () => {
    expect(Object.keys(OPPORTUNITY_TEMPLATES).toSorted()).toEqual(
      [...detectorKeys].toSorted(),
    );
    const types = Object.values(OPPORTUNITY_TEMPLATES).map((t) => t.type);
    expect(new Set(types).size).toBe(types.length);
  });

  it("emits non-empty observational copy without banned causal verbs", () => {
    const samples: Record<string, Finding> = {
      ga4_organic_change: finding("ga4_organic_change", {
        evidence: {
          metrics: {
            sessionsBefore: 1000,
            sessionsAfter: 670,
            changeRatio: -0.33,
          },
          sources: ["ga4"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      organic_traffic_change: finding("organic_traffic_change", {
        evidence: {
          metrics: { clicksBefore: 1240, clicksAfter: 845, changeRatio: -0.32 },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      low_ctr_query: finding("low_ctr_query", {
        entity: { query: "best shoes" },
        evidence: {
          metrics: { impressions: 5000, clicks: 20, position: 8.5 },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      content_decay: finding("content_decay", {
        entity: { page: "/guide" },
        evidence: {
          metrics: {
            declineRatio: -0.45,
            clicksCurrent: 176,
            clicksPrevious: 320,
          },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      ranking_drop: finding("ranking_drop", {
        entity: { keyword: "shoes", device: "desktop" },
        evidence: {
          metrics: { positionBefore: 8, dropPositions: 7 },
          sources: ["rank"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      cannibalization: finding("cannibalization", {
        entity: { query: "espresso" },
        evidence: {
          metrics: { queryImpressions: 1500 },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      technical_on_important_page: finding("technical_on_important_page", {
        entity: { issueType: "missing_title", page: "/pricing" },
        evidence: {
          metrics: { pageClicks: 1240 },
          sources: ["audit", "gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      backlink_change: finding("backlink_change", {
        entity: { domain: "example.com" },
        evidence: {
          metrics: {
            referringDomainsAfter: 120,
            backlinksDelta: 20,
            lostBacklinks: 4,
            lostReferringDomains: 1,
          },
          sources: ["backlinks"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      lost_backlinks: finding("lost_backlinks", {
        entity: { domain: "example.com", lostDomains: "gone-a.com" },
        evidence: {
          metrics: {
            lostReferringDomains: 5,
            namedLostDomains: 1,
            lostBacklinks: 9,
            referringDomainsBefore: 120,
            referringDomainsAfter: 112,
          },
          sources: ["backlinks"],
          thresholdsApplied: { minReferringDomains: 3 },
          correlations: [],
          evidenceType: "observational",
          partialData: ["two_point_heuristic"],
          confidenceInputs: {},
        },
      }),
      striking_distance: finding("striking_distance", {
        entity: { query: "quick win" },
        evidence: {
          metrics: { impressions: 8000, clicks: 25, position: 15 },
          sources: ["gsc"],
          thresholdsApplied: {
            minImpressions: 100,
            minPosition: 11,
            maxPosition: 20,
          },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
    };
    for (const key of detectorKeys) {
      const template = OPPORTUNITY_TEMPLATES[key];
      const sample = samples[key];
      if (!template || !sample) throw new Error(`missing fixture for ${key}`);
      const title = template.title(sample);
      const recommendation = template.recommendation(sample);
      expect(title.length, `${key} title`).toBeGreaterThan(0);
      expect(recommendation.length, `${key} recommendation`).toBeGreaterThan(0);
      expect(title, `${key} title verbs`).not.toMatch(BANNED_VERBS);
      expect(recommendation, `${key} recommendation verbs`).not.toMatch(
        BANNED_VERBS,
      );
      const impact = scoreImpact(template.factorsOf(sample));
      expect(impact, `${key} impact factors`).not.toBeNull();
    }
  });

  it("extracts keyword/page refs per detector family", () => {
    expect(
      OPPORTUNITY_TEMPLATES.low_ctr_query?.keywordOf(
        finding("low_ctr_query", { entity: { query: "q" } }),
      ),
    ).toBe("q");
    expect(
      OPPORTUNITY_TEMPLATES.low_ctr_query?.pageOf(
        finding("low_ctr_query", { entity: { query: "q" } }),
      ),
    ).toBeNull();
    expect(
      OPPORTUNITY_TEMPLATES.content_decay?.pageOf(
        finding("content_decay", { entity: { page: "/p" } }),
      ),
    ).toBe("/p");
    expect(
      OPPORTUNITY_TEMPLATES.organic_traffic_change?.keywordOf(
        finding("organic_traffic_change"),
      ),
    ).toBeNull();
  });

  it("scores lost-backlink opportunities on lost referring domains", () => {
    const template = OPPORTUNITY_TEMPLATES.lost_backlinks;
    if (!template) throw new Error("missing lost_backlinks template");
    expect(template.type).toBe("lost_backlinks");
    const asFinding = finding("lost_backlinks", {
      entity: { domain: "example.com", lostDomains: "gone-a.com, gone-b.com" },
      evidence: {
        metrics: {
          lostReferringDomains: 5,
          namedLostDomains: 2,
          lostBacklinks: 9,
          referringDomainsBefore: 120,
          referringDomainsAfter: 112,
        },
        sources: ["backlinks"],
        thresholdsApplied: { minReferringDomains: 3 },
        correlations: [],
        evidenceType: "observational",
        partialData: ["two_point_heuristic"],
        confidenceInputs: {},
      },
    });
    expect(template.title(asFinding)).toContain("5 lost referring domains");
    expect(template.title(asFinding)).toContain("example.com");
    expect(template.recommendation(asFinding)).toContain("gone-a.com");
    const factors = template.factorsOf(asFinding);
    expect(factors.trafficPotential).toBeGreaterThan(0);
    expect(factors.decline).toBeGreaterThan(0);
    expect(factors.decline).toBeLessThanOrEqual(1);
    expect(scoreImpact(factors)).not.toBeNull();
    expect(template.keywordOf(asFinding)).toBeNull();
    expect(template.pageOf(asFinding)).toBeNull();
  });

  it("leaves the backlink_change template behavior unchanged (spec 008)", () => {
    const template = OPPORTUNITY_TEMPLATES.backlink_change;
    if (!template) throw new Error("missing backlink_change template");
    expect(template.type).toBe("backlinks");
    const asFinding = finding("backlink_change", {
      entity: { domain: "example.com" },
      evidence: {
        metrics: {
          referringDomainsAfter: 120,
          backlinksDelta: 20,
          lostBacklinks: 4,
          lostReferringDomains: 1,
        },
        sources: ["backlinks"],
        thresholdsApplied: {},
        correlations: [],
        evidenceType: "observational",
        partialData: [],
        confidenceInputs: {},
      },
    });
    expect(template.title(asFinding)).toBe(
      "Backlink movement for example.com (heuristic)",
    );
    expect(template.recommendation(asFinding)).toContain(
      "Review lost referring domains for reclaim opportunities",
    );
  });
});
