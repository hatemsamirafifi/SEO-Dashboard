/**
 * Unit tests for the SAM SEO Analyst recommendation engine
 * (`seoRecommendations.ts`).
 *
 * Covers: deterministic priority scoring per recommendation family, the
 * deduplication key, priority ordering, evidence-reference provenance,
 * the "always Proposed" invariant, and the top-6 action-plan cap plus
 * Zod-contract validation of the assembled result.
 */
import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  SeoAnalysisResultSchema,
  type SeoRecommendation,
} from "@/shared/samSeoAnalyst";
import { runSeoAnalysis } from "./seoAnalyzer";
import {
  buildPrioritizedActionPlan,
  deduplicateRecommendations,
  sortRecommendationsByPriority,
} from "./seoRecommendations";
import type { CollectedSeoEvidence } from "./seoEvidenceTypes";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

type RankRow = CollectedSeoEvidence["details"]["rankTrackingRows"][number];

function rankRow(overrides: Partial<RankRow>): RankRow {
  return {
    keyword: "sample keyword",
    target: "US (en) desktop",
    device: "desktop",
    position: 10,
    obsDate: "2026-11-15",
    prevComparable: 8,
    prevDate: "2026-11-10",
    movement: -2,
    providerDelta: -2,
    provider: "dataforseo",
    provenance: "dataforseo / high",
    comparisonMethod: "previous_comparable_observation",
    url: "https://example.com/page",
    status: "RANKED",
    ...overrides,
  };
}

function baseEvidence(
  overrides: Partial<CollectedSeoEvidence["details"]> = {},
): CollectedSeoEvidence {
  return {
    projectId: "proj-1",
    domain: "example.com",
    collectedAt: "2026-11-17T12:00:00Z",
    focus: "full",
    thresholds: DEFAULT_OPPORTUNITY_THRESHOLDS,
    sourceAvailability: [
      {
        source: "rank_tracking",
        status: "available",
        freshnessLabel: "2 days old",
        recordCount: 1,
        limitations: [],
      },
      {
        source: "search_console",
        status: "unavailable",
        freshnessLabel: "not connected",
        recordCount: 0,
        limitations: ["GSC not connected"],
      },
    ],
    observations: [],
    measuredOverview: {
      savedKeywordsCount: 0,
    },
    details: {
      rankTrackingRows: [],
      gscStrikingQueries: [],
      gscTopQueries: [],
      gscTopPages: [],
      auditIssues: [],
      auditPages: [],
      savedKeywords: [],
      competitorSnapshots: [],
      ...overrides,
    },
    limitations: [],
    missingInformation: [],
  };
}

/** A schema-valid recommendation with a stable identity, for direct
 *  dedup/sort tests. Overrides may change the fields under test. */
function makeRec(
  overrides: Partial<SeoRecommendation> = {},
): SeoRecommendation {
  return {
    id: "rec-1",
    projectId: "proj-1",
    fingerprint: "fp-1",
    category: "keyword_opportunity",
    title: "Sample recommendation",
    explanation: "Sample explanation.",
    evidenceReferences: [
      {
        sourceTool: "get_rank_tracker",
        provider: "dataforseo",
        observationDate: "2026-11-15",
        metricName: "position",
        metricValue: 10,
        urlOrKeyword: "sample keyword",
      },
    ],
    targetKeywords: ["sample keyword"],
    targetUrls: ["https://example.com/page"],
    priority: "Medium",
    expectedImpact: "Medium",
    implementationEffort: "Medium",
    confidence: {
      level: "Medium",
      score: 70,
      rationale: "Sample rationale.",
    },
    recommendedAction: "Sample action.",
    reason: "Sample reason.",
    validationMetric: "Sample metric.",
    baselineMeasurement: null,
    reviewPeriod: "14 days",
    status: "Proposed",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Ranking drop priority scoring
// ---------------------------------------------------------------------------

describe("ranking drop recommendations", () => {
  it("scores a top-10 drop as Critical with High impact", () => {
    const evidence = baseEvidence({
      rankTrackingRows: [
        rankRow({
          keyword: "dropping term",
          position: 12,
          prevComparable: 8,
          movement: -4,
          providerDelta: -4,
        }),
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find((r) => r.category === "ranking_drop");
    expect(rec).toBeDefined();
    expect(rec?.priority).toBe("Critical");
    expect(rec?.expectedImpact).toBe("High");
    expect(rec?.targetKeywords).toContain("dropping term");
    expect(rec?.evidenceReferences[0]?.metricName).toBe("position");
    expect(rec?.evidenceReferences[0]?.metricValue).toBe(12);
    expect(rec?.status).toBe("Proposed");
  });

  it("scores a large drop (>=5) outside top-10 as Critical with Medium impact", () => {
    const evidence = baseEvidence({
      rankTrackingRows: [
        rankRow({
          keyword: "big drop",
          position: 18,
          prevComparable: 12,
          movement: -6,
          providerDelta: -6,
        }),
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find((r) => r.category === "ranking_drop");
    expect(rec?.priority).toBe("Critical");
    expect(rec?.expectedImpact).toBe("Medium");
  });

  it("scores a small drop (<5) outside top-10 as High", () => {
    const evidence = baseEvidence({
      rankTrackingRows: [
        rankRow({
          keyword: "small drop",
          position: 15,
          prevComparable: 12,
          movement: -3,
          providerDelta: -3,
        }),
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find((r) => r.category === "ranking_drop");
    expect(rec?.priority).toBe("High");
    expect(rec?.expectedImpact).toBe("Medium");
  });
});

// ---------------------------------------------------------------------------
// Keyword opportunity priority scoring
// ---------------------------------------------------------------------------

describe("keyword opportunity recommendations", () => {
  it("scores a high-impression striking-distance keyword as High", () => {
    const evidence = baseEvidence({
      gscStrikingQueries: [
        {
          query: "hot keyword",
          page: "https://example.com/hot",
          clicks: 200,
          impressions: 3400,
          position: 6.8,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find(
      (r) =>
        r.category === "keyword_opportunity" &&
        r.targetKeywords.includes("hot keyword"),
    );
    expect(rec).toBeDefined();
    expect(rec?.priority).toBe("High");
    expect(rec?.evidenceReferences[0]?.sourceTool).toBe(
      "get_search_console_performance",
    );
  });

  it("scores a low-impression, low-position striking keyword as Medium", () => {
    const evidence = baseEvidence({
      gscStrikingQueries: [
        {
          query: "marginal keyword",
          page: "https://example.com/marginal",
          clicks: 2,
          impressions: 60,
          position: 14,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find(
      (r) =>
        r.category === "keyword_opportunity" &&
        r.targetKeywords.includes("marginal keyword"),
    );
    expect(rec).toBeDefined();
    expect(rec?.priority).toBe("Medium");
  });

  it("flags a high-impression low-CTR query as a keyword opportunity", () => {
    const evidence = baseEvidence({
      gscTopQueries: [
        { key: "click shy query", clicks: 1, impressions: 2000, position: 9 },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const rec = plan.recommendations.find(
      (r) =>
        r.category === "keyword_opportunity" &&
        r.targetKeywords.includes("click shy query"),
    );
    expect(rec).toBeDefined();
    expect(rec?.priority).toBe("High");
  });
});

// ---------------------------------------------------------------------------
// Content / technical priority scoring
// ---------------------------------------------------------------------------

describe("content & technical recommendations", () => {
  it("scores a critical audit issue as Critical and a recurring warning as Medium", () => {
    const evidence = baseEvidence({
      auditIssues: [
        {
          id: "crit-1",
          auditId: "audit-1",
          pageId: "page-1",
          pageUrl: "https://example.com/broken",
          issueType: "broken_internal_link",
          severity: "critical",
          detailsJson: null,
        },
        {
          id: "warn-1",
          auditId: "audit-1",
          pageId: "page-1",
          pageUrl: "https://example.com/p1",
          issueType: "missing_meta_description",
          severity: "warning",
          detailsJson: null,
        },
        {
          id: "warn-2",
          auditId: "audit-1",
          pageId: "page-2",
          pageUrl: "https://example.com/p2",
          issueType: "missing_meta_description",
          severity: "warning",
          detailsJson: null,
        },
        {
          id: "warn-3",
          auditId: "audit-1",
          pageId: "page-3",
          pageUrl: "https://example.com/p3",
          issueType: "missing_meta_description",
          severity: "warning",
          detailsJson: null,
        },
      ],
      auditPages: [
        {
          id: "page-1",
          url: "https://example.com/broken",
          statusCode: 500,
          fetchClass: "ok",
          extractionState: "STATIC_COMPLETE",
          failureReason: null,
          platform: null,
          platformConfidence: null,
          redirectUrl: null,
          title: "T",
          metaDescription: null,
          wordCount: 100,
          isIndexable: true,
          crawlDepth: 1,
          inSitemap: true,
          internalLinkCount: 1,
          responseTimeMs: 100,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const techRecs = plan.recommendations.filter(
      (r) => r.category === "content_technical",
    );
    const critical = techRecs.find(
      (r) => r.evidenceReferences[0]?.metricValue === "broken_internal_link",
    );
    const warning = techRecs.find(
      (r) =>
        r.evidenceReferences[0]?.metricValue === "missing_meta_description",
    );
    expect(critical?.priority).toBe("Critical");
    expect(critical?.expectedImpact).toBe("High");
    expect(warning?.priority).toBe("Medium");
    expect(warning?.expectedImpact).toBe("Medium");
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------

describe("deduplicateRecommendations", () => {
  it("merges recs sharing category + keywords + urls, ignoring other fields", () => {
    const a = makeRec({ id: "a", title: "first title" });
    const b = makeRec({ id: "b", title: "second title" });
    expect(deduplicateRecommendations([a, b])).toHaveLength(1);
  });

  it("keeps recs with the same keywords but a different category", () => {
    const a = makeRec({ category: "keyword_opportunity" });
    const b = makeRec({ category: "ranking_drop" });
    expect(deduplicateRecommendations([a, b])).toHaveLength(2);
  });

  it("keeps recs with the same category + keywords but a different url", () => {
    const a = makeRec({ targetUrls: ["https://example.com/a"] });
    const b = makeRec({ targetUrls: ["https://example.com/b"] });
    expect(deduplicateRecommendations([a, b])).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe("sortRecommendationsByPriority", () => {
  it("orders Critical > High > Medium > Low, tie-breaking on confidence", () => {
    const recs = [
      makeRec({
        id: "medium",
        priority: "Medium",
        confidence: { level: "Medium", score: 95, rationale: "r" },
      }),
      makeRec({
        id: "high-low",
        priority: "High",
        confidence: { level: "Medium", score: 50, rationale: "r" },
      }),
      makeRec({
        id: "crit",
        priority: "Critical",
        confidence: { level: "High", score: 40, rationale: "r" },
      }),
      makeRec({
        id: "high-high",
        priority: "High",
        confidence: { level: "High", score: 90, rationale: "r" },
      }),
      makeRec({
        id: "low",
        priority: "Low",
        confidence: { level: "Low", score: 99, rationale: "r" },
      }),
    ];
    const sorted = sortRecommendationsByPriority(recs);
    expect(sorted.map((r) => r.id)).toEqual([
      "crit",
      "high-high",
      "high-low",
      "medium",
      "low",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Action plan assembly
// ---------------------------------------------------------------------------

describe("buildPrioritizedActionPlan", () => {
  it("caps the plan at six recommendations", () => {
    const evidence = baseEvidence({
      rankTrackingRows: [
        rankRow({
          keyword: "drop a",
          position: 14,
          prevComparable: 6,
          movement: -8,
          providerDelta: -8,
        }),
        rankRow({
          keyword: "drop b",
          position: 13,
          prevComparable: 7,
          movement: -6,
          providerDelta: -6,
        }),
        rankRow({
          keyword: "drop c",
          position: 12,
          prevComparable: 8,
          movement: -4,
          providerDelta: -4,
        }),
      ],
      gscStrikingQueries: [
        {
          query: "opp a",
          page: "https://example.com/a",
          clicks: 5,
          impressions: 900,
          position: 6,
        },
        {
          query: "opp b",
          page: "https://example.com/b",
          clicks: 4,
          impressions: 800,
          position: 7,
        },
        {
          query: "opp c",
          page: "https://example.com/c",
          clicks: 3,
          impressions: 700,
          position: 8,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    expect(plan.recommendations.length).toBeLessThanOrEqual(6);
  });

  it("produces a result that validates against the Zod contract, all Proposed", () => {
    const evidence = baseEvidence({
      rankTrackingRows: [
        rankRow({
          keyword: "z drop",
          position: 11,
          prevComparable: 5,
          movement: -6,
          providerDelta: -6,
        }),
      ],
      gscStrikingQueries: [
        {
          query: "z opp",
          page: "https://example.com/z",
          clicks: 10,
          impressions: 1000,
          position: 5,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    const parsed = SeoAnalysisResultSchema.parse(plan);
    expect(parsed.projectId).toBe("proj-1");
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    for (const rec of parsed.recommendations) {
      expect(rec.status).toBe("Proposed");
      expect(rec.evidenceReferences.length).toBeGreaterThan(0);
      // No fabricated numeric impact: confidence stays a 0..100 scale.
      expect(rec.confidence.score).toBeGreaterThanOrEqual(0);
      expect(rec.confidence.score).toBeLessThanOrEqual(100);
    }
  });

  it("always emits a readable markdown fallback with the prioritized plan", () => {
    const evidence = baseEvidence({
      gscStrikingQueries: [
        {
          query: "z opp",
          page: "https://example.com/z",
          clicks: 10,
          impressions: 1000,
          position: 5,
        },
      ],
    });
    const plan = buildPrioritizedActionPlan(evidence, runSeoAnalysis(evidence));
    expect(plan.markdownFallback).toContain(
      "# 📊 SAM SEO Analysis: example.com",
    );
    expect(plan.markdownFallback).toContain("Prioritized SEO Action Plan");
    expect(plan.markdownFallback.length).toBeGreaterThan(0);
  });
});
