/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DashboardService } from "./DashboardService";

const mocks = vi.hoisted(() => ({
  getLatestForProject: vi.fn(),
  insert: vi.fn(),
  route: vi.fn(),
}));

const overviewMocks = vi.hoisted(() => ({
  getConfigsForProject: vi.fn(),
  getLatestResults: vi.fn(),
  getLatestAuditForProject: vi.fn(),
  getIssueTypePageCountsForAudit: vi.fn(),
  getGscConnection: vi.fn(),
  gscHasCoverage: vi.fn(),
  gscGetTotals: vi.fn(),
  gscLatestSync: vi.fn(),
  gscActiveSync: vi.fn(),
  getGa4Connection: vi.fn(),
  ga4Overview: vi.fn(),
  ga4Acquisition: vi.fn(),
  ga4Conversions: vi.fn(),
  ga4GrainCoverage: vi.fn(),
  ga4ActiveSync: vi.fn(),
  ga4LatestSync: vi.fn(),
  listOpportunities: vi.fn(),
  getDashboardInsights: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: () => ({ route: mocks.route }),
}));
vi.mock(
  "@/server/features/dashboard/repositories/BacklinkSnapshotRepository",
  () => ({ BacklinkSnapshotRepository: mocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: overviewMocks.getConfigsForProject,
    },
  }),
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults", () => ({
  getLatestResults: overviewMocks.getLatestResults,
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    getLatestAuditForProject: overviewMocks.getLatestAuditForProject,
  },
}));
vi.mock("@/server/features/audit/repositories/auditSummaryQueries", () => ({
  getIssueTypePageCountsForAudit:
    overviewMocks.getIssueTypePageCountsForAudit,
}));
vi.mock("@/server/features/gsc/repositories/GscConnectionRepository", () => ({
  GscConnectionRepository: { getByProjectId: overviewMocks.getGscConnection },
}));
vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    GscSearchPerformanceRepository: {
      hasCoverage: overviewMocks.gscHasCoverage,
      getTotals: overviewMocks.gscGetTotals,
      getLatestSyncRun: overviewMocks.gscLatestSync,
      getActiveSyncRun: overviewMocks.gscActiveSync,
    },
  }),
);
vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: overviewMocks.getGa4Connection },
}));
vi.mock("@/server/features/ga4/services/AnalyticsService", () => ({
  AnalyticsService: {
    getOverview: overviewMocks.ga4Overview,
    getAcquisition: overviewMocks.ga4Acquisition,
    getConversions: overviewMocks.ga4Conversions,
  },
}));
vi.mock("@/server/features/ga4/repositories/Ga4SyncRepository", () => ({
  Ga4SyncRepository: {
    getGrainCoverage: overviewMocks.ga4GrainCoverage,
    getActiveSyncRun: overviewMocks.ga4ActiveSync,
    getLatestSyncRun: overviewMocks.ga4LatestSync,
  },
}));
vi.mock("@/server/features/intelligence/services/OpportunityService", () => ({
  listOpportunities: overviewMocks.listOpportunities,
}));
vi.mock("@/server/features/intelligence/services/InsightService", () => ({
  getDashboardInsights: overviewMocks.getDashboardInsights,
}));

const billingCustomer = {
  organizationId: "org_1",
  userId: "user_1",
  userEmail: "user@example.com",
};

const HOUR_MS = 60 * 60 * 1000;

function snapshotRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 1,
    projectId: "project_1",
    domain: "acme.com",
    rank: 42,
    backlinks: 1000,
    referringDomains: 500,
    brokenBacklinks: 2,
    newBacklinks: 10,
    lostBacklinks: 3,
    newReferringDomains: 4,
    lostReferringDomains: 1,
    capturedAt: new Date().toISOString(),
    ...overrides,
  };
}

describe("DashboardService.ensureBacklinkSnapshot", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
  });

  it("returns null without any call when the project has no domain", async () => {
    

    await expect(
      DashboardService.ensureBacklinkSnapshot({
        projectId: "project_1",
        domain: null,
        billingCustomer,
      }),
    ).resolves.toBeNull();

    expect(mocks.getLatestForProject).not.toHaveBeenCalled();
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("serves a fresh snapshot without touching the router", async () => {
    mocks.getLatestForProject.mockResolvedValue(snapshotRow());
    

    const result = await DashboardService.ensureBacklinkSnapshot({
      projectId: "project_1",
      domain: "acme.com",
      billingCustomer,
    });

    expect(mocks.route).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      domain: "acme.com",
      rank: 42,
      backlinks: 1000,
      referringDomains: 500,
      newBacklinks: 10,
      lostBacklinks: 3,
      newReferringDomains: 4,
      lostReferringDomains: 1,
      stale: false,
    });
  });

  it("routes stale snapshots through the backlinks router and write-throughs a paid fetch", async () => {
    mocks.getLatestForProject.mockResolvedValue(
      snapshotRow({ capturedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() }),
    );
    mocks.route.mockResolvedValue({
      data: {
        rank: 55,
        backlinks: 1200,
        referring_domains: 620,
        broken_backlinks: 3,
        new_backlinks: 14,
        lost_backlinks: 2,
        new_reffering_domains: 6,
        lost_reffering_domains: 1,
      },
      provider: "dataforseo",
      fromCache: false,
    });
    mocks.insert.mockImplementation((values: Record<string, unknown>) => {
      mocks.getLatestForProject.mockResolvedValue(snapshotRow(values));
      return Promise.resolve(snapshotRow(values));
    });
    

    const result = await DashboardService.ensureBacklinkSnapshot({
      projectId: "project_1",
      domain: "acme.com",
      billingCustomer,
    });

    expect(mocks.route).toHaveBeenCalledTimes(1);
    expect(mocks.route).toHaveBeenCalledWith({
      dataType: "backlinks",
      domain: "acme.com",
      billingCustomer,
      creditFeature: "backlinks",
      constraints: { projectId: "project_1", backlinkCall: "summary" },
    });
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project_1",
        domain: "acme.com",
        rank: 55,
        backlinks: 1200,
        referringDomains: 620,
        brokenBacklinks: 3,
        newBacklinks: 14,
        lostBacklinks: 2,
        newReferringDomains: 6,
        lostReferringDomains: 1,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher
        capturedAt: expect.any(String),
      }),
    );
    expect(result).toMatchObject({
      domain: "acme.com",
      rank: 55,
      backlinks: 1200,
      referringDomains: 620,
      stale: false,
    });
  });

  it("materializes cached data into the snapshot table when no row exists yet", async () => {
    mocks.getLatestForProject.mockResolvedValue(null);
    mocks.route.mockResolvedValue({
      data: {
        rank: 9,
        backlinks: 300,
        referringDomains: 120,
        newBacklinks: 5,
        lostBacklinks: 0,
        newReferringDomains: 2,
        lostReferringDomains: 0,
      },
      provider: "internal",
      fromCache: true,
    });
    mocks.insert.mockImplementation((values: Record<string, unknown>) => {
      mocks.getLatestForProject.mockResolvedValue(snapshotRow(values));
      return Promise.resolve(snapshotRow(values));
    });
    

    const result = await DashboardService.ensureBacklinkSnapshot({
      projectId: "project_1",
      domain: "acme.com",
      billingCustomer,
    });

    expect(mocks.insert).toHaveBeenCalledTimes(1);
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({
        rank: 9,
        backlinks: 300,
        referringDomains: 120,
        newBacklinks: 5,
        // oxlint-disable-next-line typescript/no-unsafe-assignment -- Vitest asymmetric matcher
        capturedAt: expect.any(String),
      }),
    );
    expect(result).toMatchObject({ domain: "acme.com", rank: 9 });
  });

  it("does not re-insert cached data over an existing row (no fake freshness)", async () => {
    mocks.getLatestForProject.mockResolvedValue(
      snapshotRow({ capturedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() }),
    );
    mocks.route.mockResolvedValue({
      data: {
        rank: 55,
        backlinks: 1200,
        referringDomains: 620,
        newBacklinks: 14,
        lostBacklinks: 2,
        newReferringDomains: 6,
        lostReferringDomains: 1,
      },
      provider: "internal",
      fromCache: true,
    });
    

    const result = await DashboardService.ensureBacklinkSnapshot({
      projectId: "project_1",
      domain: "acme.com",
      billingCustomer,
    });

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ stale: true });
  });

  it("returns the stale snapshot when the refresh fails and a row exists", async () => {
    mocks.getLatestForProject.mockResolvedValue(
      snapshotRow({ capturedAt: new Date(Date.now() - 25 * HOUR_MS).toISOString() }),
    );
    mocks.route.mockRejectedValue(new Error("upstream down"));
    

    const result = await DashboardService.ensureBacklinkSnapshot({
      projectId: "project_1",
      domain: "acme.com",
      billingCustomer,
    });

    expect(mocks.insert).not.toHaveBeenCalled();
    expect(result).toMatchObject({ domain: "acme.com", rank: 42, stale: true });
  });

  it("rethrows when the refresh fails and no snapshot exists", async () => {
    mocks.getLatestForProject.mockResolvedValue(null);
    mocks.route.mockRejectedValue(new Error("budget exceeded"));


    await expect(
      DashboardService.ensureBacklinkSnapshot({
        projectId: "project_1",
        domain: "acme.com",
        billingCustomer,
      }),
    ).rejects.toThrow("budget exceeded");
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});

const overviewInput = {
  projectId: "project_1",
  domain: "acme.com",
  organizationId: "org_1",
  userId: "user_1",
};

function metricDelta(current: number, previous: number) {
  return {
    current,
    previous,
    change: current - previous,
    pctChange: previous === 0 ? (current === 0 ? 0 : null) : ((current - previous) / previous) * 100,
  };
}

function seedHappyPath() {
  overviewMocks.getConfigsForProject.mockResolvedValue([{ id: "cfg_1" }]);
  overviewMocks.getLatestResults.mockResolvedValue({
    run: { lastCheckedAt: "2026-09-28T00:00:00.000Z" },
    rows: [
      {
        desktop: { position: 2, previousPosition: 5 },
        mobile: { position: 12, previousPosition: 10 },
      },
    ],
  });
  overviewMocks.getLatestAuditForProject.mockResolvedValue({
    status: "completed",
    pagesCrawled: 10,
    startedAt: new Date().toISOString(),
  });
  overviewMocks.getIssueTypePageCountsForAudit.mockResolvedValue([
    { issueType: "missing_title", severity: "critical", pages: 3 },
  ]);
  mocks.getLatestForProject.mockResolvedValue(snapshotRow());
  overviewMocks.getGscConnection.mockResolvedValue({
    siteUrl: "https://acme.com",
  });
  overviewMocks.gscHasCoverage.mockResolvedValue(true);
  // Window calls are issued current-then-previous; the counter pins that order.
  let totalsCalls = 0;
  overviewMocks.gscGetTotals.mockImplementation(() => {
    totalsCalls += 1;
    return Promise.resolve(
      totalsCalls === 1
        ? { clicks: 100, impressions: 1000, ctr: 0.1, position: 5 }
        : { clicks: 80, impressions: 900, ctr: 80 / 900, position: 6 },
    );
  });
  overviewMocks.gscLatestSync.mockResolvedValue({
    status: "completed",
    completedAt: new Date().toISOString(),
  });
  overviewMocks.gscActiveSync.mockResolvedValue(null);
  overviewMocks.getGa4Connection.mockResolvedValue({
    propertyId: "prop_1",
    currencyCode: "USD",
  });
  overviewMocks.ga4Overview.mockResolvedValue({
    connected: true,
    coverage: { status: "complete", coveredDates: 28, totalDates: 28 },
    totals: {
      sessions: metricDelta(50, 40),
      engagedSessions: metricDelta(30, 20),
      engagementRate: metricDelta(0.6, 0.5),
      transactions: metricDelta(4, 2),
    },
  });
  overviewMocks.ga4Acquisition.mockResolvedValue({
    connected: true,
    rows: [
      {
        channelGroup: "Organic Search",
        source: "google",
        medium: "organic",
        isOrganic: true,
        sessions: metricDelta(30, 20),
      },
      {
        channelGroup: "Direct",
        source: "(direct)",
        medium: "(none)",
        isOrganic: false,
        sessions: metricDelta(20, 20),
      },
    ],
  });
  overviewMocks.ga4Conversions.mockResolvedValue({
    connected: true,
    coverage: {
      status: "complete",
      coveredDates: 28,
      totalDates: 28,
      coveredThrough: "2026-09-28",
    },
    rows: [
      {
        eventName: "purchase",
        isKeyEvent: true,
        eventCount: metricDelta(5, 3),
      },
    ],
  });
  overviewMocks.ga4GrainCoverage.mockResolvedValue({
    coveredDates: ["2026-09-01"],
    coveredThrough: "2026-09-28",
  });
  overviewMocks.ga4ActiveSync.mockResolvedValue(null);
  overviewMocks.ga4LatestSync.mockResolvedValue({ status: "completed" });
  overviewMocks.listOpportunities.mockResolvedValue([
    { status: "open", priority: "Critical" },
    { status: "open", priority: "High" },
    { status: "in_progress", priority: "Medium" },
    { status: "completed", priority: "Critical" },
  ]);
  overviewMocks.getDashboardInsights.mockResolvedValue({
    insights: [
      {
        insightKey: "k1",
        title: "Traffic dip",
        severity: "high",
        explanationFact: "Clicks dropped 20% this week.",
        recommendation: "Check the decayed landing pages.",
        sources: ["gsc"],
        detectedAt: "2026-09-27T00:00:00.000Z",
      },
    ],
    dismissedCount: 1,
    banner: {
      skipped: [],
      failed: [],
      lastCompletedAt: "2026-09-27T00:00:00.000Z",
      hasSuccessfulScan: true,
      stale: false,
      ga4Connected: true,
    },
  });
}

describe("DashboardService.getOverview intelligence sections", () => {
  beforeEach(() => {
    for (const mock of Object.values(mocks)) mock.mockReset();
    for (const mock of Object.values(overviewMocks)) mock.mockReset();
    seedHappyPath();
  });

  it("returns all eight sections with deltas and never touches the paid router", async () => {
    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    const sections = overview.sections;
    expect(Object.keys(sections).toSorted()).toEqual(
      [
        "backlinks",
        "conversions",
        "opportunities",
        "recentChanges",
        "searchVisibility",
        "seoPerformance",
        "technicalHealth",
        "trafficEngagement",
      ].toSorted(),
    );
    expect(sections.seoPerformance.metrics).toMatchObject({
      clicks: { current: 100, previous: 80, change: 20, changePct: 25 },
    });
    expect(sections.trafficEngagement.metrics).toMatchObject({
      sessions: { current: 50, previous: 40, change: 10, changePct: 25 },
      organicSessions: { current: 30, previous: 20 },
    });
    expect(sections.opportunities.metrics).toEqual({
      critical: 1,
      high: 1,
      medium: 1,
      openTotal: 3,
    });
    expect(sections.conversions.state).toBe("ready");
    expect(sections.conversions.metrics?.keyEvents).toHaveLength(1);
    expect(sections.recentChanges.metrics?.dismissedCount).toBe(1);
    // Stored-only: the provider router (paid path) is never invoked.
    expect(mocks.route).not.toHaveBeenCalled();
  });

  it("nulls deltas when prior coverage is missing and never renders failure as zero", async () => {
    // Coverage calls are issued current-then-previous: current covered, previous not.
    let coverageCalls = 0;
    overviewMocks.gscHasCoverage.mockImplementation(() => {
      coverageCalls += 1;
      return Promise.resolve(coverageCalls === 1);
    });
    overviewMocks.ga4GrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.seoPerformance.state).toBe("partial");
    expect(overview.sections.seoPerformance.metrics?.clicks).toEqual({
      current: 100,
      previous: null,
      change: null,
      changePct: null,
    });
    expect(
      overview.sections.trafficEngagement.metrics?.sessions.previous,
    ).toBeNull();
    expect(
      overview.sections.trafficEngagement.metrics?.sessions.change,
    ).toBeNull();
  });

  it("maps a failed sync with no coverage to sync_failed with null metrics", async () => {
    overviewMocks.gscHasCoverage.mockResolvedValue(false);
    overviewMocks.gscLatestSync.mockResolvedValue({ status: "failed" });
    overviewMocks.gscActiveSync.mockResolvedValue(null);

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.seoPerformance.state).toBe("sync_failed");
    expect(overview.sections.seoPerformance.metrics).toBeNull();
  });

  it("renders disconnected, empty, and stale states without zeros", async () => {
    // Acquisition disconnected → traffic not_connected while the connection row exists.
    // Transactions at zero + no key events → conversions empty (honest, not failure).
    overviewMocks.ga4Acquisition.mockResolvedValue({ connected: false });
    overviewMocks.ga4Overview.mockResolvedValue({
      connected: true,
      coverage: { status: "complete", coveredDates: 28, totalDates: 28 },
      totals: {
        sessions: metricDelta(50, 40),
        engagedSessions: metricDelta(30, 20),
        engagementRate: metricDelta(0.6, 0.5),
        transactions: metricDelta(0, 0),
      },
    });
    overviewMocks.ga4Conversions.mockResolvedValue({
      connected: true,
      coverage: {
        status: "complete",
        coveredDates: 28,
        totalDates: 28,
        coveredThrough: "2026-09-28",
      },
      rows: [],
    });
    overviewMocks.getLatestAuditForProject.mockResolvedValue({
      status: "completed",
      pagesCrawled: 4,
      startedAt: new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString(),
    });
    mocks.getLatestForProject.mockResolvedValue(null);

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.trafficEngagement.state).toBe("not_connected");
    expect(overview.sections.trafficEngagement.metrics).toBeNull();
    expect(overview.sections.conversions.state).toBe("empty");
    expect(overview.sections.technicalHealth.state).toBe("stale");
    expect(overview.sections.backlinks.state).toBe("no_data");
    expect(overview.sections.searchVisibility.metrics).toMatchObject({
      top3: { current: 1 },
      top10: { current: 1 },
      top100: { current: 2 },
      improved: 1,
      declined: 1,
    });
  });

  it("separates insight facts from recommendations with source badges", async () => {
    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.recentChanges.state).toBe("ready");
    expect(overview.sections.recentChanges.metrics).toMatchObject({
      dismissedCount: 1,
      items: [
        {
          fact: "Clicks dropped 20% this week.",
          recommendation: "Check the decayed landing pages.",
          sources: ["gsc"],
        },
      ],
    });
  });

  it("marks an unexpected section failure as api_failed instead of zeros", async () => {
    overviewMocks.listOpportunities.mockRejectedValue(new Error("db down"));

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.opportunities.state).toBe("api_failed");
    expect(overview.sections.opportunities.metrics).toBeNull();
    expect(overview.sections.seoPerformance.state).toBe("ready");
  });

  it("maps a missing GA4 connection to not_connected GA4 sections", async () => {
    overviewMocks.getGa4Connection.mockResolvedValue(null);

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.trafficEngagement.state).toBe("not_connected");
    expect(overview.sections.trafficEngagement.metrics).toBeNull();
    expect(overview.sections.conversions.state).toBe("not_connected");
    expect(overview.sections.conversions.metrics).toBeNull();
  });

  it("shows guidance states with no errors for a brand-new project", async () => {
    overviewMocks.getConfigsForProject.mockResolvedValue([]);
    overviewMocks.getLatestAuditForProject.mockResolvedValue(null);
    mocks.getLatestForProject.mockResolvedValue(null);
    overviewMocks.getGscConnection.mockResolvedValue(null);
    overviewMocks.getGa4Connection.mockResolvedValue(null);
    overviewMocks.listOpportunities.mockResolvedValue([]);
    overviewMocks.getDashboardInsights.mockResolvedValue({
      insights: [],
      dismissedCount: 0,
      banner: {
        skipped: [],
        failed: [],
        lastCompletedAt: null,
        hasSuccessfulScan: false,
        stale: false,
        ga4Connected: false,
      },
    });

    const overview = await DashboardService.getIntelligenceOverview(overviewInput);

    expect(overview.sections.seoPerformance.state).toBe("not_connected");
    expect(overview.sections.trafficEngagement.state).toBe("not_connected");
    expect(overview.sections.searchVisibility.state).toBe("empty");
    expect(overview.sections.technicalHealth.state).toBe("no_data");
    expect(overview.sections.backlinks.state).toBe("no_data");
    expect(overview.sections.recentChanges.state).toBe("empty");
    expect(overview.sections.opportunities.metrics).toEqual({
      critical: 0,
      high: 0,
      medium: 0,
      openTotal: 0,
    });
    for (const section of Object.values(overview.sections)) {
      if (section.metrics !== null) continue;
      expect(section.state).not.toBe("ready");
    }
  });

  it("keeps the legacy overview shape for existing cards and report snapshots", async () => {    const overview = await DashboardService.getOverview({
      projectId: "project_1",
      domain: "acme.com",
    });

    expect(Object.keys(overview).toSorted()).toEqual(
      ["audit", "backlinks", "rank"].toSorted(),
    );
    expect(overview.rank).toMatchObject({ trackedKeywords: 1, top10: 1 });
    expect(overview.audit?.status).toBe("completed");
    expect(overview.backlinks?.domain).toBe("acme.com");
  });
});