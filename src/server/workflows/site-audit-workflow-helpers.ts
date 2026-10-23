import type {
  CrawledPageResult,
  ExtractionState,
  PageFetchClass,
  PageFailureReason,
} from "@/server/lib/audit/types";
import type { CrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import { classifyFetch } from "@/server/lib/audit/classify-fetch";
import type { PlatformDetection } from "@/server/lib/audit/platform-detection";
import { detectPlatform } from "@/server/lib/audit/platform-detection";
import { sha256Hex } from "@/server/lib/audit/ids";
import { normalizeUrl } from "@/server/lib/audit/url-utils";

const CRAWL_USER_AGENT = "OpenSEO-Audit/1.0";
const MAX_HTML_BYTES = 2 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 15_000;
const MAX_H1_TEXT_CHARS = 500;

function firstH1Text(h1s: string[]): string | null {
  const first = h1s.find((h1) => h1.trim().length > 0);
  return first ? first.trim().slice(0, MAX_H1_TEXT_CHARS) : null;
}

/**
 * How a page fetch resolved, and how completely it was extracted.
 *
 * redirectUrl is the normalized `Location` target on redirect rows.
 * extractionState follows the audit shared taxonomy: blocked/rate-limited
 * pages are ACCESS_BLOCKED, failed fetches EXTRACTION_FAILED, redirect
 * rows and non-HTML/4xx/5xx documents NOT_EXTRACTED, analyzed HTML pages
 * STATIC_COMPLETE / STATIC_PARTIAL / RENDERING_REQUIRED per page-analyzer.
 */
export async function crawlPage(url: string): Promise<CrawledPageResult> {
  const startTime = Date.now();

  try {
    // Manual redirect handling: each hop is recorded as its own page row and
    // its target is enqueued by the frontier, so redirect chains and loops are
    // detectable from the recorded rows. Trailing-slash redirects (/docs ->
    // /docs/) need no special handling: normalizeUrl preserves trailing
    // slashes, so /docs and /docs/ are distinct URLs and the redirect resolves
    // to its canonical target instead of cycling back to its own source.
    const response = await fetch(url, {
      headers: {
        "User-Agent": CRAWL_USER_AGENT,
        Accept: "text/html,application/xhtml+xml",
      },
      redirect: "manual",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    const responseTimeMs = Date.now() - startTime;
    const statusCode = response.status;
    const headerSnapshot = Object.fromEntries(response.headers);
    const xRobotsTag = response.headers.get("x-robots-tag");
    const headerCanonicalUrl = parseLinkHeaderCanonical(
      response.headers.get("link"),
      url,
    );

    if (statusCode >= 300 && statusCode < 400) {
      const location = response.headers.get("location");
      const redirectUrl = location ? normalizeUrl(location, url) : null;
      return partialPageResult({
        url,
        statusCode,
        fetchClass: "ok",
        extractionState: "NOT_EXTRACTED",
        redirectUrl,
        responseTimeMs,
        htmlBytes: 0,
        xRobotsTag,
        headerCanonicalUrl,
      });
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isHtml = contentType.includes("text/html");
    // Large pages make Cheerio disproportionately expensive and can exhaust a
    // crawl step's CPU or isolate memory. The first 2 MiB still contains the
    // SEO metadata and navigation needed by the audit in normal documents.
    const body = isHtml
      ? await readTextUpTo(response, MAX_HTML_BYTES)
      : { text: "", bytes: 0, truncated: false };
    const fetchClass = classifyFetch(
      statusCode,
      Boolean(response.headers.get("cf-mitigated")),
      body.text.slice(0, 4_000),
    );

    if (fetchClass === "blocked" || fetchClass === "rate_limited") {
      return partialPageResult({
        url,
        statusCode,
        fetchClass,
        extractionState: "ACCESS_BLOCKED",
        redirectUrl: null,
        responseTimeMs,
        htmlBytes: body.bytes,
        xRobotsTag,
        headerCanonicalUrl,
        retryAfter: response.headers.get("retry-after"),
      });
    }
    if (!isHtml || statusCode >= 400) {
      return partialPageResult({
        url,
        statusCode,
        fetchClass,
        extractionState: "NOT_EXTRACTED",
        redirectUrl: null,
        responseTimeMs,
        htmlBytes: body.bytes,
        xRobotsTag,
        headerCanonicalUrl,
      });
    }

    // Dynamic import keeps cheerio (page-analyzer's HTML parser) out of the
    // worker's startup module graph: SiteAuditWorkflow is re-exported from
    // src/server.ts, so a static import would evaluate cheerio in every
    // isolate's baseline heap, not just when an audit actually crawls.
    const { analyzeHtml, classifyExtractionState } =
      await import("@/server/lib/audit/page-analyzer");
    let analysis;
    let platformDetection: PlatformDetection = {
      platform: null,
      confidence: 0,
      evidence: [],
    };
    try {
      analysis = analyzeHtml(body.text, url, statusCode, responseTimeMs);
    } catch {
      // A page we cannot parse is exactly the case where claiming "complete"
      // extraction would be dishonest: record ok/fetch but failed analysis.
      // Platform detection still runs on the reachable HTML.
      platformDetection = detectPlatform({
        html: body.text,
        url,
        headers: headerSnapshot,
      });
      return partialPageResult({
        url,
        statusCode,
        fetchClass: "ok",
        extractionState: "EXTRACTION_FAILED",
        redirectUrl: null,
        responseTimeMs,
        htmlBytes: body.bytes,
        xRobotsTag,
        headerCanonicalUrl,
        title: "",
        isIndexable: false,
        platform: platformDetection.platform,
        platformConfidence: platformDetection.confidence,
      });
    }

    // Platform detection runs on the same reachable HTML (see the 2 MiB cap
    // above). Below-threshold evidence never names a platform.
    platformDetection = detectPlatform({
      html: body.text,
      url,
      headers: headerSnapshot,
    });

    return {
      id: crypto.randomUUID(),
      url,
      statusCode,
      fetchClass,
      // The head metadata derives from data within the read window; body
      // word counts and findings that depend on full content are not
      // complete when the document was truncated. Report STATIC_PARTIAL
      // there and let page-reporters gate accordingly.
      extractionState: body.truncated
        ? "STATIC_PARTIAL"
        : classifyExtractionState(body.text, analysis),
      failureReason: null,
      retryAfter: null,
      redirectUrl: null,
      title: analysis.title,
      metaDescription: analysis.metaDescription,
      canonicalUrl: analysis.canonical
        ? (normalizeUrl(analysis.canonical, url) ?? analysis.canonical)
        : null,
      robotsMeta: analysis.robotsMeta,
      xRobotsTag,
      headerCanonicalUrl,
      ogTitle: analysis.ogTitle,
      ogDescription: analysis.ogDescription,
      ogImage: analysis.ogImage,
      h1Count: analysis.h1s.filter((h) => h.length > 0).length,
      h1Text: firstH1Text(analysis.h1s),
      h2Count: analysis.headingOrder.filter((h) => h === 2).length,
      h3Count: analysis.headingOrder.filter((h) => h === 3).length,
      h4Count: analysis.headingOrder.filter((h) => h === 4).length,
      h5Count: analysis.headingOrder.filter((h) => h === 5).length,
      h6Count: analysis.headingOrder.filter((h) => h === 6).length,
      headingOrder: analysis.headingOrder,
      wordCount: analysis.wordCount,
      contentHash: analysis.bodyText
        ? await sha256Hex(analysis.bodyText)
        : null,
      htmlBytes: body.bytes,
      isHtml: true,
      imagesTotal: analysis.images.length,
      // Only a truly absent alt attribute counts: alt="" is the correct
      // markup for decorative images.
      imagesMissingAlt: analysis.images.filter((img) => img.alt === null)
        .length,
      images: analysis.images,
      links: analysis.links,
      hasStructuredData: analysis.hasStructuredData,
      structuredDataJson: analysis.structuredDataJson,
      sallaExtractionJson: analysis.sallaExtractionJson,
      hreflangTags: analysis.hreflangTags,
      isIndexable: ![analysis.robotsMeta, xRobotsTag]
        .filter(Boolean)
        .join(",")
        .toLowerCase()
        .includes("noindex"),
      responseTimeMs,
      platform: platformDetection.platform,
      platformConfidence: platformDetection.confidence,
      pageType: analysis.pageType,
      pageTypeConfidence: analysis.pageTypeConfidence,
      crawlDepth: null,
      inSitemap: false,
    };
  } catch (error) {
    const responseTimeMs = Date.now() - startTime;
    const failureReason: PageFailureReason =
      error instanceof Error && error.name === "TimeoutError"
        ? "fetch_timeout"
        : "network_error";
    console.warn(`Failed to crawl ${url}:`, failureReason, error);
    return partialPageResult({
      url,
      statusCode: 0,
      fetchClass: "error",
      extractionState: "EXTRACTION_FAILED",
      redirectUrl: null,
      responseTimeMs,
      htmlBytes: 0,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      failureReason,
    });
  }
}

/** Parse `Link: <url>; rel="canonical"` response headers. */
function parseLinkHeaderCanonical(
  linkHeader: string | null,
  pageUrl: string,
): string | null {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>\s*;([^]*)/);
    if (!match) continue;
    if (/rel\s*=\s*"?canonical"?/i.test(match[2])) {
      return normalizeUrl(match[1].trim(), pageUrl);
    }
  }
  return null;
}

async function readTextUpTo(
  response: Response,
  maxBytes: number,
): Promise<{
  text: string;
  bytes: number;
  truncated: boolean;
}> {
  if (!response.body) return { text: "", bytes: 0, truncated: false };

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const parts: string[] = [];
  let bytesRead = 0;
  let truncated = false;

  try {
    while (bytesRead < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;

      const remaining = maxBytes - bytesRead;
      const chunk =
        value.byteLength > remaining ? value.subarray(0, remaining) : value;
      bytesRead += chunk.byteLength;
      parts.push(decoder.decode(chunk, { stream: true }));

      if (value.byteLength > remaining) {
        truncated = true;
        await reader.cancel();
        break;
      }
      if (bytesRead >= maxBytes) {
        truncated = true;
        await reader.cancel();
        break;
      }
    }
  } finally {
    reader.releaseLock();
  }

  parts.push(decoder.decode());
  return { text: parts.join(""), bytes: bytesRead, truncated };
}

/**
 * One crawl attempt with throttling and 429 retries. Resolves with a page
 * row once the fetch is final, or `notFetched: true` when the origin was
 * paused out of this batch's budget (cooldown, deadline, or crawl stop):
 *
 * - immediately for every non-429 outcome;
 * - after re-fetching up to MAX_RETRIES when the site answered 429;
 * - as the last 429 (fetchClass rate_limited, recorded) when the URL ran
 *   out of retries.
 *
 * A 429 pauses the origin for the whole batch: the throttle governs every
 * attempt, not just this URL's.
 */
export type ThrottledFetchResult =
  | { notFetched: false; result: CrawledPageResult }
  | { notFetched: true; result: null };

export async function crawlPageWithThrottle(
  throttle: CrawlThrottle,
  url: string,
): Promise<ThrottledFetchResult> {
  let attempt = 0;
  for (;;) {
    const started = await throttle.ready();
    if (!started) return { notFetched: true, result: null };
    const result = await crawlPage(url);
    if (result.fetchClass !== "rate_limited") {
      await throttle.recovered();
      return { notFetched: false, result };
    }
    attempt += 1;
    const mayRetry = await throttle.backoff(attempt, result.retryAfter);
    if (!mayRetry) {
      // Final 429: record the page as rate_limited so the audit reports it
      // honestly instead of silently skipping it.
      return { notFetched: false, result };
    }
  }
}

interface PartialPageResultInput {
  url: string;
  statusCode: number;
  fetchClass: PageFetchClass;
  extractionState: ExtractionState;
  failureReason?: PageFailureReason | null;
  retryAfter?: string | null;
  redirectUrl: string | null;
  responseTimeMs: number;
  htmlBytes: number;
  xRobotsTag: string | null;
  headerCanonicalUrl: string | null;
  title?: string;
  isIndexable?: boolean;
  platform?: PlatformDetection["platform"];
  platformConfidence?: PlatformDetection["confidence"];
}

function partialPageResult(input: PartialPageResultInput): CrawledPageResult {
  return {
    id: crypto.randomUUID(),
    url: input.url,
    statusCode: input.statusCode,
    fetchClass: input.fetchClass,
    extractionState: input.extractionState,
    failureReason: input.failureReason ?? null,
    retryAfter: input.retryAfter ?? null,
    redirectUrl: input.redirectUrl,
    title: input.title ?? "",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: input.xRobotsTag,
    headerCanonicalUrl: input.headerCanonicalUrl,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 0,
    h1Text: null,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [],
    wordCount: 0,
    contentHash: null,
    htmlBytes: input.htmlBytes,
    isHtml: false,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: false,
    structuredDataJson: null,
    sallaExtractionJson: null,
    hreflangTags: [],
    isIndexable: input.isIndexable ?? false,
    responseTimeMs: input.responseTimeMs,
    platform: input.platform ?? null,
    platformConfidence: input.platformConfidence ?? 0,
    pageType: null,
    pageTypeConfidence: null,
    crawlDepth: null,
    inSitemap: false,
  };
}
