import { canonicalTechnicalKey, canonicalUrl } from "@/shared/intelligence";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * `technical_on_important_page` (final-plan §4): critical audit issues on
 * pages that matter — latest COMPLETED audit crossed with GSC top-N pages by
 * clicks, plus a GA4 landing-traffic second importance vote. GA4 absence
 * carries no penalty.
 */

export type ImportantPageIssue = {
  issueType: string;
  pageUrl: string;
  pageClicks: number;
  pageImpressions: number;
  ga4Vote: boolean;
};

export type TechnicalInput = {
  periodFrom: string;
  periodTo: string;
  auditId: string;
  issues: ImportantPageIssue[];
  ga4Available: boolean;
  thresholds: Record<string, string | number | boolean>;
};

export function isTechnicalInput(value: unknown): value is TechnicalInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "issues" in value &&
    Array.isArray(value.issues) &&
    "auditId" in value &&
    typeof value.auditId === "string" &&
    "periodFrom" in value &&
    typeof value.periodFrom === "string" &&
    "periodTo" in value &&
    typeof value.periodTo === "string" &&
    "thresholds" in value &&
    typeof value.thresholds === "object" &&
    value.thresholds !== null
  );
}

export async function fetchTechnicalInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<TechnicalInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const topN = thresholdNumber(ctx.thresholds, "topN");
  const latestAudit = await AuditRepository.getLatestAuditForProject(projectId);
  // Only completed audits are consumable; running/failed feed the active
  // mutation signal, never detection input.
  if (!latestAudit || latestAudit.status !== "completed") {
    throw new InsufficientCoverageError(
      "technical_on_important_page: no completed audit",
    );
  }
  const latestDate = await GscSearchPerformanceRepository.getLatestFactDate(
    projectId,
    "page",
  );
  if (!latestDate) {
    throw new InsufficientCoverageError(
      "technical_on_important_page: no GSC page facts for importance",
    );
  }
  const to = latestDate;
  const fromDate = new Date(`${to}T00:00:00Z`);
  fromDate.setUTCDate(fromDate.getUTCDate() - (windowDays - 1));
  const from = fromDate.toISOString().slice(0, 10);
  const rows = await GscSearchPerformanceRepository.getDailyGrainFacts(
    projectId,
    "page",
    from,
    to,
  );
  const clicksByPage = new Map<
    string,
    { clicks: number; impressions: number }
  >();
  for (const row of rows) {
    if (!row.page) continue;
    const normalized = canonicalUrl(row.page);
    const entry = clicksByPage.get(normalized) ?? { clicks: 0, impressions: 0 };
    entry.clicks += row.clicks;
    entry.impressions += row.impressions;
    clicksByPage.set(normalized, entry);
  }
  const topPages = new Map(
    [...clicksByPage.entries()]
      .toSorted(([, a], [, b]) => b.clicks - a.clicks)
      .slice(0, topN)
      .map(([url, entry]) => [url, entry] as const),
  );
  // GA4 second importance vote (PR10): top-N landing pages by sessions over
  // the same window. Unconnected or under-covered projects degrade —
  // corroboration failures never throw.
  let ga4Available = false;
  const ga4TopPages = new Set<string>();
  try {
    const ga4Connection = await Ga4ConnectionRepository.getByProjectId(
      projectId,
      ctx.organizationId,
    );
    if (ga4Connection) {
      const landingCoverage = await Ga4SyncRepository.getGrainCoverage(
        projectId,
        ga4Connection.propertyId,
        "landing_pages",
        from,
        to,
      );
      const coveredDays = new Set(landingCoverage.coveredDates).size;
      if (coveredDays / windowDays >= minCoverage) {
        const groups = await Ga4SyncRepository.getLandingGroups(
          projectId,
          ga4Connection.propertyId,
          from,
          to,
          { limit: topN },
        );
        ga4Available = true;
        for (const group of groups) {
          ga4TopPages.add(canonicalUrl(group.landingPage));
        }
      }
    }
  } catch {
    ga4Available = false;
  }
  const criticalIssues = await AuditRepository.getIssuesForAudit(
    latestAudit.id,
    { severity: "critical" },
  );
  const issues: ImportantPageIssue[] = [];
  for (const issue of criticalIssues) {
    const normalized = canonicalUrl(issue.pageUrl);
    const importance = topPages.get(normalized);
    if (!importance) continue;
    issues.push({
      issueType: issue.issueType,
      pageUrl: normalized,
      pageClicks: importance.clicks,
      pageImpressions: importance.impressions,
      ga4Vote: ga4TopPages.has(normalized),
    });
  }
  return {
    periodFrom: from,
    periodTo: to,
    auditId: latestAudit.id,
    issues,
    ga4Available,
    thresholds: {
      minWindowDays: windowDays,
      topN,
      severity: "critical",
    },
  };
}

export function detectTechnical(
  _ctx: DetectorContext,
  input: TechnicalInput,
): FindingDraft[] {
  // Importance filtering happens at fetch time (top-N applied to live
  // importance); detect stamps identity over the pre-filtered issues.
  // A GA4 second vote lifts confidence 75 → 80; absence carries no penalty.
  return input.issues.map((issue) => ({
    entityKey: canonicalTechnicalKey(issue.issueType, issue.pageUrl),
    entity: {
      issueType: issue.issueType,
      page: issue.pageUrl,
      auditId: input.auditId,
    },
    explanationFact:
      `Critical issue ${issue.issueType} on ${issue.pageUrl}, which earned ` +
      `${issue.pageClicks.toLocaleString("en-US")} clicks in ` +
      `${input.periodFrom}..${input.periodTo}` +
      `${issue.ga4Vote ? ", also a top GA4 landing page" : ""}.`,
    evidence: {
      metrics: {
        pageClicks: issue.pageClicks,
        pageImpressions: issue.pageImpressions,
      },
      periods: { from: input.periodFrom, to: input.periodTo },
      sources: issue.ga4Vote ? ["audit", "gsc", "ga4"] : ["audit", "gsc"],
      sourceRefs: { auditIssueIds: [`${input.auditId}:${issue.issueType}`] },
      thresholdsApplied: input.thresholds,
      correlations: [],
      evidenceType: "observational",
      partialData: input.ga4Available ? [] : ["ga4_landing_vote_pending"],
      confidenceInputs: {
        importanceClicks: issue.pageClicks,
        ga4Vote: issue.ga4Vote,
      },
    },
    detectedAt: new Date().toISOString(),
    confidenceScore: issue.ga4Vote ? 80 : 75,
    coverageFlags: {
      completedAudit: true,
      importanceRanked: true,
      ga4Vote: issue.ga4Vote,
    },
  }));
}

export const technicalOnImportantPageDetector: DetectorDef = {
  detectorKey: "technical_on_important_page",
  version: 1,
  requiredSources: ["audit", "gsc"],
  optionalCorroborators: ["ga4"],
  minConfidenceToEmit: 40,
  coverage: [
    { source: "audit", grains: ["issue"], minCoverageRatio: 1 },
    { source: "gsc", grains: ["page"], minCoverageRatio: 0.8 },
  ],
  detect: (ctx, input) => {
    if (!isTechnicalInput(input)) {
      throw new Error("technical_on_important_page: mistyped input");
    }
    return detectTechnical(ctx, input);
  },
};
