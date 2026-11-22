/* eslint-disable max-lines */
/**
 * Individual data-source collectors for SAM SEO Analyst.
 * Strictly read-only against local OpenSEO database and repositories.
 */
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import {
  enrichRankResults,
  toFlattenedRankRows,
  type FlattenedRankObservationRow,
  type TargetRow,
} from "@/server/mcp/tools/get-rank-tracker-format";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import type {
  SeoEvidenceObservation,
  SeoSourceStatus,
} from "@/shared/samSeoAnalyst";

export function calculateAgeDays(
  dateStr: string | null | undefined,
): number | null {
  if (!dateStr) return null;
  const ms = Date.parse(dateStr);
  if (Number.isNaN(ms)) return null;
  const diffDays = Math.floor((Date.now() - ms) / (1000 * 60 * 60 * 24));
  return Math.max(0, diffDays);
}

// ---------------------------------------------------------------------------
// 1. Rank Tracking Collector
// ---------------------------------------------------------------------------
export async function collectRankTracking(projectId: string) {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) {
    return {
      status: {
        source: "rank_tracking" as const,
        status: "unavailable" as const,
        freshnessLabel: "No rank tracker configured",
        recordCount: 0,
        limitations: ["No active rank tracking config found for this project."],
      },
      overview: undefined,
      flattened: [] as FlattenedRankObservationRow[],
      observations: [] as SeoEvidenceObservation[],
    };
  }

  const primaryConfig = configs[0];
  const targets = await RankTrackingTargetRepository.getTargetsForProject(
    projectId,
    true,
  );
  const configTargets = targets.filter(
    (t) => !t.trackingConfigId || t.trackingConfigId === primaryConfig.id,
  );
  const targetById = new Map(targets.map((t) => [t.id, t]));
  const desktopTargets = configTargets.filter((t) => t.device === "desktop");
  const mobileTargets = configTargets.filter((t) => t.device === "mobile");
  const singleTargetByDevice: Partial<Record<"desktop" | "mobile", TargetRow>> =
    {
      desktop: desktopTargets.length === 1 ? desktopTargets[0] : undefined,
      mobile: mobileTargets.length === 1 ? mobileTargets[0] : undefined,
    };

  const rawResults = await getLatestResults(
    primaryConfig.id,
    projectId,
    "previous",
  );
  const enriched = enrichRankResults(
    rawResults,
    targetById,
    singleTargetByDevice,
  );
  const flattened = toFlattenedRankRows(enriched.rows);

  const validPositions = flattened
    .map((r) => r.position)
    .filter((p): p is number => p !== null);
  const avgPos =
    validPositions.length > 0
      ? Number(
          (
            validPositions.reduce((a, b) => a + b, 0) / validPositions.length
          ).toFixed(1),
        )
      : null;

  const top10 = validPositions.filter((p) => p <= 10).length;
  const top3 = validPositions.filter((p) => p <= 3).length;
  const improved = flattened.filter(
    (r) => typeof r.movement === "number" && r.movement > 0,
  ).length;
  const declined = flattened.filter(
    (r) => typeof r.movement === "number" && r.movement < 0,
  ).length;

  const latestObsDate =
    rawResults.run?.lastCheckedAt ?? flattened[0]?.obsDate ?? null;
  const ageDays = calculateAgeDays(latestObsDate);
  const freshnessLabel =
    ageDays !== null ? `${ageDays} days old` : "No observations yet";

  const observations: SeoEvidenceObservation[] = flattened.map((row) => ({
    id: `rt:${row.keyword}:${row.device}:${row.obsDate ?? "unknown"}`,
    projectId,
    sourceTool: "get_rank_tracker",
    provider: row.provider ?? "rank_tracker",
    metricName: "position",
    metricValue: row.position,
    observationDate: row.obsDate,
    device: row.device,
    countryOrLocation: row.target,
    urlOrKeyword: row.keyword,
    dataFreshness: freshnessLabel,
    sourceRecordIds: [row.keyword],
    qualityOrLimitations:
      row.movement !== null ? `Movement: ${row.movement}` : null,
    isMeasured: true as const,
  }));

  const rankStatus: SeoSourceStatus["status"] =
    flattened.length > 0
      ? ageDays !== null && ageDays > 30
        ? "stale"
        : "available"
      : "partial";

  const distinctProviders = Array.from(
    new Set(
      flattened
        .map((r) => r.provider)
        .filter((p): p is string => typeof p === "string" && p.length > 0),
    ),
  );
  const providerSummary =
    distinctProviders.length === 0
      ? "rank_tracker"
      : distinctProviders.length === 1
        ? distinctProviders[0]
        : "mixed";

  const limitations: string[] = [];
  if (distinctProviders.length > 1) {
    limitations.push(
      `Rank observations originate from multiple providers: ${distinctProviders.join(", ")}.`,
    );
  }

  return {
    status: {
      source: "rank_tracking" as const,
      status: rankStatus,
      provider: providerSummary,
      freshnessLabel,
      ageDays,
      recordCount: flattened.length,
      limitations,
    },
    overview: {
      configured: true,
      trackedKeywordsCount: enriched.rows.length,
      activeTargetsCount: configTargets.length,
      latestRunDate: latestObsDate,
      averagePosition: avgPos,
      top10Count: top10,
      top3Count: top3,
      improvedCount: improved,
      declinedCount: declined,
    },
    flattened,
    observations,
  };
}

// ---------------------------------------------------------------------------
// 2. Google Search Console Collector
// ---------------------------------------------------------------------------
export async function collectSearchConsole(projectId: string) {
  const coverage =
    await GscSearchPerformanceRepository.getStoredCoverageRange(projectId);
  if (!coverage) {
    return {
      status: {
        source: "search_console" as const,
        status: "unavailable" as const,
        freshnessLabel: "Not connected",
        recordCount: 0,
        limitations: [
          "Google Search Console is not connected or has no synced data.",
        ],
      },
      overview: undefined,
      striking: [],
      topQueries: [],
      topPages: [],
      observations: [] as SeoEvidenceObservation[],
    };
  }

  const totals = await GscSearchPerformanceRepository.getTotals(
    projectId,
    coverage.startDate,
    coverage.endDate,
  );

  const striking = await GscSearchPerformanceRepository.getStrikingDistance({
    projectId,
    startDate: coverage.startDate,
    endDate: coverage.endDate,
    limit: 50,
  });

  const queryRowsRes = await GscSearchPerformanceRepository.getTableRows({
    projectId,
    dimension: "query",
    startDate: coverage.startDate,
    endDate: coverage.endDate,
    page: 1,
    pageSize: 30,
  });

  const pageRowsRes = await GscSearchPerformanceRepository.getTableRows({
    projectId,
    dimension: "page",
    startDate: coverage.startDate,
    endDate: coverage.endDate,
    page: 1,
    pageSize: 30,
  });

  const topQueries = queryRowsRes.rows.map((r) => ({
    key: r.key,
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.position,
  }));

  const topPages = pageRowsRes.rows.map((r) => ({
    key: r.key,
    clicks: r.clicks,
    impressions: r.impressions,
    position: r.position,
  }));

  const ageDays = calculateAgeDays(coverage.endDate);
  const freshnessLabel = `${coverage.totalDays} days of data (${coverage.startDate} to ${coverage.endDate})`;

  const observations: SeoEvidenceObservation[] = [];
  if (totals) {
    observations.push({
      id: `gsc:totals:${coverage.startDate}_${coverage.endDate}`,
      projectId,
      sourceTool: "get_search_console_performance",
      provider: "google_search_console",
      metricName: "clicks",
      metricValue: totals.clicks,
      observationDate: coverage.endDate,
      dateRange: { from: coverage.startDate, to: coverage.endDate },
      dataFreshness: freshnessLabel,
      sourceRecordIds: [],
      isMeasured: true as const,
    });
  }

  for (const item of striking) {
    const itemCtrPct =
      item.impressions > 0
        ? ((item.clicks / item.impressions) * 100).toFixed(1)
        : "0.0";
    observations.push({
      id: `gsc:striking:${item.query}:${item.page}`,
      projectId,
      sourceTool: "get_search_console_performance",
      provider: "google_search_console",
      metricName: "striking_position",
      metricValue: Number(item.position.toFixed(1)),
      observationDate: coverage.endDate,
      urlOrKeyword: item.query,
      dataFreshness: freshnessLabel,
      sourceRecordIds: [item.query, item.page],
      qualityOrLimitations: `Impressions: ${item.impressions}, Clicks: ${item.clicks}, CTR: ${itemCtrPct}%`,
      isMeasured: true as const,
    });
  }

  return {
    status: {
      source: "search_console" as const,
      status: "available" as const,
      provider: "google",
      observationDateRange: { from: coverage.startDate, to: coverage.endDate },
      freshnessLabel,
      ageDays,
      recordCount: topQueries.length + topPages.length,
      limitations: [],
    },
    overview: {
      connected: true,
      coverageRange: { from: coverage.startDate, to: coverage.endDate },
      totals,
    },
    striking,
    topQueries,
    topPages,
    observations,
  };
}

// ---------------------------------------------------------------------------
// 3. Site Audit Collector
// ---------------------------------------------------------------------------
export async function collectSiteAudit(projectId: string) {
  const audit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!audit) {
    return {
      status: {
        source: "site_audit" as const,
        status: "unavailable" as const,
        freshnessLabel: "No audit performed",
        recordCount: 0,
        limitations: ["No site audit found for this project."],
      },
      overview: undefined,
      issues: [],
      pages: [],
      observations: [] as SeoEvidenceObservation[],
    };
  }

  const issues = await AuditRepository.getIssuesForAudit(audit.id, {});
  const pages = await AuditRepository.getPagesForAudit(audit.id);

  const criticalCount = issues.filter((i) => i.severity === "critical").length;
  const warningCount = issues.filter((i) => i.severity === "warning").length;
  const infoCount = issues.filter((i) => i.severity === "info").length;

  const ageDays = calculateAgeDays(audit.completedAt ?? audit.startedAt);
  const freshnessLabel =
    ageDays !== null ? `${ageDays} days ago` : "In progress";

  const observations: SeoEvidenceObservation[] = issues
    .slice(0, 50)
    .map((issue) => ({
      id: `audit:${issue.id}`,
      projectId,
      sourceTool: "get_audit_status",
      provider: "openseo_crawler",
      metricName: "audit_issue",
      metricValue: issue.issueType,
      observationDate: audit.completedAt,
      dataFreshness: freshnessLabel,
      sourceRecordIds: [issue.id],
      qualityOrLimitations: `Severity: ${issue.severity}`,
      isMeasured: true as const,
    }));

  const auditStatus: SeoSourceStatus["status"] =
    ageDays !== null && ageDays > 30 ? "stale" : "available";

  return {
    status: {
      source: "site_audit" as const,
      status: auditStatus,
      provider: "openseo_crawler",
      freshnessLabel,
      ageDays,
      recordCount: issues.length,
      limitations: [],
    },
    overview: {
      hasAudit: true,
      auditId: audit.id,
      status: audit.status,
      completedAt: audit.completedAt,
      pagesCrawled: pages.length,
      criticalIssuesCount: criticalCount,
      warningIssuesCount: warningCount,
      infoIssuesCount: infoCount,
    },
    issues,
    pages,
    observations,
  };
}

// ---------------------------------------------------------------------------
// 4. Backlinks Collector
// ---------------------------------------------------------------------------
export async function collectBacklinks(projectId: string) {
  const snapshot =
    await BacklinkSnapshotRepository.getLatestForProject(projectId);
  if (!snapshot) {
    return {
      status: {
        source: "backlinks" as const,
        status: "unavailable" as const,
        freshnessLabel: "No snapshot",
        recordCount: 0,
        limitations: ["No backlinks snapshot stored for this project."],
      },
      overview: undefined,
      observations: [] as SeoEvidenceObservation[],
    };
  }

  const ageDays = calculateAgeDays(snapshot.capturedAt);
  const freshnessLabel = ageDays !== null ? `${ageDays} days ago` : "Captured";

  const observations: SeoEvidenceObservation[] = [
    {
      id: `bl:backlinks:${snapshot.id}`,
      projectId,
      sourceTool: "get_backlinks_overview",
      provider: "dataforseo",
      metricName: "total_backlinks",
      metricValue: snapshot.backlinks,
      observationDate: snapshot.capturedAt,
      dataFreshness: freshnessLabel,
      sourceRecordIds: [String(snapshot.id)],
      isMeasured: true as const,
    },
    {
      id: `bl:referring_domains:${snapshot.id}`,
      projectId,
      sourceTool: "get_backlinks_overview",
      provider: "dataforseo",
      metricName: "referring_domains",
      metricValue: snapshot.referringDomains,
      observationDate: snapshot.capturedAt,
      dataFreshness: freshnessLabel,
      sourceRecordIds: [String(snapshot.id)],
      isMeasured: true as const,
    },
  ];

  const backlinkStatus: SeoSourceStatus["status"] =
    ageDays !== null && ageDays > 60 ? "stale" : "available";

  return {
    status: {
      source: "backlinks" as const,
      status: backlinkStatus,
      provider: "dataforseo",
      freshnessLabel,
      ageDays,
      recordCount: snapshot.backlinks ?? 0,
      limitations: [],
    },
    overview: {
      hasSnapshot: true,
      capturedAt: snapshot.capturedAt,
      backlinks: snapshot.backlinks,
      referringDomains: snapshot.referringDomains,
      rank: snapshot.rank,
    },
    observations,
  };
}

export {
  collectSavedKeywords,
  collectCompetitors,
} from "./seoEvidenceSecondarySources";
