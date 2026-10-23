/**
 * Per-page issue reporters.
 *
 * Each reporter is a pure function over a single crawled page record —
 * DOM-free by design (cheerio runs once in crawlPage), so the engine works
 * over any crawl source that can produce a CrawledPageResult.
 *
 * Cross-page checks (duplicates, broken links, orphans, redirect chains)
 * live in multipage.ts and run over D1 after the crawl.
 */
import type {
  CrawledPageResult,
  DetectedIssue,
} from "@/server/lib/audit/types";
import type { AuditIssueType } from "@/shared/audit-issues";
import { validateProductSchema } from "@/server/lib/audit/salla/schema-validation";
import { detectSchemaGap } from "@/server/lib/schema/gap-detector";

const TITLE_MAX_CHARS = 60;
const TITLE_MIN_CHARS = 10;
const META_DESCRIPTION_MAX_CHARS = 160;
const META_DESCRIPTION_MIN_CHARS = 70;
const THIN_CONTENT_WORDS = 150;
const SLOW_RESPONSE_MS = 1500;
const DEEP_PAGE_DEPTH = 5;

function hasHeadingLevelSkip(headingOrder: number[]): boolean {
  for (let i = 1; i < headingOrder.length; i++) {
    if (headingOrder[i] > headingOrder[i - 1] + 1) return true;
  }
  return false;
}

export function runPageReporters(page: CrawledPageResult): DetectedIssue[] {
  const issues: DetectedIssue[] = [];
  const report = (
    issueType: AuditIssueType,
    details?: Record<string, unknown>,
  ) => issues.push({ issueType, pageId: page.id, pageUrl: page.url, details });

  if (page.fetchClass === "blocked") {
    report("blocked-page", { statusCode: page.statusCode });
    return issues;
  }
  if (page.fetchClass === "rate_limited") {
    report("rate-limited-page", {
      statusCode: page.statusCode,
      retryAfter: page.retryAfter,
    });
    return issues;
  }
  if (page.fetchClass === "error") {
    report("crawl-error", { failureReason: page.failureReason });
    return issues;
  }

  if (page.statusCode >= 500) {
    report("server-error", { statusCode: page.statusCode });
    return issues;
  }
  if (page.statusCode >= 400) {
    report("broken-page", { statusCode: page.statusCode });
    return issues;
  }
  // Redirects are normal on their own; chains/loops are flagged in multipage.
  if (page.statusCode >= 300) {
    return issues;
  }

  // The audit must never turn an unknown-content page into confirmed SEO
  // verdicts. On redirect/non-HTML/parse-failed rows there is nothing to
  // judge; on STATIC_PARTIAL and RENDERING_REQUIRED rows only checks whose
  // evidence the static pass reliably carries survive the gate below.
  if (
    page.extractionState === "ACCESS_BLOCKED" ||
    page.extractionState === "EXTRACTION_FAILED" ||
    page.extractionState === "NOT_EXTRACTED"
  ) {
    return issues;
  }
  const extractionUncertain =
    page.extractionState === "STATIC_PARTIAL" ||
    page.extractionState === "RENDERING_REQUIRED";

  if (page.responseTimeMs > SLOW_RESPONSE_MS) {
    report("slow-response", { responseTimeMs: page.responseTimeMs });
  }

  // Content checks only make sense for analyzed HTML documents (a PDF has no
  // title tag to miss; an empty-shell HTML page very much does).
  if (!page.isHtml) {
    return issues;
  }

  // Titles (derived from <head>, which static extraction reads in full)
  if (!page.title) {
    report("missing-title");
  } else if (page.title.length > TITLE_MAX_CHARS) {
    report("title-too-long", { length: page.title.length });
  } else if (page.title.length < TITLE_MIN_CHARS) {
    report("title-too-short", { length: page.title.length });
  }

  // Meta description (derived from <head> as above)
  if (!page.metaDescription) {
    report("missing-meta-description");
  } else if (page.metaDescription.length > META_DESCRIPTION_MAX_CHARS) {
    report("meta-description-too-long", {
      length: page.metaDescription.length,
    });
  } else if (page.metaDescription.length < META_DESCRIPTION_MIN_CHARS) {
    report("meta-description-too-short", {
      length: page.metaDescription.length,
    });
  }

  // Headings; a "missing" heading is not a confirmed verdict when extraction
  // is uncertain, but a found heading always is.
  if (page.h1Count > 1) {
    report("multiple-h1", { h1Count: page.h1Count });
  }
  if (extractionUncertain) {
    // Uncertain extraction keeps only verdicts that do not depend on
    // potentially missing content.
    return issues;
  }
  if (page.h1Count === 0) {
    report("missing-h1");
  }
  if (hasHeadingLevelSkip(page.headingOrder)) {
    report("heading-order-skip");
  }

  // Indexability + canonical signals
  if (!page.isIndexable) {
    report("noindex-page", {
      robotsMeta: page.robotsMeta,
      xRobotsTag: page.xRobotsTag,
    });
  }
  if (
    page.canonicalUrl &&
    page.headerCanonicalUrl &&
    page.canonicalUrl !== page.headerCanonicalUrl
  ) {
    report("canonical-conflict", {
      htmlCanonical: page.canonicalUrl,
      headerCanonical: page.headerCanonicalUrl,
    });
  }
  const effectiveCanonical = page.canonicalUrl ?? page.headerCanonicalUrl;
  if (effectiveCanonical && effectiveCanonical !== page.url) {
    const crossDomainCanonical = reportCrossDomainCanonical(
      effectiveCanonical,
      page.url,
      page.pageType,
    );
    if (crossDomainCanonical) {
      report("canonical-cross-domain", crossDomainCanonical);
    } else {
      report("canonicalized-page", { canonicalUrl: effectiveCanonical });
    }
  }

  // Content quality
  if (page.isIndexable && page.wordCount < THIN_CONTENT_WORDS) {
    report("thin-content", { wordCount: page.wordCount });
  }
  if (page.imagesMissingAlt > 0) {
    report("images-missing-alt", {
      imagesMissingAlt: page.imagesMissingAlt,
      imagesTotal: page.imagesTotal,
    });
  }

  // Structure
  if (page.isIndexable && page.links.length === 0) {
    report("no-outgoing-links");
  }
  if (page.crawlDepth !== null && page.crawlDepth >= DEEP_PAGE_DEPTH) {
    report("deep-page", { crawlDepth: page.crawlDepth });
  }

  // Salla adapter: validated product markup on completed extractions (the
  // early returns above already exclude every other state).
  if (page.pageType === "product") {
    issues.push(...validateProductSchema(page));
  }

  const schemaGap = detectSchemaGap(page);
  if (schemaGap) issues.push(schemaGap);

  return issues;
}

/**
 * Salla adapter canonical check: on completed product/category extractions a
 * canonical pointing at another origin is its own verdict — costlier than the
 * generic canonicalized-page, so it replaces that report for catalog pages.
 */
function reportCrossDomainCanonical(
  canonicalUrl: string,
  pageUrl: string,
  pageType: CrawledPageResult["pageType"],
): Record<string, unknown> | null {
  if (pageType !== "product" && pageType !== "category") return null;
  let pageOrigin: string | null = null;
  let canonicalOrigin: string | null = null;
  try {
    pageOrigin = new URL(pageUrl).origin;
    canonicalOrigin = new URL(canonicalUrl).origin;
  } catch {
    return null;
  }
  if (canonicalOrigin === pageOrigin) return null;
  return { canonicalUrl, pageOrigin, canonicalOrigin };
}
