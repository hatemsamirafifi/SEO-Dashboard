import type { InternalLinkingReport } from "@/server/lib/audit/linking/types";

const AUDIT_ID = "e2e-audit";
const ORPHAN_URL = "https://example.com/products/orphan-widget";
const SOURCE_URL = "https://example.com/blog/widget-guide";

const COMPLETE_REPORT: InternalLinkingReport = {
  auditId: AUDIT_ID,
  coverage: {
    status: "complete",
    reason: null,
    crawlCompleted: true,
    pagesAnalyzed: 42,
  },
  summary: {
    internalLinks: 128,
    orphanCandidates: 1,
    underlinkedPages: 1,
    deepPages: 1,
    brokenLinks: 1,
    redirectIssues: 0,
    nonIndexableTargets: 1,
    anchorDiversityIssues: 1,
  },
  targets: [
    {
      issueType: "orphan-page",
      severity: "warning",
      pageId: "e2e-page-orphan",
      pageUrl: ORPHAN_URL,
      targetUrl: null,
      title: "Orphan widget",
      h1Text: "Orphan widget",
      pageType: "product",
      crawlDepth: 3,
      inSitemap: true,
      inboundLinks: 0,
      inboundSources: 0,
      distinctAnchors: 0,
      emptyAnchors: 0,
      sampleAnchor: null,
      details: { inboundLinks: 0, inboundSources: 0, inSitemap: true },
      suggestions: [
        {
          sourceUrl: SOURCE_URL,
          sourceTitle: "Widget buying guide",
          sourceH1: "How to choose a widget",
          sourcePageType: "blog",
          score: 10,
          sharedTerms: ["widget"],
          reason: "Shares observed terms: widget",
        },
      ],
      evidence: [],
    },
    {
      issueType: "link-to-noindex-page",
      severity: "warning",
      pageId: "e2e-page-source",
      pageUrl: SOURCE_URL,
      targetUrl: "https://example.com/account/orders",
      title: "Widget buying guide",
      h1Text: "How to choose a widget",
      pageType: "blog",
      crawlDepth: 2,
      inSitemap: true,
      inboundLinks: 2,
      inboundSources: 2,
      distinctAnchors: 2,
      emptyAnchors: 0,
      sampleAnchor: "Widget guide",
      details: {
        targetUrl: "https://example.com/account/orders",
        reason: "noindex",
        canonicalUrl: null,
      },
      suggestions: [],
      evidence: [],
    },
  ],
  targetsTruncated: false,
};

const PARTIAL_REPORT: InternalLinkingReport = {
  ...COMPLETE_REPORT,
  auditId: "e2e-audit-partial",
  coverage: {
    status: "partial",
    reason:
      "Audit status is completed_partial; absence-based link findings are suppressed.",
    crawlCompleted: false,
    pagesAnalyzed: 18,
  },
  summary: {
    ...COMPLETE_REPORT.summary,
    orphanCandidates: 0,
    underlinkedPages: 0,
    anchorDiversityIssues: 0,
  },
  targets: COMPLETE_REPORT.targets.filter(
    (target) => target.issueType === "link-to-noindex-page",
  ),
};

export function getInternalLinkingFixture(
  auditId: string,
): InternalLinkingReport | null {
  if (auditId === AUDIT_ID) return COMPLETE_REPORT;
  if (auditId === "e2e-audit-partial") return PARTIAL_REPORT;
  return null;
}
