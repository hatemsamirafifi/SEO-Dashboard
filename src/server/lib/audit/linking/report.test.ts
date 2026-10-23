import { describe, expect, it } from "vitest";
import type { LinkingFinding } from "./types";
import { buildInternalLinkingReport } from "./report";
import { emptyStats, makeLinkingPage } from "./test-fixtures";

function reportInput(overrides: {
  auditStatus?: string;
  findings?: LinkingFinding[];
  stats?: Array<[string, Partial<ReturnType<typeof emptyStats>>]>;
  edges?: Array<{
    targetUrl: string;
    sourcePageId: string;
    sourceUrl: string;
    anchor: string | null;
  }>;
}) {
  const pages = [
    makeLinkingPage({
      id: "orphan",
      url: "https://example.com/orphan",
      title: "Orphan widget",
      h1Text: "Orphan widget",
      crawlDepth: 3,
    }),
    makeLinkingPage({
      id: "source",
      url: "https://example.com/widget-guide",
      title: "Widget buying guide",
      h1Text: "How to choose a widget",
    }),
    makeLinkingPage({
      id: "deep",
      url: "https://example.com/deep",
      crawlDepth: 6,
    }),
  ];

  return {
    auditId: "audit-1",
    auditStatus: overrides.auditStatus ?? "completed",
    pages,
    stats: new Map(
      (overrides.stats ?? []).map(([url, value]) => [
        url,
        { ...emptyStats(url), ...value },
      ]),
    ),
    findings: overrides.findings ?? [],
    inboundEdges: overrides.edges ?? [],
  };
}

describe("buildInternalLinkingReport", () => {
  it("reports complete coverage and summarizes findings", () => {
    const report = buildInternalLinkingReport(
      reportInput({
        findings: [
          {
            issueType: "orphan-page",
            pageId: "orphan",
            pageUrl: "https://example.com/orphan",
            targetUrl: null,
          },
          {
            issueType: "underlinked-page",
            pageId: "orphan",
            pageUrl: "https://example.com/orphan",
            targetUrl: null,
          },
          {
            issueType: "broken-internal-link",
            pageId: "source",
            pageUrl: "https://example.com/widget-guide",
            targetUrl: "https://example.com/missing",
          },
        ],
        stats: [
          ["https://example.com/orphan", { allInboundLinks: 4 }],
          ["https://example.com/widget-guide", { allInboundLinks: 6 }],
        ],
      }),
    );

    expect(report.coverage).toMatchObject({
      status: "complete",
      crawlCompleted: true,
      pagesAnalyzed: 3,
    });
    expect(report.summary).toMatchObject({
      internalLinks: 10,
      orphanCandidates: 1,
      underlinkedPages: 1,
      brokenLinks: 1,
    });
    expect(report.targets).toHaveLength(3);
  });

  it("suppresses absence-based coverage on a partial crawl", () => {
    const report = buildInternalLinkingReport(
      reportInput({ auditStatus: "completed_partial" }),
    );

    expect(report.coverage).toMatchObject({
      status: "partial",
      crawlCompleted: false,
    });
    expect(report.coverage.reason).toContain("completed_partial");
  });

  it("sorts by severity and then by stable keys", () => {
    const report = buildInternalLinkingReport(
      reportInput({
        findings: [
          {
            issueType: "deep-page",
            pageId: "deep",
            pageUrl: "https://example.com/deep",
            targetUrl: null,
          },
          {
            issueType: "link-to-noindex-page",
            pageId: "source",
            pageUrl: "https://example.com/widget-guide",
            targetUrl: "https://example.com/account",
          },
          {
            issueType: "broken-internal-link",
            pageId: "source",
            pageUrl: "https://example.com/widget-guide",
            targetUrl: "https://example.com/missing",
          },
        ],
      }),
    );

    expect(report.targets.map((target) => target.issueType)).toEqual([
      "broken-internal-link",
      "link-to-noindex-page",
      "deep-page",
    ]);
  });

  it("builds suggestions for orphan targets from shared observed terms", () => {
    const report = buildInternalLinkingReport(
      reportInput({
        findings: [
          {
            issueType: "orphan-page",
            pageId: "orphan",
            pageUrl: "https://example.com/orphan",
            targetUrl: null,
          },
        ],
      }),
    );

    const target = report.targets[0];
    expect(target.suggestions).toHaveLength(1);
    expect(target.suggestions[0]).toMatchObject({
      sourceUrl: "https://example.com/widget-guide",
      sourceTitle: "Widget buying guide",
      sharedTerms: ["widget"],
    });
    expect(target.evidence).toEqual([]);
  });

  it("caps evidence per target", () => {
    const report = buildInternalLinkingReport(
      reportInput({
        findings: [
          {
            issueType: "anchor-text-diversity",
            pageId: "orphan",
            pageUrl: "https://example.com/orphan",
            targetUrl: null,
          },
        ],
        stats: [
          [
            "https://example.com/orphan",
            { inboundLinks: 8, distinctAnchors: 1 },
          ],
        ],
        edges: Array.from({ length: 8 }, (_, index) => ({
          targetUrl: "https://example.com/orphan",
          sourcePageId: `source-${index}`,
          sourceUrl: `https://example.com/source-${index}`,
          anchor: "Widget",
        })),
      }),
    );

    expect(report.targets[0].evidence).toHaveLength(5);
  });

  it("truncates targets to the report cap", () => {
    const findings = Array.from({ length: 201 }, (_, index) => ({
      issueType: "deep-page" as const,
      pageId: `page-${index}`,
      pageUrl: `https://example.com/deep-${index}`,
      targetUrl: null,
    }));
    const report = buildInternalLinkingReport(
      reportInput({
        findings,
        stats: [],
      }),
    );

    expect(report.targets).toHaveLength(200);
    expect(report.targetsTruncated).toBe(true);
  });
});
