import { canonicalTechnicalKey, canonicalUrl } from "@/shared/intelligence";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import {
  GoogleAdsAnalyticsRepository,
  type GoogleAdsLandingPageTotals,
} from "@/server/features/google-ads/repositories/GoogleAdsAnalyticsRepository";
import {
  googleAdsUnitRefs,
  loadGoogleAdsCoverage,
  type GoogleAdsCoverageLoad,
} from "./googleAdsCoverage";
import {
  InsufficientCoverageError,
  thresholdNumber,
  type DetectorContext,
  type DetectorDef,
  type FindingDraft,
} from "./types";

/**
 * `paid_landing_page_technical_issue` (master plan phase 5): paid landing
 * pages carrying windowed cost/click volume that also carry a critical audit
 * issue on the same canonical page identity, or show weak current GA4
 * engagement under coverage. Spend thresholds compare raw base micros
 * (mirrored with the account currency), paid clicks sit on the unit-declared
 * metric-date basis, and engagement rate is a ratio of summed sessions.
 */

const WEAK_ENGAGEMENT_ISSUE = "weak_engagement";

export type PaidLandingPageIssue = {
  issueType: string;
  page: string;
  paidCostMicros: number;
  paidClicks: number;
  auditIssuePresent: boolean;
  ga4EngagementRate: number | null;
  ga4Weak: boolean;
};

export type PaidLandingPageInput = {
  periodFrom: string;
  periodTo: string;
  auditId: string;
  currencyCode: string | null;
  metricDateBasis: string | null;
  coverageRatio: number;
  googleAdsUnitIds: string[];
  pages: PaidLandingPageIssue[];
  thresholds: Record<string, string | number | boolean>;
};

export function isPaidLandingPageInput(
  value: unknown,
): value is PaidLandingPageInput {
  return (
    typeof value === "object" &&
    value !== null &&
    "pages" in value &&
    Array.isArray(value.pages) &&
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

/** Spend signal on raw base micros (unknown totals never count as zero). */
export function hasPaidVolume(
  paid: Pick<GoogleAdsLandingPageTotals["sums"], "costMicros" | "clicks">,
  minCostMicros: number,
  minClicks: number,
): boolean {
  const cost =
    paid.costMicros === null || paid.costMicros.hasMissingComponents
      ? null
      : paid.costMicros.total;
  if (cost !== null && cost >= minCostMicros) return true;
  const clicks =
    paid.clicks === null || paid.clicks.hasMissingComponents
      ? null
      : paid.clicks.total;
  return clicks !== null && clicks >= minClicks;
}

/** Canonical engagement rates by page; absence stays silent (no penalty). */
async function loadGa4EngagementRates(
  projectId: string,
  organizationId: string,
  window: { from: string; to: string },
  windowDays: number,
  minCoverage: number,
): Promise<Map<string, number>> {
  const ga4Connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  if (!ga4Connection) return new Map<string, number>();
  const ga4Coverage = await Ga4SyncRepository.getGrainCoverage(
    projectId,
    ga4Connection.propertyId,
    "landing_pages",
    window.from,
    window.to,
  );
  if (ga4Coverage.coveredDates.length / windowDays < minCoverage) {
    return new Map<string, number>();
  }
  const groups = await Ga4SyncRepository.getLandingGroups(
    projectId,
    ga4Connection.propertyId,
    window.from,
    window.to,
    { limit: 500 },
  );
  const rates = new Map<string, number>();
  for (const group of groups) {
    if (group.sessions === null || group.sessions <= 0) continue;
    rates.set(
      canonicalUrl(group.landingPage),
      (group.engagedSessions ?? 0) / group.sessions,
    );
  }
  return rates;
}

export async function fetchPaidLandingPageInput(
  projectId: string,
  ctx: DetectorContext,
): Promise<PaidLandingPageInput> {
  const windowDays = thresholdNumber(ctx.thresholds, "minWindowDays");
  const minCoverage = thresholdNumber(ctx.thresholds, "minCoverageRatio");
  const minPaidCostMicros = thresholdNumber(
    ctx.thresholds,
    "minPaidCostMicros",
  );
  const minPaidClicks = thresholdNumber(ctx.thresholds, "minPaidClicks");
  // getIssuesForAudit's bounded severity vocabulary is critical|warning|info;
  // the detector consumes critical issues per the phase 5 plan.
  const severity = "critical";
  const weakEngagementRate = thresholdNumber(
    ctx.thresholds,
    "weakEngagementRate",
  );

  // Latest completed audit gates cheaply; running audits feed the ActiveMut
  // signal, never detection input (same rule as technical_on_important_page).
  const latestAudit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!latestAudit || latestAudit.status !== "completed") {
    throw new InsufficientCoverageError(
      "paid_landing_page_technical_issue: no completed audit",
    );
  }
  // Ads-anchored window (latest covered landing_page unit date).
  const coverage: GoogleAdsCoverageLoad = await loadGoogleAdsCoverage({
    projectId,
    organizationId: ctx.organizationId,
    grains: ["landing_page"],
    windowDays,
    minCoverageRatio: minCoverage,
  });
  const [paidPages, criticalIssues] = await Promise.all([
    GoogleAdsAnalyticsRepository.sumLandingPageByUrlWindow(coverage.scope, {
      startDate: coverage.window.from,
      endDate: coverage.window.to,
    }),
    AuditRepository.getIssuesForAudit(latestAudit.id, {
      severity: "critical",
    }),
  ]);

  // GA4 weak-engagement witness (spec 010 contracts): engagement rate is a
  // ratio of summed sessions over the same window; corroboration failures
  // never throw — absence carries no penalty.
  let engagementByPage = new Map<string, number>();
  try {
    engagementByPage = await loadGa4EngagementRates(
      projectId,
      ctx.organizationId,
      coverage.window,
      windowDays,
      minCoverage,
    );
  } catch {
    engagementByPage = new Map<string, number>();
  }

  const issuesByPage = new Map<string, string[]>();
  for (const issue of criticalIssues) {
    if (!issue.pageUrl) continue;
    const page = canonicalUrl(issue.pageUrl);
    const entry = issuesByPage.get(page) ?? [];
    entry.push(issue.issueType);
    issuesByPage.set(page, entry);
  }

  const pages: PaidLandingPageIssue[] = [];
  for (const paidPage of paidPages) {
    if (!hasPaidVolume(paidPage.sums, minPaidCostMicros, minPaidClicks)) {
      continue;
    }
    const page = canonicalUrl(paidPage.landingPageUrl);
    const auditIssueTypes = issuesByPage.get(page) ?? [];
    const ga4EngagementRate = engagementByPage.get(page) ?? null;
    const ga4Weak =
      ga4EngagementRate !== null && ga4EngagementRate < weakEngagementRate;
    if (auditIssueTypes.length === 0 && !ga4Weak) continue;
    if (auditIssueTypes.length === 0) {
      pages.push({
        issueType: WEAK_ENGAGEMENT_ISSUE,
        page,
        paidCostMicros: paidPage.sums.costMicros.total ?? 0,
        paidClicks: paidPage.sums.clicks.total ?? 0,
        auditIssuePresent: false,
        ga4EngagementRate,
        ga4Weak: true,
      });
      continue;
    }
    for (const issueType of auditIssueTypes.toSorted()) {
      pages.push({
        issueType,
        page,
        paidCostMicros: paidPage.sums.costMicros.total ?? 0,
        paidClicks: paidPage.sums.clicks.total ?? 0,
        auditIssuePresent: true,
        ga4EngagementRate,
        ga4Weak: ga4Weak,
      });
    }
  }
  // Deterministic order: canonical page, then issue type.
  pages.sort(
    (a, b) =>
      (a.page < b.page ? -1 : 1) || (a.issueType < b.issueType ? -1 : 1),
  );

  const thresholds: Record<string, string | number | boolean> = {
    minWindowDays: windowDays,
    minCoverageRatio: minCoverage,
    minPaidCostMicros,
    minPaidClicks,
    severity,
    weakEngagementRate,
  };
  return {
    periodFrom: coverage.window.from,
    periodTo: coverage.window.to,
    auditId: latestAudit.id,
    currencyCode: coverage.currencyCode,
    metricDateBasis: coverage.metricDateBasis,
    coverageRatio: coverage.coverageRatio,
    googleAdsUnitIds: googleAdsUnitRefs(coverage, ["landing_page"]),
    pages,
    thresholds,
  };
}

export function detectPaidLandingPageTechnicalIssue(
  _ctx: DetectorContext,
  input: PaidLandingPageInput,
): FindingDraft[] {
  return input.pages.map((page) => {
    const metrics: Record<string, string | number | boolean> = {
      paidCostMicros: page.paidCostMicros,
      paidClicks: page.paidClicks,
      paidLandingCoverage: input.coverageRatio,
    };
    if (page.ga4EngagementRate !== null) {
      metrics.ga4EngagementRate =
        Math.round(page.ga4EngagementRate * 10_000) / 10_000;
    }
    const engagementNote =
      page.ga4EngagementRate !== null
        ? ` GA4 engagement ${Math.round(page.ga4EngagementRate * 100)}%.`
        : "";
    const ga4Unavailable = page.ga4EngagementRate === null;
    return {
      entityKey: canonicalTechnicalKey(page.issueType, page.page),
      entity: {
        issueType: page.issueType,
        page: page.page,
        auditId: input.auditId,
      },
      explanationFact:
        `Paid landing page ${page.page} drew ` +
        `${page.paidCostMicros.toLocaleString("en-US")} micros of spend and ` +
        `${page.paidClicks.toLocaleString("en-US")} clicks in ` +
        `${input.periodFrom}..${input.periodTo}` +
        (page.auditIssuePresent
          ? ` with critical audit issue ${page.issueType}.`
          : ` while GA4 engagement stayed below the bucketed threshold.`) +
        engagementNote,
      evidence: {
        metrics,
        periods: { from: input.periodFrom, to: input.periodTo },
        sources: page.auditIssuePresent
          ? ["google_ads", "audit"]
          : ["google_ads"],
        sourceRefs: {
          googleAdsUnitIds: input.googleAdsUnitIds,
          ...(page.auditIssuePresent
            ? { auditIssueIds: [`${input.auditId}:${page.issueType}`] }
            : {}),
        },
        thresholdsApplied: input.thresholds,
        correlations: [],
        evidenceType: "observational",
        partialData: ga4Unavailable ? ["ga4_engagement_unavailable"] : [],
        confidenceInputs: {
          auditIssuePresent: page.auditIssuePresent,
          ga4WeakEngagement: page.ga4Weak,
          ...(page.ga4EngagementRate === null
            ? { ga4EngagementRate: "unavailable" }
            : {
                ga4EngagementRate:
                  Math.round(page.ga4EngagementRate * 10_000) / 10_000,
              }),
        },
      },
      detectedAt: new Date().toISOString(),
      confidenceScore: page.auditIssuePresent ? (page.ga4Weak ? 80 : 75) : 68,
      coverageFlags: {
        paidLandingCoverage: input.coverageRatio,
        currencyCode: input.currencyCode ?? "",
        metricDateBasis: input.metricDateBasis ?? "",
        ga4WeakEngagement: page.ga4Weak,
      },
    };
  });
}

export const paidLandingPageTechnicalIssueDetector: DetectorDef = {
  detectorKey: "paid_landing_page_technical_issue",
  version: 1,
  requiredSources: ["google_ads", "audit"],
  optionalCorroborators: ["ga4"],
  minConfidenceToEmit: 40,
  coverage: [
    {
      source: "google_ads",
      grains: ["landing_page"],
      minCoverageRatio: 0.8,
    },
    { source: "audit", grains: ["issue"], minCoverageRatio: 1 },
  ],
  detect: (ctx, input) => {
    if (!isPaidLandingPageInput(input)) {
      throw new Error("paid_landing_page_technical_issue: mistyped input");
    }
    return detectPaidLandingPageTechnicalIssue(ctx, input);
  },
};
