import type { DetectedIssue } from "@/server/lib/audit/types";
import { findRedirectChainsAndLoops } from "@/server/lib/audit/issues/multipage-checks";
import {
  DEEP_PAGE_DEPTH,
  MIN_PAGES_FOR_STRUCTURE,
  isIndexablePage,
  isOkHtmlPage,
  isStartUrl,
  isUtilityUrl,
} from "./rules";
import type {
  BrokenLinkEdge,
  InboundStats,
  LinkingDetails,
  LinkingFinding,
  LinkingPage,
  NonIndexableTargetEdge,
} from "./types";

const MAX_LINKING_FINDINGS = 2_000;

export type InboundStatsMap = Map<string, InboundStats>;

export function statsFor(stats: InboundStatsMap, url: string): InboundStats {
  return (
    stats.get(url) ?? {
      targetUrl: url,
      inboundLinks: 0,
      inboundSources: 0,
      allInboundLinks: 0,
      allInboundSources: 0,
      distinctAnchors: 0,
      emptyAnchors: 0,
      sampleAnchor: null,
    }
  );
}

export function findOrphanCandidates(input: {
  pages: LinkingPage[];
  stats: InboundStatsMap;
  startUrl: string;
}): LinkingFinding[] {
  const redirectTargets = new Set(
    input.pages
      .map((page) => page.redirectUrl)
      .filter((url): url is string => url !== null),
  );

  return input.pages
    .filter(
      (page) =>
        isOkHtmlPage(page) &&
        !isStartUrl(page.url, input.startUrl) &&
        !redirectTargets.has(page.url) &&
        statsFor(input.stats, page.url).allInboundSources === 0,
    )
    .slice(0, MAX_LINKING_FINDINGS)
    .map((page) => ({
      issueType: "orphan-page" as const,
      pageId: page.id,
      pageUrl: page.url,
      targetUrl: null,
      details: {
        inboundLinks: 0,
        inboundSources: 0,
        inSitemap: page.inSitemap,
      },
    }));
}

export function findUnderlinkedCandidates(input: {
  pages: LinkingPage[];
  stats: InboundStatsMap;
  startUrl: string;
  crawlCompleted: boolean;
}): LinkingFinding[] {
  if (!input.crawlCompleted || input.pages.length < MIN_PAGES_FOR_STRUCTURE) {
    return [];
  }

  return input.pages
    .filter((page) => {
      if (!isIndexablePage(page) || !page.inSitemap) return false;
      if (isStartUrl(page.url, input.startUrl) || isUtilityUrl(page.url)) {
        return false;
      }
      if (page.crawlDepth === null || page.crawlDepth < 2) return false;
      return statsFor(input.stats, page.url).inboundSources <= 1;
    })
    .slice(0, MAX_LINKING_FINDINGS)
    .map((page) => {
      const stats = statsFor(input.stats, page.url);
      return {
        issueType: "underlinked-page" as const,
        pageId: page.id,
        pageUrl: page.url,
        targetUrl: null,
        details: {
          inboundLinks: stats.inboundLinks,
          inboundSources: stats.inboundSources,
          inSitemap: page.inSitemap,
          pageType: page.pageType,
          crawlDepth: page.crawlDepth,
        },
      };
    });
}

export function findDeepPages(pages: LinkingPage[]): LinkingFinding[] {
  return pages
    .filter(
      (page) => page.crawlDepth !== null && page.crawlDepth >= DEEP_PAGE_DEPTH,
    )
    .slice(0, MAX_LINKING_FINDINGS)
    .map((page) => ({
      issueType: "deep-page" as const,
      pageId: page.id,
      pageUrl: page.url,
      targetUrl: null,
      details: { crawlDepth: page.crawlDepth },
    }));
}

export function findAnchorDiversityIssues(input: {
  pages: LinkingPage[];
  stats: InboundStatsMap;
  crawlCompleted: boolean;
}): LinkingFinding[] {
  if (!input.crawlCompleted || input.pages.length < MIN_PAGES_FOR_STRUCTURE) {
    return [];
  }

  return input.pages
    .filter((page) => {
      if (!isIndexablePage(page) || isUtilityUrl(page.url)) return false;
      const stats = statsFor(input.stats, page.url);
      return stats.inboundLinks >= 3 && stats.distinctAnchors <= 1;
    })
    .slice(0, MAX_LINKING_FINDINGS)
    .map((page) => {
      const stats = statsFor(input.stats, page.url);
      return {
        issueType: "anchor-text-diversity" as const,
        pageId: page.id,
        pageUrl: page.url,
        targetUrl: null,
        details: {
          inboundLinks: stats.inboundLinks,
          distinctAnchors: stats.distinctAnchors,
          emptyAnchors: stats.emptyAnchors,
          sampleAnchor: stats.sampleAnchor,
        },
      };
    });
}

export function findBrokenLinkIssues(
  edges: BrokenLinkEdge[],
): LinkingFinding[] {
  return edges.slice(0, MAX_LINKING_FINDINGS).map((edge) => ({
    issueType: "broken-internal-link" as const,
    pageId: edge.sourcePageId,
    pageUrl: edge.sourceUrl,
    targetUrl: edge.targetUrl,
    dedupeKey: edge.targetUrl,
    details: {
      targetUrl: edge.targetUrl,
      targetStatus: edge.targetStatus,
    },
  }));
}

export function findNonIndexableTargetIssues(
  edges: NonIndexableTargetEdge[],
): LinkingFinding[] {
  return edges.slice(0, MAX_LINKING_FINDINGS).map((edge) => ({
    issueType: "link-to-noindex-page" as const,
    pageId: edge.sourcePageId,
    pageUrl: edge.sourceUrl,
    targetUrl: edge.targetUrl,
    dedupeKey: edge.targetUrl,
    details: {
      targetUrl: edge.targetUrl,
      reason: edge.reason,
      canonicalUrl: edge.canonicalUrl,
    },
  }));
}

function isStringArray(value: unknown): value is string[] {
  return (
    Array.isArray(value) && value.every((item) => typeof item === "string")
  );
}

function redirectDetails(
  details: Record<string, unknown> | undefined,
): LinkingDetails | undefined {
  if (!details) return undefined;
  const hops = isStringArray(details.hops) ? details.hops : undefined;
  const finalUrl =
    typeof details.finalUrl === "string" ? details.finalUrl : undefined;
  if (!hops && !finalUrl) return undefined;
  return {
    ...(hops ? { hops } : {}),
    ...(finalUrl ? { finalUrl } : {}),
  };
}

function findRedirectIssues(pages: LinkingPage[]): DetectedIssue[] {
  return findRedirectChainsAndLoops(pages);
}

export function buildLinkingFindings(input: {
  pages: LinkingPage[];
  stats: InboundStatsMap;
  brokenEdges: BrokenLinkEdge[];
  nonIndexableEdges: NonIndexableTargetEdge[];
  startUrl: string;
  crawlCompleted: boolean;
}): LinkingFinding[] {
  return [
    ...(input.crawlCompleted ? findOrphanCandidates(input) : []),
    ...findUnderlinkedCandidates(input),
    ...findDeepPages(input.pages),
    ...findAnchorDiversityIssues(input),
    ...findBrokenLinkIssues(input.brokenEdges),
    ...findNonIndexableTargetIssues(input.nonIndexableEdges),
    ...findRedirectIssues(input.pages).map((issue) => ({
      issueType: issue.issueType,
      pageId: issue.pageId,
      pageUrl: issue.pageUrl,
      targetUrl: null,
      details: redirectDetails(issue.details),
    })),
  ];
}
