/**
 * SAM SEO Analyst Phase 1 - Recommendation Engine & Action Plan Builder.
 *
 * Converts analysis findings into strongly-typed, evidence-backed SeoRecommendations.
 * Handles deduplication, deterministic priority scoring, and readable markdown fallbacks.
 */
import { createHash } from "node:crypto";
import type {
  RecommendationPriority,
  SeoActionStatus,
  SeoAnalysisResult,
  SeoRecommendation,
  SeoVerificationOutcome,
} from "@/shared/samSeoAnalyst";
import type { AnalysisFindings } from "./seoAnalyzer";
import type { CollectedSeoEvidence } from "./seoEvidenceTypes";

const PRIORITY_WEIGHTS: Record<RecommendationPriority, number> = {
  Critical: 4,
  High: 3,
  Medium: 2,
  Low: 1,
};

export function generateRecommendationFingerprint(
  projectId: string,
  category: string,
  targetKeywords: string[],
  targetUrls: string[],
  metricName?: string | null,
): string {
  const normKeywords = [...targetKeywords]
    .map((k) => k.trim().toLowerCase())
    .toSorted()
    .join(",");
  const normUrls = [...targetUrls]
    .map((u) => u.trim().toLowerCase())
    .toSorted()
    .join(",");
  const normMetric = (metricName ?? "").trim().toLowerCase();
  const raw = `${projectId}:${category}:${normKeywords || "none"}:${normUrls || "none"}:${normMetric || "none"}`;
  return createHash("sha256").update(raw).digest("hex").slice(0, 32);
}

// ---------------------------------------------------------------------------
// Recommendation Generators
// ---------------------------------------------------------------------------

function buildRankingDropRecommendations(
  evidence: CollectedSeoEvidence,
  findings: AnalysisFindings,
): SeoRecommendation[] {
  return findings.rankingDrops.slice(0, 5).map((drop, idx) => {
    const isTop10Drop = drop.previousPosition <= 10;
    const priority: RecommendationPriority =
      isTop10Drop || drop.dropAmount >= 5 ? "Critical" : "High";
    const fingerprint = generateRecommendationFingerprint(
      evidence.projectId,
      "ranking_drop",
      [drop.keyword],
      drop.url ? [drop.url] : [],
      "position",
    );

    return {
      id: `rec-drop-${drop.keyword.replace(/\s+/g, "-")}-${idx + 1}`,
      projectId: evidence.projectId,
      fingerprint,
      category: "ranking_drop" as const,
      title: `Investigate position drop for "${drop.keyword}" (-${drop.dropAmount} pos)`,
      explanation: `Keyword dropped from position ${drop.previousPosition} to ${drop.currentPosition} on ${drop.device} (${drop.target}) between ${drop.prevDate ?? "previous check"} and ${drop.obsDate ?? "latest check"}.`,
      evidenceReferences: [
        {
          sourceTool: "get_rank_tracker",
          provider: drop.provider,
          observationDate: drop.obsDate,
          metricName: "position",
          metricValue: drop.currentPosition,
          urlOrKeyword: drop.keyword,
        },
      ],
      targetKeywords: [drop.keyword],
      targetUrls: drop.url ? [drop.url] : [],
      priority,
      expectedImpact: isTop10Drop ? "High" : "Medium",
      implementationEffort: "Low",
      confidence: {
        level: "High",
        score: 90,
        rationale:
          "Measured comparison against same-target, same-device previous observation.",
      },
      evidenceQuality: {
        signalStrength: isTop10Drop ? "confirmed_defect" : "strong_signal",
        sampleSize: "robust",
        comparabilityNotes: `Compared against previous observation from ${drop.provider} on ${drop.device}.`,
        isDestructiveActionRecommended: false,
      },
      recommendedAction: `Inspect ${drop.url ?? "the ranking page"} for recent content changes, crawl errors, or title alterations. Verify SERP competitors.`,
      reason: `Keywords in positions ${drop.previousPosition} previously captured organic impressions; dropping to ${drop.currentPosition} reduces organic CTR.`,
      validationMetric: `Rank Tracker position for "${drop.keyword}" (${drop.target})`,
      baselineMeasurement: `Position ${drop.currentPosition} (was ${drop.previousPosition})`,
      reviewPeriod: "7 days",
      status: "Proposed" as const,
    };
  });
}

function buildKeywordOpportunityRecommendations(
  evidence: CollectedSeoEvidence,
  findings: AnalysisFindings,
): SeoRecommendation[] {
  return findings.keywordOpportunities.slice(0, 5).map((opp, idx) => {
    const isStriking = opp.type === "striking_distance";
    const impressions = opp.impressions ?? 0;
    const isLowVolume = impressions < 10;
    const isAnomalous =
      isLowVolume &&
      (/[?&=]/.test(opp.keyword) ||
        /\b(shop|buy|store|cream|discount|replica)\b/i.test(opp.keyword));

    const priority: RecommendationPriority = isLowVolume
      ? "Low"
      : impressions > 500 || (opp.currentPosition ?? 20) <= 10
        ? "High"
        : "Medium";

    const fingerprint = generateRecommendationFingerprint(
      evidence.projectId,
      "keyword_opportunity",
      [opp.keyword],
      opp.url ? [opp.url] : [],
      isStriking ? "striking_position" : "ctr",
    );

    const confidenceScore = isLowVolume ? (isAnomalous ? 35 : 45) : 85;
    const confidenceLevel = isLowVolume ? "Low" : "High";
    const confidenceRationale = isLowVolume
      ? "Low impression sample size (<10 impressions); insufficient evidence to confirm persistent search demand or critical anomaly."
      : "Supported by direct Search Console performance or Rank Tracking data.";

    const recommendedAction = isLowVolume
      ? "Investigate query and landing page in Search Console URL Inspection before taking action; avoid destructive exclusions or redirects without confirming indexation."
      : isStriking
        ? "Enrich page content with relevant FAQ entities, update header tags, and ensure target search intent is thoroughly answered."
        : "Rewrite page title tag and meta description to be more compelling and include clear value proposition.";

    return {
      id: `rec-opp-${opp.keyword.replace(/\s+/g, "-")}-${idx + 1}`,
      projectId: evidence.projectId,
      fingerprint,
      category: "keyword_opportunity" as const,
      title: isLowVolume
        ? `Investigate anomalous query "${opp.keyword}" (${impressions} imp)`
        : isStriking
          ? `Optimize "${opp.keyword}" into Top 3 (Currently Pos ${opp.currentPosition})`
          : `Improve CTR for "${opp.keyword}" (${impressions.toLocaleString()} impressions, ${opp.ctr}% CTR)`,
      explanation: isLowVolume
        ? `Query appeared in Search Console with low volume (${impressions} impressions, ${opp.clicks ?? 0} clicks). Further inspection is required before taking optimization or removal actions.`
        : isStriking
          ? `Keyword is ranking in striking distance (position ${opp.currentPosition}). Minor content and on-page improvements can push it to high-CTR top 3 positions.`
          : `Query receives significant search volume (${impressions} impressions) but converts into low clicks due to suboptimal title/meta description.`,
      evidenceReferences: [
        {
          sourceTool: opp.evidenceSource,
          provider:
            opp.evidenceSource === "get_rank_tracker"
              ? "rank_tracker"
              : "google",
          observationDate: opp.observationDate,
          metricName: isStriking ? "striking_position" : "ctr",
          metricValue: opp.metricValue,
          urlOrKeyword: opp.keyword,
        },
      ],
      targetKeywords: [opp.keyword],
      targetUrls: opp.url ? [opp.url] : [],
      priority,
      expectedImpact: isLowVolume ? "Low" : "High",
      implementationEffort: isLowVolume ? "Low" : "Medium",
      confidence: {
        level: confidenceLevel,
        score: confidenceScore,
        rationale: confidenceRationale,
      },
      evidenceQuality: {
        signalStrength: isLowVolume
          ? isAnomalous
            ? "suspicious_investigate"
            : "insufficient_evidence"
          : impressions >= 100
            ? "strong_signal"
            : "insufficient_evidence",
        sampleSize: isLowVolume ? "sparse" : impressions >= 100 ? "robust" : "moderate",
        comparabilityNotes: "Aggregated Search Console query performance.",
        isDestructiveActionRecommended: false,
      },
      recommendedAction,
      reason: isLowVolume
        ? "Low-volume signals should be confirmed via inspection to avoid destructive noindex/removal mistakes."
        : "Pages in top 3 positions typically command over 50% of all organic clicks for the query.",
      validationMetric: `Average position and CTR for "${opp.keyword}"`,
      baselineMeasurement: opp.currentPosition
        ? `Position ${opp.currentPosition}`
        : null,
      reviewPeriod: isLowVolume ? "30 days" : "14 days",
      status: "Proposed" as const,
    };
  });
}

function buildTechnicalRecommendations(
  evidence: CollectedSeoEvidence,
  findings: AnalysisFindings,
): SeoRecommendation[] {
  return findings.contentTechnical.slice(0, 4).map((tech, idx) => {
    const isCritical = tech.type === "critical_issue";
    const priority: RecommendationPriority = isCritical ? "Critical" : "Medium";
    const fingerprint = generateRecommendationFingerprint(
      evidence.projectId,
      "content_technical",
      [],
      tech.targetUrl ? [tech.targetUrl] : [],
      tech.issueType ?? "audit_issue",
    );

    return {
      id: `rec-tech-${idx + 1}`,
      projectId: evidence.projectId,
      fingerprint,
      category: "content_technical" as const,
      title: tech.title,
      explanation: tech.description,
      evidenceReferences: [
        {
          sourceTool: tech.evidenceSource,
          provider: "openseo_crawler",
          observationDate:
            evidence.measuredOverview.siteAudit?.completedAt ?? null,
          metricName: "audit_issue",
          metricValue: tech.issueType ?? "defect",
          sourceRecordId: tech.recordId,
        },
      ],
      targetKeywords: [],
      targetUrls: tech.targetUrl ? [tech.targetUrl] : [],
      priority,
      expectedImpact: isCritical ? "High" : "Medium",
      implementationEffort: "Medium",
      confidence: {
        level: "High",
        score: 95,
        rationale: "Directly detected during site crawl audit.",
      },
      evidenceQuality: {
        signalStrength: isCritical ? "confirmed_defect" : "strong_signal",
        sampleSize: "robust",
        comparabilityNotes: "Crawled directly by site audit crawler.",
        isDestructiveActionRecommended: false,
      },
      recommendedAction: isCritical
        ? `Resolve the underlying HTTP/crawl issue on ${tech.targetUrl ?? "the affected page"} to restore search bot access.`
        : "Address the recurring HTML template issue across affected pages.",
      reason:
        "Technical crawler errors can prevent proper indexation or dilute ranking signals.",
      validationMetric: "Site Audit error count",
      baselineMeasurement: isCritical ? "Active error" : "Recurring warning",
      reviewPeriod: "7 days",
      status: "Proposed" as const,
    };
  });
}

// ---------------------------------------------------------------------------
// Deduplication & Prioritization
// ---------------------------------------------------------------------------

export function deduplicateRecommendations(
  recommendations: SeoRecommendation[],
): SeoRecommendation[] {
  const seenKeys = new Set<string>();
  const deduplicated: SeoRecommendation[] = [];

  for (const rec of recommendations) {
    const key = `${rec.category}:${rec.targetKeywords.join(",").toLowerCase()}:${rec.targetUrls.join(",").toLowerCase()}`;
    if (!seenKeys.has(key)) {
      seenKeys.add(key);
      deduplicated.push(rec);
    }
  }

  return deduplicated;
}

export function sortRecommendationsByPriority(
  recommendations: SeoRecommendation[],
): SeoRecommendation[] {
  return recommendations.toSorted((a, b) => {
    const weightA = PRIORITY_WEIGHTS[a.priority];
    const weightB = PRIORITY_WEIGHTS[b.priority];
    if (weightA !== weightB) {
      return weightB - weightA;
    }
    return b.confidence.score - a.confidence.score;
  });
}

// ---------------------------------------------------------------------------
// Markdown Fallback Generator
// ---------------------------------------------------------------------------

export function generateMarkdownFallback(
  evidence: CollectedSeoEvidence,
  findings: AnalysisFindings,
  recommendations: SeoRecommendation[],
): string {
  const lines: string[] = [
    `# 📊 SAM SEO Analysis: ${evidence.domain ?? "Website"}`,
    `*Generated on ${new Date(evidence.collectedAt).toLocaleDateString()} | Focus: ${evidence.focus}*`,
    "",
    "## 1. Performance Overview",
    `- **Search Visibility:** ${findings.performance.searchVisibilitySummary}`,
    `- **Rankings:** ${findings.performance.rankingsSummary}`,
    `- **Technical Health:** ${findings.performance.technicalHealthSummary}`,
    `- **Data Freshness:** ${findings.performance.dataFreshnessSummary}`,
    "",
    "## 2. Prioritized SEO Action Plan",
  ];

  if (recommendations.length === 0) {
    lines.push("No actionable SEO recommendations found with current data.");
  } else {
    for (let i = 0; i < recommendations.length; i++) {
      const rec = recommendations[i];
      const taskBadge = rec.existingActionItem
        ? ` · 📌 [Status: ${rec.existingActionItem.status.toUpperCase()}]`
        : " · 🆕 [New]";
      lines.push(`### ${i + 1}. [${rec.priority}] ${rec.title}${taskBadge}`);
      lines.push(`- **Action:** ${rec.recommendedAction}`);
      lines.push(`- **Why it matters:** ${rec.explanation}`);
      lines.push(
        `- **Validation:** Measure ${rec.validationMetric} (Review in ${rec.reviewPeriod})`,
      );
      lines.push(
        `- **Confidence:** ${rec.confidence.level} (${rec.confidence.score}%) — *${rec.confidence.rationale}*`,
      );
      if (rec.evidenceQuality) {
        lines.push(
          `- **Evidence Signal:** ${rec.evidenceQuality.signalStrength} (Sample size: ${rec.evidenceQuality.sampleSize})`,
        );
      }
      if (rec.existingActionItem?.verificationOutcome) {
        const outcomeLabel =
          rec.existingActionItem.verificationOutcome === "insufficient_data"
            ? "Verification attempted — insufficient comparable evidence (awaiting newer data)"
            : rec.existingActionItem.verificationOutcome;
        lines.push(`- **Verification Result:** ${outcomeLabel}`);
      }
      lines.push("");
    }
  }

  if (evidence.missingInformation.length > 0) {
    lines.push("## ⚠️ Limitations & Missing Information");
    for (const msg of evidence.missingInformation) {
      lines.push(`- ${msg}`);
    }
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Full Analysis Pipeline
// ---------------------------------------------------------------------------

export interface ExistingActionItemRef {
  id: string;
  recommendationFingerprint: string;
  status: SeoActionStatus;
  actionPlanId: string;
  baselineValue?: string | null;
  verificationOutcome?: SeoVerificationOutcome | null;
}

export function buildPrioritizedActionPlan(
  evidence: CollectedSeoEvidence,
  findings: AnalysisFindings,
  existingActionItems?: ExistingActionItemRef[],
): SeoAnalysisResult {
  const dropRecs = buildRankingDropRecommendations(evidence, findings);
  const oppRecs = buildKeywordOpportunityRecommendations(evidence, findings);
  const techRecs = buildTechnicalRecommendations(evidence, findings);

  const allRecs = [...dropRecs, ...oppRecs, ...techRecs];
  const deduplicated = deduplicateRecommendations(allRecs);
  const sorted = sortRecommendationsByPriority(deduplicated);

  // Focus filter: when user requests action_plan or specific focus, keep top 5
  const topRecommendations = sorted.slice(0, 6);

  if (existingActionItems && existingActionItems.length > 0) {
    for (const rec of topRecommendations) {
      const match = existingActionItems.find(
        (item) => item.recommendationFingerprint === rec.fingerprint,
      );
      if (match) {
        rec.existingActionItem = {
          id: match.id,
          status: match.status,
          actionPlanId: match.actionPlanId,
          baselineMeasurement: match.baselineValue ?? null,
          verificationOutcome: match.verificationOutcome ?? null,
        };
      }
    }
  }

  const markdownFallback = generateMarkdownFallback(
    evidence,
    findings,
    topRecommendations,
  );

  return {
    projectId: evidence.projectId,
    domain: evidence.domain,
    analyzedAt: evidence.collectedAt,
    focus: evidence.focus,
    thresholds: evidence.thresholds,
    sourceAvailability: evidence.sourceAvailability,
    measuredOverview: evidence.measuredOverview,
    capabilities: {
      performanceOverview: {
        status: "complete",
        summary: findings.performance,
      },
      keywordOpportunities: { found: findings.keywordOpportunities.length },
      rankingDrops: { found: findings.rankingDrops.length },
      contentTechnical: { found: findings.contentTechnical.length },
      competitorOpportunities: findings.competitors,
    },
    recommendations: topRecommendations,
    missingInformation: evidence.missingInformation,
    limitations: evidence.limitations,
    markdownFallback,
  };
}
