import { DashboardService } from "@/server/features/dashboard/services/DashboardService";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { InsightRepository } from "@/server/features/intelligence/repositories/InsightRepository";
import { OpportunityService } from "@/server/features/intelligence/services/OpportunityService";
import type { ReportPayload } from "@/shared/reports";

type Availability = ReportPayload["searchVisibility"]["status"];

function unavailable(reason: string): Availability {
  return { available: false, reason };
}

const READY: Availability = { available: true, reason: null };

/** GSC totals over the report window, DB-stored only (snapshot reproducibility). */
export async function collectSearchVisibility(
  projectId: string,
  from: string,
  to: string,
): Promise<ReportPayload["searchVisibility"]> {
  try {
    const connection =
      await GscConnectionRepository.getByProjectId(projectId);
    if (!connection) {
      return { status: unavailable("not_connected"), totals: null };
    }
    const covered = await GscSearchPerformanceRepository.hasCoverage(
      projectId,
      from,
      to,
    );
    if (!covered) {
      return { status: unavailable("no_coverage"), totals: null };
    }
    const totals = await GscSearchPerformanceRepository.getTotals(
      projectId,
      from,
      to,
    );
    return {
      status: READY,
      totals: {
        clicks: totals.clicks,
        impressions: totals.impressions,
        ctr: totals.ctr,
        position: totals.position,
      },
    };
  } catch {
    return { status: unavailable("provider_failed"), totals: null };
  }
}

export type TrafficAndConversions = Pick<
  ReportPayload,
  "traffic" | "conversions"
>;

/** GA4 summary + key-event aggregates over SUCCESS_*-covered dates only. */
export async function collectTrafficAndConversions(
  projectId: string,
  organizationId: string,
  from: string,
  to: string,
): Promise<TrafficAndConversions> {
  const down: TrafficAndConversions = {
    traffic: { status: unavailable("provider_failed"), totals: null },
    conversions: {
      status: unavailable("provider_failed"),
      keyEvents: null,
      transactions: null,
    },
  };
  try {
    const connection = await Ga4ConnectionRepository.getByProjectId(
      projectId,
      organizationId,
    );
    if (!connection) {
      const status = unavailable("not_connected");
      return {
        traffic: { status, totals: null },
        conversions: { status, keyEvents: null, transactions: null },
      };
    }
    const [summaryCoverage, eventsCoverage, totals, keyEventGroups] =
      await Promise.all([
        Ga4SyncRepository.getGrainCoverage(
          projectId,
          connection.propertyId,
          "summary",
          from,
          to,
        ),
        Ga4SyncRepository.getGrainCoverage(
          projectId,
          connection.propertyId,
          "events",
          from,
          to,
        ),
        Ga4SyncRepository.getSummaryTotals(
          projectId,
          connection.propertyId,
          from,
          to,
          connection.currencyCode,
        ),
        Ga4SyncRepository.getEventGroups(
          projectId,
          connection.propertyId,
          from,
          to,
          {
            limit: 500,
            keyEventsOnly: true,
          },
        ),
      ]);
    if (summaryCoverage.coveredDates.length === 0) {
      const status = unavailable("no_coverage");
      return {
        traffic: { status, totals: null },
        conversions: { status, keyEvents: null, transactions: null },
      };
    }
    // Key-event counts are events-grain data: without events coverage they
    // stay unavailable (never a zero), while traffic still reports.
    const conversions =
      eventsCoverage.coveredDates.length === 0
        ? {
            status: unavailable("no_coverage"),
            keyEvents: null,
            transactions: null,
          }
        : {
            status: READY,
            keyEvents: keyEventGroups.reduce(
              (sum, group) => sum + group.eventCount,
              0,
            ),
            transactions: totals.transactions,
          };
    return {
      traffic: {
        status: READY,
        totals: {
          sessions: totals.sessions,
          engagedSessions: totals.engagedSessions,
          screenPageViews: totals.screenPageViews,
          eventCount: totals.eventCount,
          newUsers: totals.newUsers,
          keyEvents: keyEventGroups.reduce(
            (sum, group) => sum + group.eventCount,
            0,
          ),
          totalRevenue: totals.totalRevenue,
          transactions: totals.transactions,
        },
      },
      conversions,
    };
  } catch {
    return down;
  }
}

export type OverviewParts = Pick<
  ReportPayload,
  "rankings" | "technical" | "backlinks"
>;

/** Rank/audit/backlink summaries via the dashboard overview reader (stored only). */
export async function collectOverviewParts(
  projectId: string,
  domain: string | null,
): Promise<OverviewParts> {
  const down: OverviewParts = {
    rankings: {
      status: unavailable("provider_failed"),
      trackedKeywords: null,
      improved: null,
      declined: null,
      top10: null,
      lastCheckedAt: null,
    },
    technical: {
      status: unavailable("provider_failed"),
      auditStatus: null,
      pagesCrawled: null,
      topIssues: null,
    },
    backlinks: {
      status: unavailable("provider_failed"),
      referringDomains: null,
      capturedAt: null,
    },
  };
  try {
    const overview = await DashboardService.getOverview({
      projectId,
      domain,
    });
    return {
      rankings: overview.rank
        ? {
            status: READY,
            trackedKeywords: overview.rank.trackedKeywords,
            improved: overview.rank.improved,
            declined: overview.rank.declined,
            top10: overview.rank.top10,
            lastCheckedAt: overview.rank.lastCheckedAt,
          }
        : {
            status: unavailable("no_data"),
            trackedKeywords: null,
            improved: null,
            declined: null,
            top10: null,
            lastCheckedAt: null,
          },
      technical: overview.audit
        ? {
            status: READY,
            auditStatus: overview.audit.status,
            pagesCrawled: overview.audit.pagesCrawled,
            topIssues: overview.audit.topIssues,
          }
        : {
            status: unavailable("no_data"),
            auditStatus: null,
            pagesCrawled: null,
            topIssues: null,
          },
      backlinks: overview.backlinks
        ? {
            status: READY,
            referringDomains: overview.backlinks.referringDomains,
            capturedAt: overview.backlinks.capturedAt,
          }
        : {
            status: unavailable("no_data"),
            referringDomains: null,
            capturedAt: null,
          },
    };
  } catch {
    return down;
  }
}

const SEVERITY_ORDER = ["critical", "high", "medium", "info"] as const;

function severityRank(severity: string): number {
  const index = (SEVERITY_ORDER as readonly string[]).indexOf(severity);
  return index === -1 ? SEVERITY_ORDER.length : index;
}

/** Current (unresolved) insight rows, frozen as project-level copies. */
export async function collectInsights(
  projectId: string,
): Promise<ReportPayload["insights"]> {
  const rows = await InsightRepository.listUnresolvedByProject(projectId);
  return rows
    .toSorted(
      (a, b) =>
        severityRank(a.severity) - severityRank(b.severity) ||
        (a.detectedAt < b.detectedAt ? 1 : a.detectedAt > b.detectedAt ? -1 : 0),
    )
    .map((row) => ({
      insightKey: row.insightKey,
      type: row.type,
      detectorKey: row.detectorKey,
      severity: row.severity,
      title: row.title,
      explanationFact: row.explanationFact,
      recommendation: row.recommendation,
      detectedAt: row.detectedAt,
      contentVersion: row.contentVersion,
    }));
}

export const COMPLETED_OPPORTUNITIES_CAP = 20;

/** Active rows in canonical order + most-recent completed, capped. */
export async function collectOpportunities(
  projectId: string,
): Promise<ReportPayload["opportunities"]> {
  const all = await OpportunityService.listOpportunities({ projectId });
  const active = all.filter(
    (row) => row.status === "open" || row.status === "in_progress",
  );
  const completed = all
    .filter((row) => row.status === "completed")
    .toSorted((a, b) =>
      a.completedAt === b.completedAt
        ? 0
        : (a.completedAt ?? "") < (b.completedAt ?? "")
          ? 1
          : -1,
    )
    .slice(0, COMPLETED_OPPORTUNITIES_CAP);
  return [...active, ...completed].map((row) => ({
    id: row.id,
    logicalKey: row.logicalKey,
    type: row.type,
    status: row.status,
    priority: row.priority,
    impactScore: row.impactScore,
    confidenceScore: row.confidenceScore,
    title: row.title,
    explanationFact: row.explanationFact,
    recommendation: row.recommendation,
    completedAt: row.completedAt,
  }));
}
