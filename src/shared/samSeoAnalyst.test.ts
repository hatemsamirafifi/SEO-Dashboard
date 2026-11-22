import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  KeywordOpportunityThresholdsSchema,
  SeoAnalysisResultSchema,
  SeoEvidenceObservationSchema,
  SeoEvidenceReferenceSchema,
  SeoRecommendationSchema,
} from "./samSeoAnalyst";

// Spec: SAM SEO Analyst Phase 1 — measured facts (evidence observations) and
// model interpretations (recommendations) must stay strictly separated, and
// the analysis envelope must validate end to end.

const evidenceReference = SeoEvidenceReferenceSchema.parse({
  sourceTool: "get_rank_tracker",
  provider: "dataforseo",
  observationDate: "2026-11-10",
  metricName: "position",
  metricValue: 14,
  urlOrKeyword: "best crm for freelancers",
  sourceRecordId: "rt:target:42",
});

const validRecommendation = {
  id: "rec-1",
  projectId: "proj-1",
  category: "keyword_opportunity" as const,
  title: "Push 'best crm for freelancers' into the top 3",
  explanation:
    "The keyword sits at position 14 with strong impressions — a striking-distance quick win.",
  evidenceReferences: [evidenceReference],
  targetKeywords: ["best crm for freelancers"],
  targetUrls: ["https://example.com/crm-for-freelancers"],
  priority: "High" as const,
  expectedImpact: "High" as const,
  implementationEffort: "Medium" as const,
  confidence: {
    level: "High" as const,
    score: 82,
    rationale: "Three consistent observations across two sources.",
  },
  recommendedAction:
    "Expand the page with an FAQ section and a comparison table.",
  reason: "Positions 4-10 convert to clicks at high CTR for this query.",
  validationMetric: "Average position for 'best crm for freelancers'",
  baselineMeasurement: "Position 14 as of 2026-11-10",
  reviewPeriod: "14 days",
  status: "Proposed" as const,
};

describe("SeoRecommendationSchema", () => {
  it("validates a well-formed recommendation and applies defaults", () => {
    const parsed = SeoRecommendationSchema.parse(validRecommendation);
    expect(parsed.status).toBe("Proposed");
    expect(parsed.targetKeywords).toEqual(["best crm for freelancers"]);
    expect(parsed.targetUrls).toHaveLength(1);
  });

  it("defaults status to 'Proposed' when omitted", () => {
    const { status: _status, ...withoutStatus } = validRecommendation;
    const parsed = SeoRecommendationSchema.parse(withoutStatus);
    expect(parsed.status).toBe("Proposed");
  });

  it("rejects any status other than 'Proposed'", () => {
    const result = SeoRecommendationSchema.safeParse({
      ...validRecommendation,
      status: "Implemented",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid category", () => {
    const result = SeoRecommendationSchema.safeParse({
      ...validRecommendation,
      category: "link_building",
    });
    expect(result.success).toBe(false);
  });

  it("rejects invalid confidence (bad level, out-of-range score, missing rationale)", () => {
    for (const confidence of [
      { level: "Certain", score: 50, rationale: "r" },
      { level: "High", score: 101, rationale: "r" },
      { level: "High", score: -1, rationale: "r" },
      { level: "High", score: 50 },
    ]) {
      const result = SeoRecommendationSchema.safeParse({
        ...validRecommendation,
        confidence,
      });
      expect(result.success).toBe(false);
    }
  });

  it("requires at least one evidence reference", () => {
    const result = SeoRecommendationSchema.safeParse({
      ...validRecommendation,
      evidenceReferences: [],
    });
    expect(result.success).toBe(false);
  });
});

describe("SeoEvidenceObservationSchema", () => {
  it("validates a measured fact and locks isMeasured to true", () => {
    const parsed = SeoEvidenceObservationSchema.parse({
      id: "obs-1",
      projectId: "proj-1",
      sourceTool: "get_rank_tracker",
      provider: "dataforseo",
      metricName: "position",
      metricValue: 14,
      observationDate: "2026-11-10",
      device: "all",
      urlOrKeyword: "best crm for freelancers",
      dataFreshness: "2026-11-10",
      sourceRecordIds: ["rt:target:42"],
    });
    expect(parsed.isMeasured).toBe(true);
  });

  it("accepts null metric values and null observation dates", () => {
    const result = SeoEvidenceObservationSchema.safeParse({
      id: "obs-2",
      projectId: "proj-1",
      sourceTool: "get_search_console_performance",
      provider: "gsc",
      metricName: "position",
      metricValue: null,
      observationDate: null,
      dateRange: { from: "2026-10-01", to: "2026-10-31" },
      dataFreshness: "windowed",
    });
    expect(result.success).toBe(true);
  });

  it("rejects isMeasured: false — interpretations do not live here", () => {
    const result = SeoEvidenceObservationSchema.safeParse({
      id: "obs-3",
      projectId: "proj-1",
      sourceTool: "get_rank_tracker",
      provider: "dataforseo",
      metricName: "position",
      metricValue: 14,
      observationDate: "2026-11-10",
      dataFreshness: "2026-11-10",
      isMeasured: false,
    });
    expect(result.success).toBe(false);
  });
});

describe("KeywordOpportunityThresholdsSchema", () => {
  it("parses an empty object into the shared defaults", () => {
    expect(KeywordOpportunityThresholdsSchema.parse({})).toEqual(
      DEFAULT_OPPORTUNITY_THRESHOLDS,
    );
  });

  it("exposes the documented default thresholds", () => {
    expect(DEFAULT_OPPORTUNITY_THRESHOLDS).toEqual({
      strikingMinPos: 4,
      strikingMaxPos: 20,
      minImpressionsForCtr: 100,
      lowCtrThreshold: 0.02,
      minPositionDrop: 3,
      minImpressionsForTrend: 50,
    });
  });

  it("preserves explicitly supplied overrides", () => {
    const parsed = KeywordOpportunityThresholdsSchema.parse({
      strikingMinPos: 5,
      lowCtrThreshold: 0.01,
    });
    expect(parsed.strikingMinPos).toBe(5);
    expect(parsed.lowCtrThreshold).toBe(0.01);
    expect(parsed.strikingMaxPos).toBe(20);
  });
});

describe("SeoAnalysisResultSchema", () => {
  const completeAnalysis = {
    projectId: "proj-1",
    domain: "example.com",
    analyzedAt: "2026-11-17T12:00:00.000Z",
    focus: "full",
    thresholds: DEFAULT_OPPORTUNITY_THRESHOLDS,
    sourceAvailability: [
      {
        source: "rank_tracking",
        status: "available",
        provider: "dataforseo",
        observationDateRange: { from: "2026-10-01", to: "2026-11-10" },
        freshnessLabel: "11 days old",
        ageDays: 11,
        recordCount: 42,
      },
      {
        source: "search_console",
        status: "available",
        freshnessLabel: "29 days of data",
        recordCount: 1000,
      },
      {
        source: "backlinks",
        status: "unavailable",
        freshnessLabel: "never captured",
        recordCount: 0,
        limitations: ["Backlinks not activated for this project"],
      },
    ],
    measuredOverview: {
      rankTracking: {
        configured: true,
        trackedKeywordsCount: 42,
        activeTargetsCount: 40,
        latestRunDate: "2026-11-10",
        averagePosition: 23.4,
        top10Count: 12,
        top3Count: 3,
        improvedCount: 9,
        declinedCount: 5,
      },
      searchConsole: {
        connected: true,
        coverageRange: { from: "2026-10-19", to: "2026-11-16" },
        totals: {
          clicks: 1250,
          impressions: 48000,
          ctr: 0.026,
          position: 18.7,
        },
        previousTotals: {
          clicks: 1100,
          impressions: 45000,
          ctr: 0.024,
          position: 19.9,
        },
      },
      siteAudit: {
        hasAudit: true,
        auditId: "audit-7",
        status: "completed",
        completedAt: "2026-11-02T08:30:00.000Z",
        pagesCrawled: 310,
        criticalIssuesCount: 2,
        warningIssuesCount: 11,
        infoIssuesCount: 40,
      },
      backlinks: {
        hasSnapshot: false,
        capturedAt: null,
        backlinks: null,
        referringDomains: null,
        rank: null,
      },
      savedKeywordsCount: 7,
    },
    capabilities: {
      performanceOverview: { supported: true },
      keywordOpportunities: { supported: true },
      rankingDrops: { supported: true },
      contentTechnical: { supported: true },
      competitorOpportunities: {
        supported: false,
        reason: "no competitors configured",
      },
    },
    recommendations: [SeoRecommendationSchema.parse(validRecommendation)],
    missingInformation: ["Competitor domains not configured"],
    limitations: ["Backlink data unavailable"],
    markdownFallback: "## SAM SEO Analyst\n\n42 keywords tracked…",
  };

  it("validates a complete sample analysis", () => {
    const parsed = SeoAnalysisResultSchema.parse(completeAnalysis);
    expect(parsed.projectId).toBe("proj-1");
    expect(parsed.focus).toBe("full");
    expect(parsed.measuredOverview.savedKeywordsCount).toBe(7);
    expect(parsed.recommendations).toHaveLength(1);
    expect(parsed.recommendations[0]?.status).toBe("Proposed");
  });

  it("applies defaults for omitted gap/limitation arrays", () => {
    const {
      missingInformation: _m,
      limitations: _l,
      measuredOverview,
      ...rest
    } = completeAnalysis;
    const parsed = SeoAnalysisResultSchema.parse({
      ...rest,
      measuredOverview: {
        ...measuredOverview,
        savedKeywordsCount: undefined,
      },
    });
    expect(parsed.missingInformation).toEqual([]);
    expect(parsed.limitations).toEqual([]);
    expect(parsed.measuredOverview.savedKeywordsCount).toBe(0);
  });

  it("accepts an analysis with no measured overview sections available", () => {
    const parsed = SeoAnalysisResultSchema.parse({
      ...completeAnalysis,
      domain: null,
      focus: "action_plan",
      measuredOverview: {},
      recommendations: [],
    });
    expect(parsed.measuredOverview.savedKeywordsCount).toBe(0);
    expect(parsed.recommendations).toEqual([]);
  });
});
