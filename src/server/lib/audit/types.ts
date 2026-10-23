/**
 * Shared types for the site audit system.
 */

import { z } from "zod";
import {
  type PageFetchClass,
  type PageFailureReason,
} from "@/shared/audit-fetch-class";
import type { AuditIssueType } from "@/shared/audit-issues";
import { MIN_AUDIT_PAGES, PAID_MAX_AUDIT_PAGES } from "@/shared/audit-limits";
import { jsonCodec } from "@/shared/json";
import type { PlatformName } from "@/server/lib/audit/platform-detection";
import type { PageTypeName } from "@/server/lib/audit/salla/page-type-evidence";

export type { PageFetchClass, PageFailureReason, PageTypeName };

export type LighthouseStrategy = "auto" | "none";

export interface AuditConfig {
  maxPages: number;
  lighthouseStrategy: LighthouseStrategy;
}

// Read-side only (writes stringify a typed AuditConfig). Stored rows may hold
// retired strategies ("all", "manual") from older audits; map them onto the
// closest surviving strategy — and fall back to "auto" on anything unknown —
// instead of failing the whole config parse and making the audit's results
// unviewable.
const lighthouseStrategySchema = z
  .enum(["auto", "all", "manual", "none"])
  .transform(
    (value): LighthouseStrategy =>
      value === "all" ? "auto" : value === "manual" ? "none" : value,
  )
  .catch("auto");

const auditConfigSchema = z.object({
  maxPages: z.number().int().min(MIN_AUDIT_PAGES).max(PAID_MAX_AUDIT_PAGES),
  lighthouseStrategy: lighthouseStrategySchema,
});

const auditConfigCodec = jsonCodec(auditConfigSchema);

export function parseAuditConfig(configRaw: string | null): AuditConfig | null {
  if (!configRaw) return null;
  const result = auditConfigCodec.safeParse(configRaw);
  return result.success ? result.data : null;
}

/**
 * How completely the page was extracted (see the shared taxonomy module).
 * Persisted as audit_pages.extraction_state.
 */
export type ExtractionState =
  | "STATIC_COMPLETE"
  | "STATIC_PARTIAL"
  | "RENDERING_REQUIRED"
  | "ACCESS_BLOCKED"
  | "EXTRACTION_FAILED"
  | "NOT_EXTRACTED";

/** One outgoing link edge, deduped by target URL within a page. */
export interface PageLink {
  targetUrl: string;
  anchor: string | null;
  isInternal: boolean;
  isNofollow: boolean;
}

/** An issue detected by the per-page or multipage reporters. */
export interface DetectedIssue {
  issueType: AuditIssueType;
  pageId: string | null;
  pageUrl: string;
  details?: Record<string, unknown>;
  /**
   * Distinguishes multiple issues of the same type on the same page
   * (e.g. one broken-internal-link issue per target). Part of the
   * deterministic row id, so step retries don't duplicate issues.
   */
  dedupeKey?: string;
}

/** Data extracted from a single page via cheerio. */
export interface PageAnalysis {
  url: string;
  statusCode: number;
  redirectUrl: string | null;
  responseTimeMs: number;

  // Head metadata
  title: string;
  metaDescription: string;
  canonical: string | null;
  robotsMeta: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  ogType: string | null;

  // Headings
  h1s: string[];
  headingOrder: number[];

  // Content
  wordCount: number;
  bodyText: string;

  // Images
  images: Array<{ src: string | null; alt: string | null }>;

  // Links (normalized, deduped by target)
  links: PageLink[];

  // Structured data
  hasStructuredData: boolean;
  /** Parsed JSON-LD blocks (multi-block merged via @graph), capped. */
  structuredDataJson: string | null;

  // Salla adapter extraction (capped JSON, evidence-tier-labeled; null when
  // the page did not classify as product/category/blog)
  sallaExtractionJson: string | null;

  // Hreflang
  hreflangTags: string[];

  // Page-type classification (null when evidence was absent/URL-only)
  pageType: PageTypeName | null;
  pageTypeConfidence: number | null;
}

/** Lighthouse result for a single URL+strategy. */
export interface LighthouseResult {
  url: string;
  pageId: string;
  strategy: "mobile" | "desktop";
  performanceScore: number | null;
  accessibilityScore: number | null;
  bestPracticesScore: number | null;
  seoScore: number | null;
  lcpMs: number | null;
  cls: number | null;
  inpMs: number | null;
  ttfbMs: number | null;
  errorMessage?: string | null;
  r2Key?: string | null;
  payloadSizeBytes?: number | null;
}

/**
 * Full result of crawling one page. Persisted to D1 inside the crawl-batch
 * step; never accumulated in memory or returned as durable step state.
 */
export interface CrawledPageResult {
  id: string;
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  /**
   * How completely the page was extracted. Complements fetchClass so a
   * crawl-error page can be told apart from a blocked page, and so
   * incomplete extraction never produces confirmed SEO findings.
   */
  extractionState: ExtractionState;
  /** Transport-level failure diagnostics; null when the fetch responded. */
  failureReason: PageFailureReason | null;
  /** `Retry-After` header value from a 429 response, before normalization. */
  retryAfter: string | null;
  redirectUrl: string | null;
  title: string;
  metaDescription: string;
  canonicalUrl: string | null;
  robotsMeta: string | null;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  ogTitle: string | null;
  ogDescription: string | null;
  ogImage: string | null;
  h1Count: number;
  /** First observed non-empty H1 text, capped; null when absent/not HTML. */
  h1Text: string | null;
  h2Count: number;
  h3Count: number;
  h4Count: number;
  h5Count: number;
  h6Count: number;
  headingOrder: number[];
  wordCount: number;
  contentHash: string | null;
  /**
   * Bytes of the response body actually read for analysis. Feeds the crawl
   * window's in-flight memory budget.
   */
  htmlBytes: number;
  /**
   * True when an HTML document was fetched and analyzed. Gates the content
   * checks in page reporters (an empty-shell HTML page must still be
   * checked; a PDF must not). Transient — not persisted.
   */
  isHtml: boolean;
  imagesTotal: number;
  imagesMissingAlt: number;
  images: Array<{ src: string | null; alt: string | null }>;
  links: PageLink[];
  hasStructuredData: boolean;
  /** Parsed JSON-LD payload, capped; null when absent or unparseable. */
  structuredDataJson: string | null;
  /** Salla adapter extraction (capped JSON); null on unclassified pages. */
  sallaExtractionJson: string | null;
  hreflangTags: string[];
  isIndexable: boolean;
  responseTimeMs: number;
  /**
   * Evidence-backed e-commerce platform detected on the page (or null when
   * the evidence did not reach the confidence threshold, or when the page
   * was never analyzed).
   */
  platform: PlatformName | null;
  /** 0..1 confidence backing the platform field; 0 when null. */
  platformConfidence: number;
  /** Evidence-scored page type; null when unclassifiable (no/URL-only evidence). */
  pageType: PageTypeName | null;
  /** 0..1 confidence backing the pageType field; null when pageType is null. */
  pageTypeConfidence: number | null;
  /** null = not reached via links (e.g. sitemap-seeded). */
  crawlDepth: number | null;
  inSitemap: boolean;
}

/**
 * Slim per-page summary returned as durable step state from a crawl batch.
 * Keep this small: full page data lives in D1, not in Workflow step state.
 */
export interface StepPageSummary {
  id: string;
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  redirectUrl: string | null;
  title: string;
  /** Normalized same-origin link targets, for frontier expansion. */
  internalLinks: string[];
}
