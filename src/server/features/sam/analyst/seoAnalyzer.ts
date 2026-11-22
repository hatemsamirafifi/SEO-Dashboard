/**
 * SAM SEO Analyst Phase 1 - 5 Core SEO Analysis Capabilities.
 *
 * Runs deterministic rule-based analysis over normalized `CollectedSeoEvidence`:
 * A. SEO Performance Overview
 * B. Keyword Opportunity Detection
 * C. Ranking Drop Investigation
 * D. Content & Technical Opportunities
 * E. Competitor Opportunities
 */
import type { CollectedSeoEvidence } from "./seoEvidenceTypes";

export interface AnalysisFindings {
  performance: {
    searchVisibilitySummary: string;
    trafficTrendSummary: string;
    rankingsSummary: string;
    technicalHealthSummary: string;
    dataFreshnessSummary: string;
  };
  keywordOpportunities: Array<{
    type: "striking_distance" | "low_ctr" | "saved_gap";
    keyword: string;
    url?: string;
    currentPosition?: number;
    impressions?: number;
    clicks?: number;
    ctr?: number;
    searchVolume?: number;
    evidenceSource: string;
    metricValue: number | string;
    observationDate: string | null;
  }>;
  rankingDrops: Array<{
    keyword: string;
    device: "desktop" | "mobile";
    target: string;
    currentPosition: number;
    previousPosition: number;
    dropAmount: number;
    providerDelta: number | null;
    url: string | null;
    provider: string;
    obsDate: string | null;
    prevDate: string | null;
  }>;
  contentTechnical: Array<{
    type: "critical_issue" | "warning_issue" | "possible_cannibalization";
    title: string;
    description: string;
    targetUrl?: string;
    issueType?: string;
    evidenceSource: string;
    recordId?: string;
  }>;
  competitors: {
    status: "available" | "unavailable";
    summary: string;
    opportunitiesCount: number;
  };
}

// ---------------------------------------------------------------------------
// A. Performance Overview Analyzer
// ---------------------------------------------------------------------------
export function analyzePerformanceOverview(evidence: CollectedSeoEvidence) {
  const gscTotals = evidence.measuredOverview.searchConsole?.totals;
  const rtOverview = evidence.measuredOverview.rankTracking;
  const auditOverview = evidence.measuredOverview.siteAudit;
  const blOverview = evidence.measuredOverview.backlinks;

  const backlinksPart =
    blOverview?.hasSnapshot && blOverview.backlinks !== null
      ? ` (${blOverview.backlinks.toLocaleString()} backlinks from ${blOverview.referringDomains?.toLocaleString() ?? 0} domains)`
      : "";

  const searchVisibilitySummary = gscTotals
    ? `Recorded ${gscTotals.clicks.toLocaleString()} clicks and ${gscTotals.impressions.toLocaleString()} impressions with an average position of ${gscTotals.position.toFixed(1)}${backlinksPart}.`
    : `Google Search Console performance data is not connected${backlinksPart}.`;

  const trafficTrendSummary = gscTotals
    ? `Overall organic CTR sits at ${(gscTotals.ctr * 100).toFixed(1)}%.`
    : "Traffic trends unavailable without Search Console connection.";

  const rankingsSummary = rtOverview?.configured
    ? `Tracking ${rtOverview.trackedKeywordsCount} keywords across ${rtOverview.activeTargetsCount} target(s). Average position: ${rtOverview.averagePosition ?? "N/A"} (${rtOverview.top3Count} in top 3, ${rtOverview.top10Count} in top 10). ${rtOverview.improvedCount} improved, ${rtOverview.declinedCount} declined.`
    : "No active rank tracking configuration found.";

  const technicalHealthSummary = auditOverview?.hasAudit
    ? `Latest site audit crawled ${auditOverview.pagesCrawled} pages: ${auditOverview.criticalIssuesCount} critical, ${auditOverview.warningIssuesCount} warnings, and ${auditOverview.infoIssuesCount} info notices.`
    : "No site audit reports on file.";

  const freshnessParts = evidence.sourceAvailability
    .filter((s) => s.status === "available" || s.status === "stale")
    .map((s) => `${s.source.replace("_", " ")}: ${s.freshnessLabel}`);
  const dataFreshnessSummary =
    freshnessParts.length > 0
      ? `Data freshness: ${freshnessParts.join(", ")}.`
      : "No fresh data sources currently connected.";

  return {
    searchVisibilitySummary,
    trafficTrendSummary,
    rankingsSummary,
    technicalHealthSummary,
    dataFreshnessSummary,
  };
}

// ---------------------------------------------------------------------------
// B. Keyword Opportunity Detection Analyzer
// ---------------------------------------------------------------------------
export function analyzeKeywordOpportunities(evidence: CollectedSeoEvidence) {
  const opportunities: AnalysisFindings["keywordOpportunities"] = [];
  const { thresholds } = evidence;

  // 1. GSC Striking distance (positions 4 to 20)
  for (const item of evidence.details.gscStrikingQueries) {
    if (
      item.position >= thresholds.strikingMinPos &&
      item.position <= thresholds.strikingMaxPos
    ) {
      opportunities.push({
        type: "striking_distance",
        keyword: item.query,
        url: item.page,
        currentPosition: Number(item.position.toFixed(1)),
        impressions: item.impressions,
        clicks: item.clicks,
        ctr:
          item.impressions > 0
            ? Number(((item.clicks / item.impressions) * 100).toFixed(1))
            : 0,
        evidenceSource: "get_search_console_performance",
        metricValue: Number(item.position.toFixed(1)),
        observationDate:
          evidence.measuredOverview.searchConsole?.coverageRange.to ?? null,
      });
    }
  }

  // 2. High Impressions with Low CTR from Top Queries
  for (const q of evidence.details.gscTopQueries) {
    const ctr = q.impressions > 0 ? q.clicks / q.impressions : 0;
    if (
      q.impressions >= thresholds.minImpressionsForCtr &&
      ctr <= thresholds.lowCtrThreshold
    ) {
      const alreadyAdded = opportunities.some(
        (o) => o.keyword.toLowerCase() === q.key.toLowerCase(),
      );
      if (!alreadyAdded) {
        opportunities.push({
          type: "low_ctr",
          keyword: q.key,
          currentPosition: Number(q.position.toFixed(1)),
          impressions: q.impressions,
          clicks: q.clicks,
          ctr: Number((ctr * 100).toFixed(1)),
          evidenceSource: "get_search_console_performance",
          metricValue: `${(ctr * 100).toFixed(1)}% CTR`,
          observationDate:
            evidence.measuredOverview.searchConsole?.coverageRange.to ?? null,
        });
      }
    }
  }

  // 3. Rank tracking striking distance keywords
  for (const row of evidence.details.rankTrackingRows) {
    if (
      row.position !== null &&
      row.position >= thresholds.strikingMinPos &&
      row.position <= thresholds.strikingMaxPos
    ) {
      const alreadyInList = opportunities.some(
        (o) => o.keyword.toLowerCase() === row.keyword.toLowerCase(),
      );
      if (!alreadyInList) {
        opportunities.push({
          type: "striking_distance",
          keyword: row.keyword,
          url: row.url ?? undefined,
          currentPosition: row.position,
          evidenceSource: "get_rank_tracker",
          metricValue: row.position,
          observationDate: row.obsDate,
        });
      }
    }
  }

  return opportunities;
}

// ---------------------------------------------------------------------------
// C. Ranking Drop Investigation Analyzer
// ---------------------------------------------------------------------------
export function analyzeRankingDrops(evidence: CollectedSeoEvidence) {
  const drops: AnalysisFindings["rankingDrops"] = [];
  const { thresholds } = evidence;

  for (const row of evidence.details.rankTrackingRows) {
    // In OpenSEO: positive movement = improvement, negative movement = decline
    if (
      typeof row.movement === "number" &&
      row.movement <= -thresholds.minPositionDrop &&
      row.position !== null &&
      row.prevComparable !== null
    ) {
      drops.push({
        keyword: row.keyword,
        device: row.device,
        target: row.target,
        currentPosition: row.position,
        previousPosition: row.prevComparable,
        dropAmount: Math.abs(row.movement),
        providerDelta: row.providerDelta,
        url: row.url,
        provider: row.provider ?? "rank_tracker",
        obsDate: row.obsDate,
        prevDate: row.prevDate,
      });
    }
  }

  return drops.toSorted((a, b) => b.dropAmount - a.dropAmount);
}

// ---------------------------------------------------------------------------
// D. Content & Technical Opportunities Analyzer
// ---------------------------------------------------------------------------
export function analyzeContentTechnical(evidence: CollectedSeoEvidence) {
  const items: AnalysisFindings["contentTechnical"] = [];

  // 1. Critical audit issues
  const criticalIssues = evidence.details.auditIssues.filter(
    (i) => i.severity === "critical",
  );
  for (const issue of criticalIssues.slice(0, 10)) {
    const matchedPage = evidence.details.auditPages.find(
      (p) => p.id === issue.pageId,
    );
    items.push({
      type: "critical_issue",
      title: `Fix critical issue: ${issue.issueType.replace(/_/g, " ")}`,
      description: `Critical technical SEO defect detected by site audit.${matchedPage ? ` Affected URL: ${matchedPage.url}` : ""}`,
      targetUrl: matchedPage?.url ?? undefined,
      issueType: issue.issueType,
      evidenceSource: "get_audit_status",
      recordId: issue.id,
    });
  }

  // 2. High frequency warning issues
  const warningIssues = evidence.details.auditIssues.filter(
    (i) => i.severity === "warning",
  );
  const warningsByType = new Map<string, number>();
  for (const w of warningIssues) {
    warningsByType.set(w.issueType, (warningsByType.get(w.issueType) ?? 0) + 1);
  }
  for (const [issueType, count] of warningsByType.entries()) {
    if (count >= 3) {
      items.push({
        type: "warning_issue",
        title: `Resolve recurring warning: ${issueType.replace(/_/g, " ")} (${count} pages)`,
        description: `Found across ${count} crawled pages during site audit. Resolving this improves search engine indexing quality.`,
        issueType,
        evidenceSource: "get_audit_status",
      });
    }
  }

  return items;
}

// ---------------------------------------------------------------------------
// E. Competitor Opportunities Analyzer
// ---------------------------------------------------------------------------
export function analyzeCompetitors(evidence: CollectedSeoEvidence) {
  const hasCompetitors = evidence.details.competitorSnapshots.length > 0;
  if (!hasCompetitors) {
    return {
      status: "unavailable" as const,
      summary:
        "No competitor snapshots or gap analyses are currently configured for this project.",
      opportunitiesCount: 0,
    };
  }

  return {
    status: "available" as const,
    summary: `Found ${evidence.details.competitorSnapshots.length} competitor snapshot records in database.`,
    opportunitiesCount: evidence.details.competitorSnapshots.length,
  };
}

// ---------------------------------------------------------------------------
// Comprehensive Analysis Aggregator
// ---------------------------------------------------------------------------
export function runSeoAnalysis(
  evidence: CollectedSeoEvidence,
): AnalysisFindings {
  return {
    performance: analyzePerformanceOverview(evidence),
    keywordOpportunities: analyzeKeywordOpportunities(evidence),
    rankingDrops: analyzeRankingDrops(evidence),
    contentTechnical: analyzeContentTechnical(evidence),
    competitors: analyzeCompetitors(evidence),
  };
}
