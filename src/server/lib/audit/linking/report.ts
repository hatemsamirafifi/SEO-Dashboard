import {
  AUDIT_ISSUE_TYPES,
  ISSUE_SEVERITY_ORDER,
  type AuditIssueType,
  type IssueSeverity,
} from "@/shared/audit-issues";
import { statsFor, type InboundStatsMap } from "./analyze";
import { suggestSources } from "./suggestions";
import type {
  InboundEdge,
  InternalLinkingReport,
  LinkingEvidence,
  LinkingFinding,
  LinkingPage,
  LinkingSuggestion,
  LinkingSummary,
  LinkingTarget,
} from "./types";

const MAX_REPORT_TARGETS = 200;
const MAX_EVIDENCE_PER_TARGET = 5;

function severityOf(issueType: AuditIssueType): IssueSeverity {
  return AUDIT_ISSUE_TYPES[issueType].severity;
}

function summaryOf(findings: LinkingFinding[], stats: InboundStatsMap) {
  const summary: LinkingSummary = {
    internalLinks: 0,
    orphanCandidates: 0,
    underlinkedPages: 0,
    deepPages: 0,
    brokenLinks: 0,
    redirectIssues: 0,
    nonIndexableTargets: 0,
    anchorDiversityIssues: 0,
  };

  for (const stat of stats.values()) {
    summary.internalLinks += stat.allInboundLinks;
  }
  for (const finding of findings) {
    switch (finding.issueType) {
      case "orphan-page":
        summary.orphanCandidates += 1;
        break;
      case "underlinked-page":
        summary.underlinkedPages += 1;
        break;
      case "deep-page":
        summary.deepPages += 1;
        break;
      case "broken-internal-link":
        summary.brokenLinks += 1;
        break;
      case "redirect-chain":
      case "redirect-loop":
        summary.redirectIssues += 1;
        break;
      case "link-to-noindex-page":
        summary.nonIndexableTargets += 1;
        break;
      case "anchor-text-diversity":
        summary.anchorDiversityIssues += 1;
        break;
    }
  }
  return summary;
}

function groupEdges(edges: InboundEdge[]) {
  const byTarget = new Map<string, InboundEdge[]>();
  for (const edge of edges) {
    const group = byTarget.get(edge.targetUrl);
    if (group) group.push(edge);
    else byTarget.set(edge.targetUrl, [edge]);
  }
  return byTarget;
}

function evidenceFor(edges: InboundEdge[] | undefined): LinkingEvidence[] {
  return (edges ?? [])
    .slice(0, MAX_EVIDENCE_PER_TARGET)
    .map((edge) => ({ sourceUrl: edge.sourceUrl, anchor: edge.anchor }));
}

function suggestionsFor(input: {
  finding: LinkingFinding;
  page: LinkingPage | undefined;
  pages: LinkingPage[];
  edges: InboundEdge[] | undefined;
}): LinkingSuggestion[] {
  if (
    input.finding.issueType !== "orphan-page" &&
    input.finding.issueType !== "underlinked-page"
  ) {
    return [];
  }
  if (!input.page) return [];
  const existingSourceUrls = new Set(
    (input.edges ?? []).map((edge) => edge.sourceUrl),
  );
  return suggestSources({
    target: input.page,
    pages: input.pages,
    existingSourceUrls,
  });
}

function toTarget(input: {
  finding: LinkingFinding;
  page: LinkingPage | undefined;
  pages: LinkingPage[];
  stats: InboundStatsMap;
  edges: InboundEdge[] | undefined;
}): LinkingTarget {
  const { finding, page, stats, edges } = input;
  const pageStats = page ? statsFor(stats, page.url) : null;
  const pageLevel =
    finding.issueType === "orphan-page" ||
    finding.issueType === "underlinked-page" ||
    finding.issueType === "deep-page" ||
    finding.issueType === "anchor-text-diversity";

  return {
    issueType: finding.issueType,
    severity: severityOf(finding.issueType),
    pageId: finding.pageId,
    pageUrl: finding.pageUrl,
    targetUrl: finding.targetUrl,
    title: page?.title ?? null,
    h1Text: page?.h1Text ?? null,
    pageType: page?.pageType ?? null,
    crawlDepth: page?.crawlDepth ?? null,
    inSitemap: page?.inSitemap ?? false,
    inboundLinks: pageLevel ? (pageStats?.inboundLinks ?? 0) : 0,
    inboundSources: pageLevel ? (pageStats?.inboundSources ?? 0) : 0,
    distinctAnchors: pageLevel ? (pageStats?.distinctAnchors ?? 0) : 0,
    emptyAnchors: pageLevel ? (pageStats?.emptyAnchors ?? 0) : 0,
    sampleAnchor: pageLevel ? (pageStats?.sampleAnchor ?? null) : null,
    details: finding.details ?? null,
    suggestions: suggestionsFor({
      finding,
      page,
      pages: input.pages,
      edges,
    }),
    evidence: pageLevel ? evidenceFor(edges) : [],
  };
}

export function buildInternalLinkingReport(input: {
  auditId: string;
  auditStatus: string;
  pages: LinkingPage[];
  stats: InboundStatsMap;
  findings: LinkingFinding[];
  inboundEdges: InboundEdge[];
}): InternalLinkingReport {
  const pagesByUrl = new Map(input.pages.map((page) => [page.url, page]));
  const edgesByTarget = groupEdges(input.inboundEdges);
  const crawlCompleted = input.auditStatus === "completed";

  const targets = input.findings
    .map((finding) =>
      toTarget({
        finding,
        page: pagesByUrl.get(finding.pageUrl),
        pages: input.pages,
        stats: input.stats,
        edges: edgesByTarget.get(finding.pageUrl),
      }),
    )
    .toSorted(
      (a, b) =>
        ISSUE_SEVERITY_ORDER[a.severity] - ISSUE_SEVERITY_ORDER[b.severity] ||
        a.issueType.localeCompare(b.issueType) ||
        a.pageUrl.localeCompare(b.pageUrl) ||
        (a.targetUrl ?? "").localeCompare(b.targetUrl ?? ""),
    );

  return {
    auditId: input.auditId,
    coverage: {
      status: crawlCompleted ? "complete" : "partial",
      reason: crawlCompleted
        ? null
        : `Audit status is ${input.auditStatus}; absence-based link findings are suppressed.`,
      crawlCompleted,
      pagesAnalyzed: input.pages.length,
    },
    summary: summaryOf(input.findings, input.stats),
    targets: targets.slice(0, MAX_REPORT_TARGETS),
    targetsTruncated: targets.length > MAX_REPORT_TARGETS,
  };
}
