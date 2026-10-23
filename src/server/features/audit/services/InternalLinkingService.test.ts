import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeLinkingPage } from "@/server/lib/audit/linking/test-fixtures";

const mocks = vi.hoisted(() => ({
  getAuditForProject: vi.fn(),
  getLinkingPages: vi.fn(),
  getInboundStats: vi.fn(),
  getBrokenLinkEdges: vi.fn(),
  getNonIndexableTargetEdges: vi.fn(),
  getInboundEdgesForTargets: vi.fn(),
}));

vi.mock("../repositories/AuditRepository", () => ({
  AuditRepository: {
    getAuditForProject: mocks.getAuditForProject,
  },
}));

vi.mock("../repositories/linkingQueries", () => ({
  getLinkingPages: mocks.getLinkingPages,
  getInboundStats: mocks.getInboundStats,
  getBrokenLinkEdges: mocks.getBrokenLinkEdges,
  getNonIndexableTargetEdges: mocks.getNonIndexableTargetEdges,
  getInboundEdgesForTargets: mocks.getInboundEdgesForTargets,
}));

import { InternalLinkingService } from "./InternalLinkingService";

const ORPHAN = "https://example.com/orphan";
const SOURCE = "https://example.com/guide";

function pages() {
  return [
    makeLinkingPage({
      id: "orphan",
      url: ORPHAN,
      title: "Orphan widget",
      inSitemap: false,
    }),
    makeLinkingPage({
      id: "source",
      url: SOURCE,
      title: "Widget guide",
      crawlDepth: 1,
    }),
  ];
}

function seedQueries() {
  mocks.getLinkingPages.mockResolvedValue(pages());
  mocks.getInboundStats.mockResolvedValue([
    {
      targetUrl: SOURCE,
      inboundLinks: 1,
      inboundSources: 1,
      allInboundLinks: 1,
      allInboundSources: 1,
      distinctAnchors: 1,
      emptyAnchors: 0,
      sampleAnchor: "Guide",
    },
  ]);
  mocks.getBrokenLinkEdges.mockResolvedValue([
    {
      sourcePageId: "source",
      sourceUrl: SOURCE,
      targetUrl: "https://example.com/missing",
      targetStatus: 404,
    },
  ]);
  mocks.getNonIndexableTargetEdges.mockResolvedValue([
    {
      sourcePageId: "source",
      sourceUrl: SOURCE,
      targetUrl: "https://example.com/account",
      reason: "noindex",
      canonicalUrl: null,
    },
  ]);
  mocks.getInboundEdgesForTargets.mockResolvedValue([]);
}

describe("InternalLinkingService.getReport", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("rejects an audit outside the project", async () => {
    mocks.getAuditForProject.mockResolvedValue(null);

    await expect(
      InternalLinkingService.getReport({
        auditId: "audit-1",
        projectId: "other-project",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("builds a complete report for a completed audit", async () => {
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit-1",
      startUrl: "https://example.com/",
      status: "completed",
    });
    seedQueries();

    const report = await InternalLinkingService.getReport({
      auditId: "audit-1",
      projectId: "project-1",
    });

    expect(report.coverage).toMatchObject({
      status: "complete",
      crawlCompleted: true,
      pagesAnalyzed: 2,
    });
    expect(report.summary).toMatchObject({
      orphanCandidates: 1,
      brokenLinks: 1,
      nonIndexableTargets: 1,
    });
    expect(report.targets.map((target) => target.issueType)).toEqual(
      expect.arrayContaining([
        "orphan-page",
        "broken-internal-link",
        "link-to-noindex-page",
      ]),
    );
    expect(mocks.getInboundEdgesForTargets).toHaveBeenCalledWith("audit-1", [
      ORPHAN,
    ]);
  });

  it("suppresses absence-based findings on a partial crawl", async () => {
    mocks.getAuditForProject.mockResolvedValue({
      id: "audit-1",
      startUrl: "https://example.com/",
      status: "completed_partial",
    });
    seedQueries();

    const report = await InternalLinkingService.getReport({
      auditId: "audit-1",
      projectId: "project-1",
    });

    expect(report.coverage.status).toBe("partial");
    expect(report.targets.map((target) => target.issueType)).toEqual([
      "broken-internal-link",
      "link-to-noindex-page",
    ]);
    expect(mocks.getInboundEdgesForTargets).toHaveBeenCalledWith("audit-1", []);
  });
});
