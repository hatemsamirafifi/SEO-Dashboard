/* eslint-disable typescript-eslint/unbound-method -- vi.mocked() references object-method repos for stubbing */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));

import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository";
import * as rankResultsService from "@/server/features/rank-tracking/services/rankTrackingResults";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { BacklinkSnapshotRepository } from "@/server/features/dashboard/repositories/BacklinkSnapshotRepository";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { collectProjectSeoEvidence } from "./seoEvidenceCollector";

vi.mock("@/server/features/projects/repositories/ProjectRepository");
vi.mock("@/server/features/rank-tracking/repositories/RankTrackingRepository");
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
);
vi.mock("@/server/features/rank-tracking/services/rankTrackingResults");
vi.mock("@/server/features/gsc/repositories/GscSearchPerformanceRepository");
vi.mock("@/server/features/audit/repositories/AuditRepository");
vi.mock("@/server/features/dashboard/repositories/BacklinkSnapshotRepository");
vi.mock("@/server/features/keywords/repositories/KeywordResearchRepository");
vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          orderBy: () => ({
            limit: () => Promise.resolve([]),
          }),
        }),
      }),
    }),
  },
}));

describe("collectProjectSeoEvidence", () => {
  const projectId = "proj-123";
  const orgId = "org-456";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws 404 AppError when project is not found or unauthorized", async () => {
    vi.mocked(
      ProjectRepository.getProjectForOrganization,
    ).mockResolvedValueOnce(null as any);

    await expect(
      collectProjectSeoEvidence({ projectId, organizationId: orgId }),
    ).rejects.toThrow("Project not found or unauthorized");
  });

  it("gathers evidence and formats measured overview when sources are present", async () => {
    vi.mocked(
      ProjectRepository.getProjectForOrganization,
    ).mockResolvedValueOnce({
      id: projectId,
      organizationId: orgId,
      domain: "example.com",
      name: "Example",
      createdAt: "2026-01-01",
      archivedAt: null,
      locationCode: 2840,
      languageCode: "en",
      indexnowKey: null,
    });

    vi.mocked(
      RankTrackingRepository.getConfigsForProject,
    ).mockResolvedValueOnce([
      {
        id: "rt-config-1",
        projectId,
        domain: "example.com",
        locationCode: 2840,
        locationName: "United States",
        languageCode: "en",
        scheduleInterval: "daily",
        isActive: true,
        createdAt: "2026-01-01",
        devices: "both",
        serpDepth: 100,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastSkipReason: null,
      },
    ]);

    vi.mocked(
      RankTrackingTargetRepository.getTargetsForProject,
    ).mockResolvedValueOnce([
      {
        id: "target-1",
        organizationId: orgId,
        localProjectId: projectId,
        trackingConfigId: "rt-config-1",
        searchEngine: "google",
        countryCode: "us",
        regionCode: null,
        cityName: null,
        languageCode: "en",
        device: "desktop",
        enabled: true,
        createdAt: "2026-01-01",
        updatedAt: "2026-01-01",
      },
    ]);

    vi.spyOn(rankResultsService, "getLatestResults").mockResolvedValueOnce({
      rows: [
        {
          trackingKeywordId: "kw-1",
          keyword: "seo dashboard",
          searchVolume: 1000,
          keywordDifficulty: 30,
          cpc: 1.5,
          desktop: {
            position: 5,
            previousPosition: 8,
            previousComparablePosition: 8,
            previousObservationDate: "2026-11-10",
            positionChange: 3,
            checkedAt: "2026-11-15T10:00:00Z",
            checkedDate: "2026-11-15",
            trackingTargetId: "target-1",
            targetLabel: "US (en) desktop",
            provider: "dataforseo",
            rankingUrl: "https://example.com/seo",
            comparisonMethod: "previous_comparable_observation",
            observationSource: "daily_sync",
            completionConfidence: "CONFIRMED",
            serpFeatures: [],
          },
          mobile: {
            position: null,
            previousPosition: null,
            previousComparablePosition: null,
            previousObservationDate: null,
            positionChange: null,
            checkedAt: null,
            checkedDate: null,
            trackingTargetId: null,
            targetLabel: null,
            provider: null,
            rankingUrl: null,
            comparisonMethod: "none",
            observationSource: null,
            completionConfidence: null,
            serpFeatures: [],
          },
        },
      ],
      run: { id: "run-1", lastCheckedAt: "2026-11-15T10:00:00Z" },
    });

    vi.mocked(
      GscSearchPerformanceRepository.getStoredCoverageRange,
    ).mockResolvedValueOnce({
      startDate: "2026-10-18",
      endDate: "2026-11-15",
      totalDays: 28,
    });

    vi.mocked(GscSearchPerformanceRepository.getTotals).mockResolvedValueOnce({
      clicks: 1500,
      impressions: 40000,
      ctr: 0.0375,
      position: 14.2,
    });

    vi.mocked(
      GscSearchPerformanceRepository.getStrikingDistance,
    ).mockResolvedValueOnce([
      {
        query: "freelance seo",
        page: "https://example.com/freelance",
        clicks: 80,
        impressions: 1200,
        position: 12.4,
      },
    ]);

    vi.mocked(GscSearchPerformanceRepository.getTableRows)
      .mockResolvedValueOnce({
        rows: [
          {
            key: "freelance seo",
            clicks: 80,
            impressions: 1200,
            ctr: 0.066,
            position: 12.4,
          },
        ],
        hasNextPage: false,
      })
      .mockResolvedValueOnce({
        rows: [
          {
            key: "https://example.com/freelance",
            clicks: 80,
            impressions: 1200,
            ctr: 0.066,
            position: 12.4,
          },
        ],
        hasNextPage: false,
      });

    vi.mocked(AuditRepository.getLatestAuditForProject).mockResolvedValueOnce({
      id: "audit-1",
      projectId,
      startedByUserId: "user-1",
      startUrl: "https://example.com",
      status: "completed",
      pagesCrawled: 50,
      pagesTotal: 50,
      urlsDiscovered: 50,
      urlsFetched: 50,
      urlsAnalyzed: 50,
      urlsBlocked: 0,
      urlsFailed: 0,
      urlsSkipped: 0,
      urlsRenderingRequired: 0,
      urlsExtractionComplete: 50,
      lighthouseTotal: 10,
      lighthouseCompleted: 10,
      lighthouseFailed: 0,
      startedAt: "2026-11-10T10:00:00Z",
      completedAt: "2026-11-10T10:15:00Z",
      currentPhase: null,
      workflowInstanceId: null,
      config: "{}",
    });

    vi.mocked(AuditRepository.getIssuesForAudit).mockResolvedValueOnce([
      {
        id: "issue-1",
        auditId: "audit-1",
        pageId: "page-1",
        pageUrl: "https://example.com/page-1",
        issueType: "missing_meta_description",
        severity: "warning",
        detailsJson: null,
      },
    ]);

    vi.mocked(AuditRepository.getPagesForAudit).mockResolvedValueOnce([
      {
        id: "page-1",
        url: "https://example.com/",
        statusCode: 200,
        fetchClass: "ok",
        extractionState: "STATIC_COMPLETE",
        failureReason: null,
        platform: null,
        platformConfidence: null,
        redirectUrl: null,
        title: "Home",
        metaDescription: null,
        wordCount: 500,
        isIndexable: true,
        crawlDepth: 0,
        inSitemap: true,
        internalLinkCount: 5,
        responseTimeMs: 250,
      },
    ]);

    vi.mocked(
      BacklinkSnapshotRepository.getLatestForProject,
    ).mockResolvedValueOnce({
      id: 1,
      projectId,
      domain: "example.com",
      backlinks: 3200,
      referringDomains: 450,
      brokenBacklinks: 0,
      newBacklinks: 10,
      lostBacklinks: 5,
      newReferringDomains: 2,
      lostReferringDomains: 1,
      rank: 42,
      capturedAt: "2026-11-01T00:00:00Z",
    });

    vi.mocked(
      KeywordResearchRepository.listSavedKeywordsByProject,
    ).mockResolvedValueOnce({
      rows: [
        {
          row: {
            id: "sk-1",
            projectId,
            keyword: "seo tools",
            locationCode: 2840,
            languageCode: "en",
            createdAt: "2026-10-01T00:00:00Z",
          },
          metric: {
            id: 1,
            projectId,
            keyword: "seo tools",
            locationCode: 2840,
            languageCode: "en",
            searchVolume: 5400,
            cpc: 2.5,
            keywordDifficulty: 45,
            competition: 0.5,
            intent: "informational",
            monthlySearches: null,
            fetchedAt: "2026-10-01T00:00:00Z",
          },
          tags: [],
        },
      ],
      totalCount: 1,
      tags: [],
    });

    const result = await collectProjectSeoEvidence({
      projectId,
      organizationId: orgId,
    });

    expect(result.projectId).toBe(projectId);
    expect(result.domain).toBe("example.com");
    expect(result.sourceAvailability).toHaveLength(6);

    const rtStatus = result.sourceAvailability.find(
      (s) => s.source === "rank_tracking",
    );
    expect(rtStatus?.status).toBe("available");
    expect(rtStatus?.recordCount).toBe(1);

    const gscStatus = result.sourceAvailability.find(
      (s) => s.source === "search_console",
    );
    expect(gscStatus?.status).toBe("available");

    const auditStatus = result.sourceAvailability.find(
      (s) => s.source === "site_audit",
    );
    expect(auditStatus?.status).toBe("available");

    expect(result.measuredOverview.rankTracking?.top10Count).toBe(1);
    expect(result.measuredOverview.rankTracking?.improvedCount).toBe(1);
    expect(result.measuredOverview.searchConsole?.totals?.clicks).toBe(1500);
    expect(result.measuredOverview.siteAudit?.warningIssuesCount).toBe(1);
    expect(result.measuredOverview.backlinks?.backlinks).toBe(3200);
    expect(result.measuredOverview.savedKeywordsCount).toBe(1);

    expect(result.observations.length).toBeGreaterThan(0);
    for (const obs of result.observations) {
      expect(obs.isMeasured).toBe(true);
    }
  });

  it("handles missing GSC and unconfigured rank tracking gracefully", async () => {
    vi.mocked(
      ProjectRepository.getProjectForOrganization,
    ).mockResolvedValueOnce({
      id: projectId,
      organizationId: orgId,
      domain: "empty.com",
      name: "Empty",
      createdAt: "2026-01-01",
      archivedAt: null,
      locationCode: 2840,
      languageCode: "en",
      indexnowKey: null,
    });

    vi.mocked(
      RankTrackingRepository.getConfigsForProject,
    ).mockResolvedValueOnce([]);
    vi.mocked(
      GscSearchPerformanceRepository.getStoredCoverageRange,
    ).mockResolvedValueOnce(null);
    vi.mocked(AuditRepository.getLatestAuditForProject).mockResolvedValueOnce(
      undefined,
    );
    vi.mocked(
      BacklinkSnapshotRepository.getLatestForProject,
    ).mockResolvedValueOnce(null);
    vi.mocked(
      KeywordResearchRepository.listSavedKeywordsByProject,
    ).mockResolvedValueOnce({
      rows: [],
      totalCount: 0,
      tags: [],
    });

    const result = await collectProjectSeoEvidence({
      projectId,
      organizationId: orgId,
    });

    expect(result.measuredOverview.rankTracking).toBeUndefined();
    expect(result.measuredOverview.searchConsole).toBeUndefined();
    expect(result.measuredOverview.siteAudit).toBeUndefined();
    expect(result.measuredOverview.backlinks).toBeUndefined();
    expect(result.measuredOverview.savedKeywordsCount).toBe(0);

    const gscStatus = result.sourceAvailability.find(
      (s) => s.source === "search_console",
    );
    expect(gscStatus?.status).toBe("unavailable");

    const rtStatus = result.sourceAvailability.find(
      (s) => s.source === "rank_tracking",
    );
    expect(rtStatus?.status).toBe("unavailable");

    expect(result.missingInformation).toContain(
      "Rank tracking is not configured for this project.",
    );
    expect(result.missingInformation).toContain(
      "Google Search Console is not connected.",
    );
  });
});
