import type { AuditIssueType, IssueSeverity } from "@/shared/audit-issues";
import type { SlimPage } from "@/server/lib/audit/issues/multipage-checks";

export type LinkingPage = SlimPage;

export interface InboundStats {
  targetUrl: string;
  /** Internal, followed, non-self links into the target. */
  inboundLinks: number;
  inboundSources: number;
  /** Internal, followed, non-self links regardless of nofollow. */
  allInboundLinks: number;
  allInboundSources: number;
  distinctAnchors: number;
  emptyAnchors: number;
  sampleAnchor: string | null;
}

export interface InboundEdge {
  targetUrl: string;
  sourcePageId: string;
  sourceUrl: string;
  anchor: string | null;
}

export interface BrokenLinkEdge {
  sourcePageId: string;
  sourceUrl: string;
  targetUrl: string;
  targetStatus: number | null;
}

export interface NonIndexableTargetEdge {
  sourcePageId: string;
  sourceUrl: string;
  targetUrl: string;
  reason: "noindex" | "canonicalized";
  canonicalUrl: string | null;
}

export interface LinkingDetails {
  [key: string]: string | number | boolean | string[] | null | undefined;
  targetUrl?: string;
  targetStatus?: number | null;
  reason?: string;
  canonicalUrl?: string | null;
  inboundLinks?: number;
  inboundSources?: number;
  inSitemap?: boolean;
  pageType?: string | null;
  crawlDepth?: number | null;
  distinctAnchors?: number;
  emptyAnchors?: number;
  sampleAnchor?: string | null;
  hops?: string[];
  finalUrl?: string;
}

export interface LinkingFinding {
  issueType: AuditIssueType;
  pageId: string | null;
  pageUrl: string;
  targetUrl: string | null;
  dedupeKey?: string;
  details?: LinkingDetails;
}

export interface LinkingSuggestion {
  sourceUrl: string;
  sourceTitle: string | null;
  sourceH1: string | null;
  sourcePageType: string | null;
  score: number;
  sharedTerms: string[];
  reason: string;
}

export interface LinkingEvidence {
  sourceUrl: string;
  anchor: string | null;
}

export interface LinkingTarget {
  issueType: AuditIssueType;
  severity: IssueSeverity;
  pageId: string | null;
  pageUrl: string;
  targetUrl: string | null;
  title: string | null;
  h1Text: string | null;
  pageType: string | null;
  crawlDepth: number | null;
  inSitemap: boolean;
  inboundLinks: number;
  inboundSources: number;
  distinctAnchors: number;
  emptyAnchors: number;
  sampleAnchor: string | null;
  details: LinkingDetails | null;
  suggestions: LinkingSuggestion[];
  evidence: LinkingEvidence[];
}

export interface LinkingSummary {
  internalLinks: number;
  orphanCandidates: number;
  underlinkedPages: number;
  deepPages: number;
  brokenLinks: number;
  redirectIssues: number;
  nonIndexableTargets: number;
  anchorDiversityIssues: number;
}

export interface LinkingCoverage {
  status: "complete" | "partial";
  reason: string | null;
  crawlCompleted: boolean;
  pagesAnalyzed: number;
}

export interface InternalLinkingReport {
  auditId: string;
  coverage: LinkingCoverage;
  summary: LinkingSummary;
  targets: LinkingTarget[];
  targetsTruncated: boolean;
}
