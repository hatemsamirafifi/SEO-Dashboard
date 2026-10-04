/* eslint-disable max-lines */
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { ActivationRepository } from "@/server/features/activation/repositories/ActivationRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { getIssueTypePageCountsForAudit } from "@/server/features/audit/repositories/auditSummaryQueries";
import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import { AnalyticsService } from "@/server/features/ga4/services/AnalyticsService";
import { Ga4GoalService } from "@/server/features/ga4/services/Ga4GoalService";
import { Ga4ConnectionRepository } from "@/server/features/ga4/repositories/Ga4ConnectionRepository";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GscConnectionRepository } from "@/server/features/gsc/repositories/GscConnectionRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { previousPeriod } from "@/server/features/gsc/searchPerformanceReport";
import { getDashboardInsights } from "@/server/features/intelligence/services/InsightService";
import { listOpportunities } from "@/server/features/intelligence/services/OpportunityService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { getLatestResults } from "@/server/features/rank-tracking/services/rankTrackingResults";
import {
  normalizeBacklinksTarget,
} from "@/server/lib/dataforseo";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import {
  mapStoredSectionState,
  toPeriodDelta,
  type CoverageNote,
  type DashboardSectionState,
  type PeriodDelta,
} from "@/shared/intelligence";

// Daily cadence: fresh numbers each visit without per-visit spend; a dormant
// project costs nothing because refreshes are visit-triggered.
const SNAPSHOT_MAX_AGE_MS = 24 * 60 * 60 * 1000;
// Bounds the per-config result reads on the overview path; projects rarely
// have more than a couple of configs.
const MAX_CONFIGS_FOR_OVERVIEW = 5;

export type DashboardActivation = {
  domain: string | null;
  gsc: { connected: boolean; siteUrl: string | null };
  mcp: {
    authorizedAt: string | null;
    firstToolCallAt: string | null;
    cardDismissedAt: string | null;
  };
  competitorClickedAt: string | null;
};

type DashboardRankSummary = {
  trackedKeywords: number;
  improved: number;
  declined: number;
  top10: number;
  lastCheckedAt: string | null;
};

export type DashboardAuditSummary = {
  status: "running" | "completed" | "failed";
  pagesCrawled: number;
  startedAt: string;
  // Top issue types by severity then affected-page count, for the card's list.
  topIssues: {
    issueType: string;
    severity: "critical" | "warning" | "info";
    count: number;
  }[];
  totalIssueTypes: number;
};

export type DashboardBacklinkSummary = {
  domain: string;
  rank: number | null;
  backlinks: number | null;
  referringDomains: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  capturedAt: string;
  stale: boolean;
};

type DashboardOverview = {
  rank: DashboardRankSummary | null;
  audit: DashboardAuditSummary | null;
  backlinks: DashboardBacklinkSummary | null;
};

export type IntelligenceOverview = {
  window: OverviewWindow;
  previousWindow: OverviewWindow;
  sections: DashboardIntelligenceSections;
};

async function getActivation(input: {
  projectId: string;
  organizationId: string;
  domain: string | null;
}): Promise<DashboardActivation> {
  const [gsc, orgActivation, projectActivation] = await Promise.all([
    GscConnectionRepository.getByProjectId(input.projectId),
    ActivationRepository.getOrganizationActivation(input.organizationId),
    ActivationRepository.getProjectActivation(input.projectId),
  ]);

  return {
    domain: input.domain,
    gsc: { connected: gsc !== null, siteUrl: gsc?.siteUrl ?? null },
    mcp: {
      authorizedAt: orgActivation?.firstMcpAuthorizedAt ?? null,
      firstToolCallAt: orgActivation?.firstMcpToolCallAt ?? null,
      cardDismissedAt: projectActivation?.mcpCardDismissedAt ?? null,
    },
    competitorClickedAt: projectActivation?.competitorStepClickedAt ?? null,
  };
}

async function getOverview(input: {
  projectId: string;
  domain: string | null;
}): Promise<DashboardOverview> {
  const [rank, audit, backlinks] = await Promise.all([
    getRankSummary(input.projectId),
    getAuditSummary(input.projectId),
    getBacklinkSummary(input.projectId, input.domain),
  ]);
  return { rank, audit, backlinks };
}

/**
 * A0 stored intelligence rollup (spec 001). Kept separate from the legacy
 * getOverview so existing consumers (dashboard cards, report snapshots) keep
 * their shape; the server function merges both additively. Scoped reads need
 * organizationId/userId, which the legacy overview never required.
 */
async function getIntelligenceOverview(input: {
  projectId: string;
  domain: string | null;
  organizationId: string;
  userId: string;
}): Promise<IntelligenceOverview> {
  const todayIso = new Date().toISOString().slice(0, 10);
  const dayMs = 24 * 60 * 60 * 1000;
  const toMs = Date.parse(`${todayIso}T00:00:00Z`);
  const current: OverviewWindow = {
    from: new Date(toMs - (OVERVIEW_WINDOW_DAYS - 1) * dayMs)
      .toISOString()
      .slice(0, 10),
    to: todayIso,
  };
  // One shared date-boundary rule for GSC, GA4, rank, and dashboard rollups
  // (spec 001 clarification): the immediately-preceding equal-length window.
  // GA4's resolveAnalyticsWindows("last_28_days", today) derives the identical
  // windows, so cross-source deltas stay aligned by construction.
  // previousPeriod uses {startDate, endDate} naming — adapt once, here.
  const prevPeriod = previousPeriod(current.from, current.to);
  const previous: OverviewWindow = {
    from: prevPeriod.startDate,
    to: prevPeriod.endDate,
  };

  const [
    seoPerformance,
    searchVisibility,
    trafficEngagement,
    conversions,
    opportunities,
    technicalHealth,
    backlinksSection,
    recentChanges,
  ] = await Promise.all([
    safeSection("gsc", () =>
      getSeoPerformanceSection(input.projectId, current, previous),
    ),
    safeSection("rank", () => getSearchVisibilitySection(input.projectId)),
    safeSection("ga4", () =>
      getTrafficEngagementSection(
        input.projectId,
        input.organizationId,
        current,
        previous,
      ),
    ),
    safeSection("ga4", () =>
      getConversionsSection(
        input.projectId,
        input.organizationId,
        current,
        previous,
      ),
    ),
    safeSection("opportunities", () =>
      getOpportunitiesSection(input.projectId),
    ),
    safeSection("audit", () => getTechnicalHealthSection(input.projectId)),
    safeSection("backlinks", () =>
      getBacklinksSection(input.projectId, input.domain),
    ),
    safeSection("insights", () =>
      getRecentChangesSection(
        input.projectId,
        input.organizationId,
        input.userId,
      ),
    ),
  ]);
  return {
    window: current,
    previousWindow: previous,
    sections: {
      seoPerformance,
      searchVisibility,
      trafficEngagement,
      conversions,
      opportunities,
      technicalHealth,
      backlinks: backlinksSection,
      recentChanges,
    },
  };
}

type RankSnapshotRow = {
  position: number | null;
  previousPosition: number | null;
};

async function loadRankRows(projectId: string): Promise<{
  entries: RankSnapshotRow[];
  trackedKeywords: number;
  lastCheckedAt: string | null;
} | null> {
  const configs = await RankTrackingRepository.getConfigsForProject(projectId);
  if (configs.length === 0) return null;

  const results = await Promise.all(
    configs
      .slice(0, MAX_CONFIGS_FOR_OVERVIEW)
      .map((config) => getLatestResults(config.id, projectId, "7d")),
  );

  const entries: RankSnapshotRow[] = [];
  let trackedKeywords = 0;
  let lastCheckedAt: string | null = null;
  for (const result of results) {
    trackedKeywords += result.rows.length;
    if (
      result.run &&
      (!lastCheckedAt || result.run.lastCheckedAt > lastCheckedAt)
    ) {
      lastCheckedAt = result.run.lastCheckedAt;
    }
    for (const row of result.rows) {
      for (const device of ["desktop", "mobile"] as const) {
        entries.push({
          position: row[device].position,
          previousPosition: row[device].previousPosition,
        });
      }
    }
  }
  return { entries, trackedKeywords, lastCheckedAt };
}

async function getRankSummary(
  projectId: string,
): Promise<DashboardRankSummary | null> {
  const loaded = await loadRankRows(projectId);
  if (!loaded) return null;

  const summary: DashboardRankSummary = {
    trackedKeywords: loaded.trackedKeywords,
    improved: 0,
    declined: 0,
    top10: 0,
    lastCheckedAt: loaded.lastCheckedAt,
  };

  for (const entry of loaded.entries) {
    const { position, previousPosition } = entry;
    if (position !== null && position <= 10) summary.top10 += 1;
    if (position === null || previousPosition === null) continue;
    // Lower position number = better ranking.
    if (position < previousPosition) summary.improved += 1;
    else if (position > previousPosition) summary.declined += 1;
  }

  return summary;
}

async function getAuditSummary(
  projectId: string,
): Promise<DashboardAuditSummary | null> {
  const audit = await AuditRepository.getLatestAuditForProject(projectId);
  if (!audit) return null;

  const typeRows = await getIssueTypePageCountsForAudit(audit.id);

  const severityRank = { critical: 0, warning: 1, info: 2 };
  const sorted = typeRows
    .map((row) => ({
      issueType: row.issueType,
      severity: row.severity,
      count: row.pages,
    }))
    .toSorted(
      (a, b) =>
        severityRank[a.severity] - severityRank[b.severity] ||
        b.count - a.count,
    );

  return {
    status: audit.status,
    pagesCrawled: audit.pagesCrawled,
    startedAt: audit.startedAt,
    topIssues: sorted.slice(0, 3),
    totalIssueTypes: sorted.length,
  };
}

function isSnapshotFresh(capturedAt: string): boolean {
  const capturedMs = Date.parse(capturedAt);
  if (Number.isNaN(capturedMs)) return false;
  return Date.now() - capturedMs < SNAPSHOT_MAX_AGE_MS;
}

async function getBacklinkSummary(
  projectId: string,
  domain: string | null,
): Promise<DashboardBacklinkSummary | null> {
  if (!domain) return null;
  const snapshot =
    await BacklinkSnapshotRepository.getLatestForProject(projectId);
  if (!snapshot || snapshot.domain !== domain) return null;
  return {
    domain: snapshot.domain,
    rank: snapshot.rank,
    backlinks: snapshot.backlinks,
    referringDomains: snapshot.referringDomains,
    newBacklinks: snapshot.newBacklinks,
    lostBacklinks: snapshot.lostBacklinks,
    newReferringDomains: snapshot.newReferringDomains,
    lostReferringDomains: snapshot.lostReferringDomains,
    capturedAt: snapshot.capturedAt,
    stale: !isSnapshotFresh(snapshot.capturedAt),
  };
}

/**
 * Backlink summary payload as returned by the router: the DataForSEO provider
 * yields snake_case fields (with DataForSEO's `reffering` typo fallbacks), the
 * internal provider yields camelCase rows. Both are mapped into the fields the
 * snapshot repository insert expects.
 */
type BacklinkSummaryItem = {
  rank?: number | null;
  backlinks?: number | null;
  referring_domains?: number | null;
  referringDomains?: number | null;
  broken_backlinks?: number | null;
  brokenBacklinks?: number | null;
  new_backlinks?: number | null;
  newBacklinks?: number | null;
  lost_backlinks?: number | null;
  lostBacklinks?: number | null;
  new_referring_domains?: number | null;
  new_reffering_domains?: number | null;
  newReferringDomains?: number | null;
  lost_referring_domains?: number | null;
  lost_reffering_domains?: number | null;
  lostReferringDomains?: number | null;
};

function toSummaryFields(
  item: BacklinkSummaryItem,
): Omit<
  Parameters<typeof BacklinkSnapshotRepository.insert>[0],
  "projectId" | "domain" | "capturedAt"
> {
  return {
    rank: item.rank ?? null,
    backlinks: item.backlinks ?? null,
    referringDomains:
      item.referringDomains ?? item.referring_domains ?? null,
    brokenBacklinks: item.brokenBacklinks ?? item.broken_backlinks ?? null,
    newBacklinks: item.newBacklinks ?? item.new_backlinks ?? null,
    lostBacklinks: item.lostBacklinks ?? item.lost_backlinks ?? null,
    newReferringDomains:
      item.newReferringDomains ??
      item.new_referring_domains ??
      item.new_reffering_domains ??
      null,
    lostReferringDomains:
      item.lostReferringDomains ??
      item.lost_referring_domains ??
      item.lost_reffering_domains ??
      null,
  };
}

/**
 * Visit-triggered snapshot refresh. Fetches the backlinks summary through the
 * seo data router (R2 cache → internal snapshot → DataForSEO), and is a no-op
 * while the latest snapshot for the current domain is under a day old.
 * Concurrent loads racing the freshness check coalesce on the router's
 * single-flight, so identical data is paid for at most once per cache TTL. On
 * a fetch failure with a stale snapshot in hand, the stale snapshot is
 * returned rather than surfacing an error card.
 *
 * The snapshot row's capturedAt is only bumped by a genuine DataForSEO fetch
 * (or a first-ever fetch served from the shared cache), so the dashboard's
 * stale badge reflects the real capture age — cached refreshes never fake a
 * fresh capture.
 */
async function ensureBacklinkSnapshot(input: {
  projectId: string;
  domain: string | null;
  billingCustomer: BillingCustomerContext;
}): Promise<DashboardBacklinkSummary | null> {
  const { projectId, domain } = input;
  if (!domain) return null;

  const latest =
    await BacklinkSnapshotRepository.getLatestForProject(projectId);
  const latestMatchesDomain = latest !== null && latest.domain === domain;
  if (latest && latestMatchesDomain && isSnapshotFresh(latest.capturedAt)) {
    return getBacklinkSummary(projectId, domain);
  }

  const normalized = normalizeBacklinksTarget(domain, { scope: "domain" });

  try {
    const { data, provider } = await getSeoDataRouter().route<BacklinkSummaryItem>({
      dataType: "backlinks",
      domain: normalized.apiTarget,
      billingCustomer: input.billingCustomer,
      creditFeature: "backlinks",
      constraints: { projectId, backlinkCall: "summary" },
    });
    if (provider === "dataforseo" || latest === null) {
      await BacklinkSnapshotRepository.insert({
        projectId,
        domain,
        ...toSummaryFields(data),
        capturedAt: new Date().toISOString(),
      });
    }
  } catch (error) {
    if (latestMatchesDomain) {
      console.error("dashboard: backlink snapshot refresh failed", error);
      return getBacklinkSummary(projectId, domain);
    }
    throw error;
  }

  return getBacklinkSummary(projectId, domain);
}

// ---------------------------------------------------------------------------
// A0 stored intelligence rollup (spec 001). Every section below reads stored
// or normalized data only — the overview never invokes a paid provider. A
// failed or missing source renders an explicit state with null metrics;
// failure is never coerced to zero.
// ---------------------------------------------------------------------------

const OVERVIEW_WINDOW_DAYS = 28;
const AUDIT_STALE_AFTER_MS = 30 * 24 * 60 * 60 * 1000;
const RECENT_INSIGHT_LIMIT = 5;
const CONVERSION_ROW_LIMIT = 5;

export type OverviewWindow = { from: string; to: string };

export type OverviewSection<T> = {
  state: DashboardSectionState;
  coverage: CoverageNote;
  metrics: T | null;
};

export type SeoPerformanceMetrics = {
  clicks: PeriodDelta;
  impressions: PeriodDelta;
  ctr: PeriodDelta;
  avgPosition: PeriodDelta;
};

export type SearchVisibilityMetrics = {
  top3: PeriodDelta;
  top10: PeriodDelta;
  top100: PeriodDelta;
  improved: number;
  declined: number;
  trackedKeywords: number;
};

export type TrafficEngagementMetrics = {
  sessions: PeriodDelta;
  organicSessions: PeriodDelta;
  engagedSessions: PeriodDelta;
  engagementRate: PeriodDelta;
};

export type ConversionsMetrics = {
  keyEvents: { name: string; count: PeriodDelta }[];
  transactions: PeriodDelta;
};

export type OpportunitiesMetrics = {
  critical: number;
  high: number;
  medium: number;
  openTotal: number;
};

export type TechnicalHealthMetrics = DashboardAuditSummary & {
  lastAuditAt: string;
};

export type BacklinksMetrics = {
  backlinks: number | null;
  referringDomains: number | null;
  newBacklinks: number | null;
  lostBacklinks: number | null;
  newReferringDomains: number | null;
  lostReferringDomains: number | null;
  capturedAt: string;
};

export type RecentChangeItem = {
  title: string;
  fact: string;
  recommendation: string | null;
  sources: string[];
  detectedAt: string;
  severity: string;
};

export type RecentChangesMetrics = {
  items: RecentChangeItem[];
  dismissedCount: number;
};

export type DashboardIntelligenceSections = {
  seoPerformance: OverviewSection<SeoPerformanceMetrics>;
  searchVisibility: OverviewSection<SearchVisibilityMetrics>;
  trafficEngagement: OverviewSection<TrafficEngagementMetrics>;
  conversions: OverviewSection<ConversionsMetrics>;
  opportunities: OverviewSection<OpportunitiesMetrics>;
  technicalHealth: OverviewSection<TechnicalHealthMetrics>;
  backlinks: OverviewSection<BacklinksMetrics>;
  recentChanges: OverviewSection<RecentChangesMetrics>;
};

function unavailableSection<T>(
  source: CoverageNote["source"],
  state: DashboardSectionState,
  detail: string | null,
): OverviewSection<T> {
  return {
    state,
    coverage: { source, freshness: null, completeness: "none", detail },
    metrics: null,
  };
}

/** Unexpected section failures degrade to api_failed with null metrics —
 *  a broken read never renders as zero traffic, zero rank, or no data. */
async function safeSection<T>(
  source: CoverageNote["source"],
  build: () => Promise<OverviewSection<T>>,
): Promise<OverviewSection<T>> {
  try {
    return await build();
  } catch (error) {
    console.error("dashboard: intelligence section failed", source, error);
    return unavailableSection<T>(source, "api_failed", "Section read failed");
  }
}

type StoredDelta = {
  current: number;
  previous: number;
  change: number;
  pctChange: number | null;
};

function gateDelta(
  delta: StoredDelta,
  previousCovered: boolean,
): PeriodDelta {
  if (!previousCovered) {
    return {
      current: delta.current,
      previous: null,
      change: null,
      changePct: null,
    };
  }
  return {
    current: delta.current,
    previous: delta.previous,
    change: delta.change,
    changePct: delta.pctChange,
  };
}

async function getSeoPerformanceSection(
  projectId: string,
  current: OverviewWindow,
  previous: OverviewWindow,
): Promise<OverviewSection<SeoPerformanceMetrics>> {
  const connection = await GscConnectionRepository.getByProjectId(projectId);
  if (!connection) {
    return unavailableSection<SeoPerformanceMetrics>(
      "gsc",
      "not_connected",
      "Search Console is not connected",
    );
  }
  const [hasCurrent, hasPrevious, latestSync, activeSync] = await Promise.all([
    GscSearchPerformanceRepository.hasCoverage(
      projectId,
      current.from,
      current.to,
    ),
    GscSearchPerformanceRepository.hasCoverage(
      projectId,
      previous.from,
      previous.to,
    ),
    GscSearchPerformanceRepository.getLatestSyncRun(projectId),
    GscSearchPerformanceRepository.getActiveSyncRun(projectId),
  ]);
  const baseCoverage: CoverageNote = {
    source: "gsc",
    freshness: latestSync?.completedAt ?? null,
    completeness: "none",
    detail: null,
  };
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent,
    hasPrevious,
    syncRunning: activeSync !== null,
    syncFailed: latestSync?.status === "failed",
  });
  if (state === "no_data" || state === "sync_failed" || state === "sync_running") {
    return {
      state,
      coverage: {
        ...baseCoverage,
        detail:
          state === "sync_running"
            ? "Search Console sync is running"
            : state === "sync_failed"
              ? "Search Console sync failed"
              : "No Search Console data synced for this window",
      },
      metrics: null,
    };
  }
  const [currentTotals, previousTotals] = await Promise.all([
    GscSearchPerformanceRepository.getTotals(
      projectId,
      current.from,
      current.to,
    ),
    hasPrevious
      ? GscSearchPerformanceRepository.getTotals(
          projectId,
          previous.from,
          previous.to,
        )
      : Promise.resolve(null),
  ]);
  return {
    state,
    coverage: {
      ...baseCoverage,
      completeness: state === "partial" ? "partial" : "full",
      detail:
        state === "partial"
          ? "Previous period is not fully synced"
          : activeSync !== null
            ? "Search Console sync is running"
            : null,
    },
    metrics: {
      clicks: toPeriodDelta(currentTotals.clicks, previousTotals?.clicks ?? null),
      impressions: toPeriodDelta(
        currentTotals.impressions,
        previousTotals?.impressions ?? null,
      ),
      ctr: toPeriodDelta(currentTotals.ctr, previousTotals?.ctr ?? null),
      avgPosition: toPeriodDelta(
        currentTotals.position,
        previousTotals?.position ?? null,
      ),
    },
  };
}

async function getSearchVisibilitySection(
  projectId: string,
): Promise<OverviewSection<SearchVisibilityMetrics>> {
  const loaded = await loadRankRows(projectId);
  // Unified state derivation (spec 011, A2): unconfigured reads resolve via
  // the mapper — never configured means nothing ever synced (no_data, with
  // setup guidance); a completed check with zero ranked keywords is honestly
  // empty. This swaps the two pre-A2 labels into model-consistent states.
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent: loaded !== null,
    hasPrevious: loaded !== null,
    syncRunning: false,
    syncFailed: false,
    hasItems: loaded === null ? null : loaded.trackedKeywords > 0,
  });
  if (!loaded || state !== "ready") {
    return {
      state,
      coverage: {
        source: "rank",
        freshness: loaded?.lastCheckedAt ?? null,
        completeness: "none",
        detail:
          state === "no_data"
            ? "No rank tracking configured yet — add keywords to start tracking"
            : "Rank checks ran, but none of the tracked keywords rank yet",
      },
      metrics: null,
    };
  }
  let top3 = 0;
  let top10 = 0;
  let top100 = 0;
  let improved = 0;
  let declined = 0;
  for (const entry of loaded.entries) {
    if (entry.position === null) continue;
    if (entry.position <= 3) top3 += 1;
    if (entry.position <= 10) top10 += 1;
    if (entry.position <= 100) top100 += 1;
    if (entry.previousPosition === null) continue;
    if (entry.position < entry.previousPosition) improved += 1;
    else if (entry.position > entry.previousPosition) declined += 1;
  }
  return {
    state,
    coverage: {
      source: "rank",
      freshness: loaded.lastCheckedAt,
      completeness: "full",
      // Bands are a single latest-check snapshot; historical band deltas
      // arrive with rank history. Movement counts are already run-relative.
      detail: "Single-snapshot bands; improved/declined vs previous check",
    },
    metrics: {
      top3: toPeriodDelta(top3, null),
      top10: toPeriodDelta(top10, null),
      top100: toPeriodDelta(top100, null),
      improved,
      declined,
      trackedKeywords: loaded.trackedKeywords,
    },
  };
}

async function getTrafficEngagementSection(
  projectId: string,
  organizationId: string,
  current: OverviewWindow,
  previous: OverviewWindow,
): Promise<OverviewSection<TrafficEngagementMetrics>> {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  if (!connection) {
    return unavailableSection<TrafficEngagementMetrics>(
      "ga4",
      "not_connected",
      "Google Analytics is not connected",
    );
  }
  const [overview, acquisition, prevCoverage, activeSync, latestSync] =
    await Promise.all([
      AnalyticsService.getOverview({
        projectId,
        organizationId,
        range: "last_28_days",
      }),
      AnalyticsService.getAcquisition({
        projectId,
        organizationId,
        range: "last_28_days",
      }),
      Ga4SyncRepository.getGrainCoverage(
        projectId,
        connection.propertyId,
        "summary",
        previous.from,
        previous.to,
      ),
      Ga4SyncRepository.getActiveSyncRun(projectId, connection.propertyId),
      Ga4SyncRepository.getLatestSyncRun(projectId, connection.propertyId),
    ]);
  // Explicit connected guard first: it narrows the AnalyticsService
  // unions for the reads below AND keeps the honest not_connected outcome.
  // (No `state:` literal — see the T025 guard.)
  if (!overview.connected || !acquisition.connected) {
    return unavailableSection<TrafficEngagementMetrics>(
      "ga4",
      "not_connected",
      "Google Analytics is not connected",
    );
  }
  // Zero-row success is not failure (P21): an uncovered current window
  // resolves to a sync/no-data state regardless of previous coverage. Kept
  // explicit; the mapper below only decides between connected data states.
  if (overview.coverage.status === "none") {
    if (activeSync != null) {
      return unavailableSection<TrafficEngagementMetrics>(
        "ga4",
        "sync_running",
        "Google Analytics sync is running",
      );
    }
    if (latestSync?.status === "failed") {
      return unavailableSection<TrafficEngagementMetrics>(
        "ga4",
        "sync_failed",
        "Google Analytics sync failed",
      );
    }
    return unavailableSection<TrafficEngagementMetrics>(
      "ga4",
      "no_data",
      "No Google Analytics data synced for this window",
    );
  }
  // Unified state derivation (spec 011, A2): the mapper decides between
  // the connected data states (verified by the dashboard suite).
  const state = mapStoredSectionState({
    connected: overview.connected && acquisition.connected,
    hasCurrent: true,
    hasPrevious: prevCoverage.coveredDates.length > 0,
    syncRunning: false,
    syncFailed: false,
  });
  if (state !== "ready" && state !== "partial") {
    return {
      state,
      coverage: {
        source: "ga4",
        freshness: overview.coverage.coveredThrough ?? null,
        completeness: "none",
        detail:
          state === "not_connected"
            ? "Google Analytics is not connected"
            : state === "sync_running"
              ? "Google Analytics sync is running"
              : state === "sync_failed"
                ? "Google Analytics sync failed"
                : "No Google Analytics data synced for this window",
      },
      metrics: null,
    };
  }
  const previousCovered = prevCoverage.coveredDates.length > 0;
  void current;
  const organicRows = acquisition.rows.filter((row) => row.isOrganic);
  const organicCurrent = organicRows.reduce(
    (sum, row) => sum + row.sessions.current,
    0,
  );
  const organicPrevious = organicRows.reduce(
    (sum, row) => sum + row.sessions.previous,
    0,
  );
  return {
    state: previousCovered ? "ready" : "partial",
    coverage: {
      source: "ga4",
      freshness: overview.coverage.coveredThrough,
      completeness: overview.coverage.status === "complete" ? "full" : "partial",
      detail: previousCovered
        ? null
        : "Previous period is not synced",
    },
    metrics: {
      sessions: gateDelta(overview.totals.sessions, previousCovered),
      organicSessions: toPeriodDelta(
        organicCurrent,
        previousCovered ? organicPrevious : null,
      ),
      engagedSessions: gateDelta(
        overview.totals.engagedSessions,
        previousCovered,
      ),
      engagementRate: gateDelta(
        overview.totals.engagementRate,
        previousCovered,
      ),
    },
  };
}

async function getConversionsSection(
  projectId: string,
  organizationId: string,
  current: OverviewWindow,
  previous: OverviewWindow,
): Promise<OverviewSection<ConversionsMetrics>> {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  if (!connection) {
    return unavailableSection<ConversionsMetrics>(
      "ga4",
      "not_connected",
      "Google Analytics is not connected",
    );
  }
  const [conversions, overview, prevCoverage] = await Promise.all([
    AnalyticsService.getConversions({
      projectId,
      organizationId,
      range: "last_28_days",
      limit: CONVERSION_ROW_LIMIT,
    }),
    AnalyticsService.getOverview({
      projectId,
      organizationId,
      range: "last_28_days",
    }),
    Ga4SyncRepository.getGrainCoverage(
      projectId,
      connection.propertyId,
      "summary",
      previous.from,
      previous.to,
    ),
  ]);
  void current;
  // Explicit connected guard first: narrows the AnalyticsService unions for
  // the reads below AND keeps the honest not_connected outcome.
  // (No `state:` literal — see the T025 guard.)
  if (!conversions.connected || !overview.connected) {
    return unavailableSection<ConversionsMetrics>(
      "ga4",
      "not_connected",
      "Google Analytics is not connected",
    );
  }
  // Zero-row success is not failure (P21): an uncovered current window is
  // no_data regardless of previous-window coverage. Kept as an explicit
  // early return so the mapper below only decides between connected states.
  if (conversions.coverage.status === "none") {
    return unavailableSection<ConversionsMetrics>(
      "ga4",
      "no_data",
      "No conversion data synced for this window",
    );
  }
  // Unified state derivation (spec 011, A2): hasItems reflects the empty
  // case below (zero key events/goals AND zero transactions).
  const previousCovered = prevCoverage.coveredDates.length > 0;
  const transactions = gateDelta(overview.totals.transactions, previousCovered);
  // Project goals (spec 010/011): when active goals exist, conversion rows
  // are named by the project's stored goal names. Goal reads are per-goal
  // best-effort — a goal that fails (e.g. archived mid-read) is skipped and
  // the section falls back to key events rather than failing or zeroing.
  const goalRows = await getGoalConversionRows({
    projectId,
    organizationId,
    propertyId: connection.propertyId,
    current,
    previous,
    previousCovered,
    limit: CONVERSION_ROW_LIMIT,
  });
  const keyEvents =
    goalRows ??
    conversions.rows.map((row) => ({
      name: row.eventName,
      count: gateDelta(row.eventCount, previousCovered),
    }));
  const isEmpty = keyEvents.length === 0 && transactions.current === 0;
  const state = mapStoredSectionState({
    connected: conversions.connected && overview.connected,
    // Current-window coverage is established: the "none" case returned
    // early above, so hasCurrent is statically true here.
    hasCurrent: true,
    hasPrevious: previousCovered,
    syncRunning: false,
    syncFailed: false,
    hasItems: isEmpty ? false : null,
  });
  if (state !== "ready" && state !== "partial") {
    return {
      state,
      coverage: {
        source: "ga4",
        freshness: conversions.coverage.coveredThrough,
        completeness: state === "empty" ? "full" : "none",
        detail:
          state === "not_connected"
            ? "Google Analytics is not connected"
            : state === "empty"
              ? "No key events recorded in this window"
              : "No conversion data synced for this window",
      },
      // Empty keeps its (zero) metrics — an honest empty, never a failure.
      metrics: state === "empty" ? { keyEvents, transactions } : null,
    };
  }
  return {
    state,
    coverage: {
      source: "ga4",
      freshness: conversions.coverage.coveredThrough,
      completeness:
        conversions.coverage.status === "complete" ? "full" : "partial",
      detail: previousCovered ? null : "Previous period is not synced",
    },
    metrics: { keyEvents, transactions },
  };
}

/** Goal-scoped conversion rows named by stored goal name (spec 011, US3).
 *  Returns null when no active goals exist (caller falls back to key
 *  events) or when every goal read fails. Never throws: per-goal failures
 *  degrade to fewer rows, never to a failed section. */
async function getGoalConversionRows(input: {
  projectId: string;
  organizationId: string;
  propertyId: string;
  current: OverviewWindow;
  previous: OverviewWindow;
  previousCovered: boolean;
  limit: number;
}): Promise<{ name: string; count: PeriodDelta }[] | null> {
  let goals: { id: string; name: string }[];
  try {
    goals = await Ga4GoalService.listGoals({
      projectId: input.projectId,
      organizationId: input.organizationId,
    });
  } catch (error) {
    console.error("dashboard: goal list failed, using key events", error);
    return null;
  }
  if (goals.length === 0) return null;
  const rows = await Promise.all(
    goals.slice(0, input.limit).map(async (goal) => {
      try {
        const [currentRead, previousRead] = await Promise.all([
          Ga4GoalService.getGoalConversions({
            projectId: input.projectId,
            organizationId: input.organizationId,
            propertyId: input.propertyId,
            goalId: goal.id,
            from: input.current.from,
            to: input.current.to,
          }),
          Ga4GoalService.getGoalConversions({
            projectId: input.projectId,
            organizationId: input.organizationId,
            propertyId: input.propertyId,
            goalId: goal.id,
            from: input.previous.from,
            to: input.previous.to,
          }),
        ]);
        return {
          name: goal.name,
          count: toPeriodDelta(
            currentRead.conversions,
            input.previousCovered ? previousRead.conversions : null,
          ),
        };
      } catch (error) {
        console.error(
          "dashboard: goal conversions failed, skipping goal",
          goal.id,
          error,
        );
        return null;
      }
    }),
  );
  const kept = rows.filter((row) => row !== null);
  return kept.length > 0 ? kept : null;
}

async function getOpportunitiesSection(
  projectId: string,
): Promise<OverviewSection<OpportunitiesMetrics>> {
  const rows = await listOpportunities({ projectId });
  let critical = 0;
  let high = 0;
  let medium = 0;
  let openTotal = 0;
  for (const row of rows) {
    if (row.status !== "open" && row.status !== "in_progress") continue;
    openTotal += 1;
    if (row.priority === "Critical") critical += 1;
    else if (row.priority === "High") high += 1;
    else if (row.priority === "Medium") medium += 1;
  }
  // Counts derive from stored lifecycle rows, so zero is a real zero here —
  // never a provider failure rendered as absence. Unified derivation
  // (spec 011, A2): zero open items resolve to empty with metrics intact.
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent: true,
    hasPrevious: true,
    syncRunning: false,
    syncFailed: false,
    hasItems: openTotal > 0,
  });
  return {
    state,
    coverage: {
      source: "opportunities",
      freshness: null,
      completeness: "full",
      detail: null,
    },
    metrics: { critical, high, medium, openTotal },
  };
}

async function getTechnicalHealthSection(
  projectId: string,
): Promise<OverviewSection<TechnicalHealthMetrics>> {
  const audit = await getAuditSummary(projectId);
  if (!audit) {
    return unavailableSection<TechnicalHealthMetrics>(
      "audit",
      "no_data",
      "No site audit has completed yet",
    );
  }
  const baseCoverage: CoverageNote = {
    source: "audit",
    freshness: audit.startedAt,
    completeness: "none",
    detail: null,
  };
  // Unified derivation (spec 011, A2): the audit lifecycle maps onto
  // mapper inputs — outcomes match the pre-A2 branches exactly.
  const completed = audit.status === "completed";
  const stale =
    completed && Date.now() - Date.parse(audit.startedAt) > AUDIT_STALE_AFTER_MS;
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent: completed,
    hasPrevious: completed,
    syncRunning: audit.status === "running",
    syncFailed: audit.status === "failed",
    stale,
  });
  if (state !== "ready" && state !== "stale") {
    return {
      state,
      coverage: {
        ...baseCoverage,
        detail:
          state === "sync_running"
            ? "Site audit is running"
            : state === "sync_failed"
              ? "Latest site audit failed"
              : "No site audit has completed yet",
      },
      metrics: null,
    };
  }
  return {
    state,
    coverage: {
      ...baseCoverage,
      completeness: "full",
      detail: stale ? "Latest audit is over 30 days old" : null,
    },
    metrics: { ...audit, lastAuditAt: audit.startedAt },
  };
}

async function getBacklinksSection(
  projectId: string,
  domain: string | null,
): Promise<OverviewSection<BacklinksMetrics>> {
  // Stored snapshot only — refresh stays on the explicit visit-triggered path
  // (refreshDashboardBacklinkSnapshot), never on overview reads.
  const snapshot = await getBacklinkSummary(projectId, domain);
  // Unified derivation (spec 011, A2): outcomes match the pre-A2 branches.
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent: snapshot !== null,
    hasPrevious: snapshot !== null,
    syncRunning: false,
    syncFailed: false,
    stale: snapshot?.stale ?? false,
  });
  if (!snapshot || (state !== "ready" && state !== "stale")) {
    return unavailableSection<BacklinksMetrics>(
      "backlinks",
      "no_data",
      "No backlink snapshot for this domain",
    );
  }
  return {
    state,
    coverage: {
      source: "backlinks",
      freshness: snapshot.capturedAt,
      completeness: "full",
      detail: snapshot.stale ? "Snapshot is over a day old" : null,
    },
    metrics: {
      backlinks: snapshot.backlinks,
      referringDomains: snapshot.referringDomains,
      newBacklinks: snapshot.newBacklinks,
      lostBacklinks: snapshot.lostBacklinks,
      newReferringDomains: snapshot.newReferringDomains,
      lostReferringDomains: snapshot.lostReferringDomains,
      capturedAt: snapshot.capturedAt,
    },
  };
}

async function getRecentChangesSection(
  projectId: string,
  organizationId: string,
  userId: string,
): Promise<OverviewSection<RecentChangesMetrics>> {
  const connection = await Ga4ConnectionRepository.getByProjectId(
    projectId,
    organizationId,
  );
  const { insights, dismissedCount, banner } = await getDashboardInsights({
    projectId,
    organizationId,
    userId,
    ga4Connected: connection !== null,
  });
  const items: RecentChangeItem[] = insights
    .slice(0, RECENT_INSIGHT_LIMIT)
    .map((row) => ({
      title: row.title,
      fact: row.explanationFact,
      recommendation: row.recommendation ?? null,
      sources: row.sources,
      detectedAt: row.detectedAt,
      severity: row.severity,
    }));
  const skippedCount = banner.skipped.length + banner.failed.length;
  // Unified derivation (spec 011, A2): a completed insights read with zero
  // items is honestly empty.
  const state = mapStoredSectionState({
    connected: true,
    hasCurrent: true,
    hasPrevious: true,
    syncRunning: false,
    syncFailed: false,
    hasItems: items.length > 0,
  });
  return {
    state,
    coverage: {
      source: "insights",
      freshness: banner.lastCompletedAt,
      completeness: "full",
      detail:
        skippedCount > 0
          ? `${skippedCount} detector outcome(s) need attention`
          : null,
    },
    metrics: { items, dismissedCount },
  };
}

export const DashboardService = {
  getActivation,
  getOverview,
  getIntelligenceOverview,
  ensureBacklinkSnapshot,
};
