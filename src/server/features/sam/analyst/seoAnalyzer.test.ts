import { describe, expect, it } from "vitest";
import {
  DEFAULT_OPPORTUNITY_THRESHOLDS,
  SeoAnalysisResultSchema,
} from "@/shared/samSeoAnalyst";
import {
  analyzeContentTechnical,
  analyzeKeywordOpportunities,
  analyzePerformanceOverview,
  analyzeRankingDrops,
  runSeoAnalysis,
} from "./seoAnalyzer";
import {
  buildPrioritizedActionPlan,
  deduplicateRecommendations,
  sortRecommendationsByPriority,
} from "./seoRecommendations";
import type { CollectedSeoEvidence } from "./seoEvidenceTypes";

const mockEvidence: CollectedSeoEvidence = {
  projectId: "proj-1",
  domain: "sports-ms.com",
  collectedAt: "2026-11-17T12:00:00Z",
  focus: "full",
  thresholds: DEFAULT_OPPORTUNITY_THRESHOLDS,
  sourceAvailability: [
    {
      source: "rank_tracking",
      status: "available",
      provider: "dataforseo",
      freshnessLabel: "2 days old",
      ageDays: 2,
      recordCount: 6,
      limitations: [],
    },
    {
      source: "search_console",
      status: "available",
      provider: "google",
      observationDateRange: { from: "2026-10-18", to: "2026-11-15" },
      freshnessLabel: "28 days",
      ageDays: 2,
      recordCount: 100,
      limitations: [],
    },
    {
      source: "site_audit",
      status: "available",
      provider: "openseo_crawler",
      freshnessLabel: "10 days ago",
      ageDays: 10,
      recordCount: 30,
      limitations: [],
    },
    {
      source: "backlinks",
      status: "available",
      provider: "dataforseo",
      freshnessLabel: "15 days ago",
      ageDays: 15,
      recordCount: 2919,
      limitations: [],
    },
    {
      source: "saved_keywords",
      status: "available",
      freshnessLabel: "179 keywords",
      recordCount: 179,
      limitations: [],
    },
    {
      source: "competitors",
      status: "unavailable",
      freshnessLabel: "None",
      recordCount: 0,
      limitations: ["No competitor snapshots stored."],
    },
  ],
  observations: [],
  measuredOverview: {
    rankTracking: {
      configured: true,
      trackedKeywordsCount: 6,
      activeTargetsCount: 2,
      latestRunDate: "2026-11-15",
      averagePosition: 12.3,
      top10Count: 3,
      top3Count: 1,
      improvedCount: 2,
      declinedCount: 1,
    },
    searchConsole: {
      connected: true,
      coverageRange: { from: "2026-10-18", to: "2026-11-15" },
      totals: {
        clicks: 4500,
        impressions: 120000,
        ctr: 0.0375,
        position: 14.5,
      },
    },
    siteAudit: {
      hasAudit: true,
      auditId: "audit-99",
      status: "completed",
      completedAt: "2026-11-05T00:00:00Z",
      pagesCrawled: 97,
      criticalIssuesCount: 2,
      warningIssuesCount: 8,
      infoIssuesCount: 20,
    },
    backlinks: {
      hasSnapshot: true,
      capturedAt: "2026-11-01T00:00:00Z",
      backlinks: 2919,
      referringDomains: 812,
      rank: 45,
    },
    savedKeywordsCount: 179,
  },
  details: {
    rankTrackingRows: [
      {
        keyword: "sports equipment egypt",
        target: "EG (ar) desktop",
        device: "desktop",
        position: 14,
        obsDate: "2026-11-15",
        prevComparable: 8,
        prevDate: "2026-11-10",
        movement: -6,
        providerDelta: -6,
        provider: "dataforseo",
        provenance: "dataforseo / high",
        comparisonMethod: "previous_comparable_observation",
        url: "https://sports-ms.com/equipment",
        status: "RANKED",
      },
      {
        keyword: "gym weights cairo",
        target: "EG (ar) desktop",
        device: "desktop",
        position: 5,
        obsDate: "2026-11-15",
        prevComparable: 5,
        prevDate: "2026-11-10",
        movement: 0,
        providerDelta: 0,
        provider: "dataforseo",
        provenance: "dataforseo / high",
        comparisonMethod: "previous_comparable_observation",
        url: "https://sports-ms.com/weights",
        status: "RANKED",
      },
    ],
    gscStrikingQueries: [
      {
        query: "buy dumbbells online",
        page: "https://sports-ms.com/dumbbells",
        clicks: 120,
        impressions: 3400,
        position: 6.8,
      },
    ],
    gscTopQueries: [
      {
        key: "treadmill maintenance",
        clicks: 15,
        impressions: 2500,
        position: 11.2,
      },
    ],
    gscTopPages: [
      {
        key: "https://sports-ms.com/dumbbells",
        clicks: 120,
        impressions: 3400,
        position: 6.8,
      },
    ],
    auditIssues: [
      {
        id: "issue-crit-1",
        auditId: "audit-99",
        pageId: "page-1",
        pageUrl: "https://sports-ms.com/page-1",
        issueType: "broken_internal_link",
        severity: "critical",
        detailsJson: null,
      },
      {
        id: "issue-crit-2",
        auditId: "audit-99",
        pageId: "page-2",
        pageUrl: "https://sports-ms.com/page-2",
        issueType: "status_500",
        severity: "critical",
        detailsJson: null,
      },
      {
        id: "issue-warn-1",
        auditId: "audit-99",
        pageId: "page-1",
        pageUrl: "https://sports-ms.com/page-1",
        issueType: "missing_meta_description",
        severity: "warning",
        detailsJson: null,
      },
      {
        id: "issue-warn-2",
        auditId: "audit-99",
        pageId: "page-2",
        pageUrl: "https://sports-ms.com/page-2",
        issueType: "missing_meta_description",
        severity: "warning",
        detailsJson: null,
      },
      {
        id: "issue-warn-3",
        auditId: "audit-99",
        pageId: "page-3",
        pageUrl: "https://sports-ms.com/page-3",
        issueType: "missing_meta_description",
        severity: "warning",
        detailsJson: null,
      },
    ],
    auditPages: [
      {
        id: "page-1",
        url: "https://sports-ms.com/shoes",
        statusCode: 200,
        fetchClass: "ok",
        extractionState: "STATIC_COMPLETE",
        failureReason: null,
        platform: null,
        platformConfidence: null,
        redirectUrl: null,
        title: "Shoes",
        metaDescription: null,
        wordCount: 400,
        isIndexable: true,
        crawlDepth: 1,
        inSitemap: true,
        internalLinkCount: 5,
        responseTimeMs: 200,
      },
    ],
    savedKeywords: [],
    competitorSnapshots: [],
  },
  limitations: [],
  missingInformation: ["No competitor snapshots stored."],
};

describe("seoAnalyzer - 5 Capabilities", () => {
  it("A. Performance Overview summarizes measured metrics accurately", () => {
    const findings = analyzePerformanceOverview(mockEvidence);
    expect(findings.searchVisibilitySummary).toContain("4,500 clicks");
    expect(findings.searchVisibilitySummary).toContain("120,000 impressions");
    expect(findings.searchVisibilitySummary).toContain("2,919 backlinks");
    expect(findings.rankingsSummary).toContain("Tracking 6 keywords");
    expect(findings.technicalHealthSummary).toContain("97 pages");
    expect(findings.technicalHealthSummary).toContain("2 critical");
  });

  it("B. Keyword Opportunity Detection catches striking distance and low CTR queries", () => {
    const opportunities = analyzeKeywordOpportunities(mockEvidence);
    expect(opportunities.length).toBeGreaterThanOrEqual(2);

    const striking = opportunities.find(
      (o) => o.keyword === "buy dumbbells online",
    );
    expect(striking).toBeDefined();
    expect(striking?.type).toBe("striking_distance");
    expect(striking?.currentPosition).toBe(6.8);

    const lowCtr = opportunities.find(
      (o) => o.keyword === "treadmill maintenance",
    );
    expect(lowCtr).toBeDefined();
    expect(lowCtr?.type).toBe("low_ctr");
    expect(lowCtr?.impressions).toBe(2500);
  });

  it("C. Ranking Drop Investigation detects meaningful declines and preserves target isolation", () => {
    const drops = analyzeRankingDrops(mockEvidence);
    expect(drops).toHaveLength(1);
    expect(drops[0].keyword).toBe("sports equipment egypt");
    expect(drops[0].previousPosition).toBe(8);
    expect(drops[0].currentPosition).toBe(14);
    expect(drops[0].dropAmount).toBe(6);
    expect(drops[0].device).toBe("desktop");
    expect(drops[0].target).toBe("EG (ar) desktop");
  });

  it("D. Content & Technical Opportunities surfaces critical issues and recurring warnings", () => {
    const tech = analyzeContentTechnical(mockEvidence);
    const critical = tech.filter((t) => t.type === "critical_issue");
    const warnings = tech.filter((t) => t.type === "warning_issue");

    expect(critical).toHaveLength(2);
    expect(warnings.length).toBeGreaterThanOrEqual(1);
    expect(warnings[0].title).toContain("missing meta description (3 pages)");
  });

  it("E. Aggregates all findings via runSeoAnalysis", () => {
    const all = runSeoAnalysis(mockEvidence);
    expect(all.performance).toBeDefined();
    expect(all.keywordOpportunities.length).toBeGreaterThan(0);
    expect(all.rankingDrops.length).toBe(1);
    expect(all.contentTechnical.length).toBeGreaterThan(0);
    expect(all.competitors.status).toBe("unavailable");
  });
});

describe("seoRecommendations - Action Plan & Prioritization", () => {
  it("deduplicates identical recommendations by category, keyword and url", () => {
    const findings = runSeoAnalysis(mockEvidence);
    const plan = buildPrioritizedActionPlan(mockEvidence, findings);

    const recs = plan.recommendations;
    const deduplicated = deduplicateRecommendations([...recs, ...recs]);
    expect(deduplicated.length).toBe(recs.length);
  });

  it("sorts recommendations by priority (Critical > High > Medium > Low)", () => {
    const findings = runSeoAnalysis(mockEvidence);
    const plan = buildPrioritizedActionPlan(mockEvidence, findings);

    const priorities = plan.recommendations.map((r) => r.priority);
    const sorted = sortRecommendationsByPriority(plan.recommendations);
    expect(plan.recommendations).toEqual(sorted);

    // Critical must be before High and Medium
    if (priorities.includes("Critical") && priorities.includes("Medium")) {
      const critIdx = priorities.indexOf("Critical");
      const medIdx = priorities.indexOf("Medium");
      expect(critIdx).toBeLessThan(medIdx);
    }
  });

  it("builds a complete, valid SeoAnalysisResult that parses through the Zod contract", () => {
    const findings = runSeoAnalysis(mockEvidence);
    const plan = buildPrioritizedActionPlan(mockEvidence, findings);

    const parsed = SeoAnalysisResultSchema.parse(plan);
    expect(parsed.projectId).toBe("proj-1");
    expect(parsed.domain).toBe("sports-ms.com");
    expect(parsed.recommendations.length).toBeGreaterThan(0);
    for (const rec of parsed.recommendations) {
      expect(rec.status).toBe("Proposed");
      expect(rec.evidenceReferences.length).toBeGreaterThan(0);
      expect(rec.confidence.score).toBeGreaterThan(0);
    }
    expect(parsed.markdownFallback).toContain(
      "# 📊 SAM SEO Analysis: sports-ms.com",
    );
    expect(parsed.markdownFallback).toContain("Prioritized SEO Action Plan");
  });
});
