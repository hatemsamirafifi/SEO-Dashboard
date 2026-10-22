/**
 * robots.txt and sitemap.xml discovery for the site audit crawler.
 */
import robotsParser from "robots-parser";
import { XMLParser } from "fast-xml-parser";
import { isSameOrigin, normalizeUrl } from "./url-utils";
import { isCrawlableUrl } from "./url-policy";

const SITEMAP_FETCH_TIMEOUT_MS = 15_000;
const ROBOTS_FETCH_TIMEOUT_MS = 10_000;
const MAX_SITEMAP_DEPTH = 3;
const MAX_SITEMAP_DOCS = 300;
const SITEMAP_CONCURRENCY = 5;
const SITEMAP_RETRIES = 1;
/** Redirects followed for robots.txt/sitemap fetches (apex→www chains). */
const MAX_DISCOVERY_REDIRECTS = 3;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  isArray: (name) => name === "sitemap" || name === "url",
});

export interface RobotsResult {
  isAllowed: (url: string) => boolean;
  sitemapUrls: string[];
}

/** Per-source discovery coverage, persisted for crawl-quality metrics. */
export interface DiscoveryCoverage {
  /** Sitemap URLs declared by robots.txt (before the default-location add). */
  robotsDeclaredSitemaps: number;
  sitemapDocsFetched: number;
  sitemapDocsFailed: number;
  sitemapDocsTimedOut: number;
  /** Total page URLs collected from sitemaps (pre-seed-cap). */
  urlsFromSitemaps: number;
  /** True when the 300-document sitemap budget stopped discovery early. */
  sitemapDocCapReached: boolean;
  /** True when the discovered-URL budget stopped collection early. */
  urlCapReached: boolean;
}

/**
 * Fetch a discovery document (robots.txt, sitemap) following redirect chains
 * manually, with each hop re-validated against the SSRF policy: a 30x to an
 * internal host must never bypass it. Covers chains like apex → www.
 * Returns the final response (response.url is the final URL) or null for
 * definite non-retryable failures; a timeout propagates so the sitemap retry
 * layer can distinguish it.
 */
async function fetchDiscoveryDocument(
  url: string,
  timeoutMs: number,
): Promise<Response | null> {
  let currentUrl = url;
  for (let hop = 0; hop <= MAX_DISCOVERY_REDIRECTS; hop++) {
    if (!isCrawlableUrl(currentUrl)) return null;
    let response: Response;
    try {
      response = await fetch(currentUrl, {
        headers: { "User-Agent": "OpenSEO-Audit/1.0" },
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (error) {
      if (isTimeoutError(error)) throw error;
      return null;
    }
    if (response.status >= 300 && response.status < 400) {
      if (hop === MAX_DISCOVERY_REDIRECTS) return null;
      const location = response.headers.get("location");
      if (!location) return null;
      const resolved = normalizeUrl(location, currentUrl);
      if (!resolved) return null;
      currentUrl = resolved;
      continue;
    }
    return response;
  }
  return null;
}

/**
 * Fetch the raw robots.txt body (null = missing/unreachable). Kept separate
 * from parsing so Workflows can checkpoint the text as durable step state and
 * re-derive the parsed result deterministically on replay.
 */
async function fetchRobotsTxtText(origin: string): Promise<string | null> {
  let response: Response | null;
  try {
    response = await fetchDiscoveryDocument(
      `${origin}/robots.txt`,
      ROBOTS_FETCH_TIMEOUT_MS,
    );
  } catch {
    return null;
  }
  if (!response || !response.ok) return null;
  try {
    return await response.text();
  } catch {
    return null;
  }
}

/** Deterministic: same text in, same result out. Null = everything allowed. */
export function parseRobotsTxt(
  origin: string,
  text: string | null,
): RobotsResult {
  if (text === null) {
    return { isAllowed: () => true, sitemapUrls: [] };
  }

  const robots = robotsParser(`${origin}/robots.txt`, text);
  return {
    isAllowed: (url: string) => robots.isAllowed(url) ?? true,
    sitemapUrls: robots.getSitemaps(),
  };
}

/**
 * Fetch and parse a sitemap (supports sitemap index recursion).
 * Returns a flat list of page URLs found.
 */
function isProbablySitemapXml(
  contentType: string | null,
  body: string,
): boolean {
  if (contentType?.toLowerCase().includes("xml")) {
    return true;
  }

  const trimmed = body.trimStart().toLowerCase();
  return (
    trimmed.startsWith("<?xml") ||
    trimmed.startsWith("<urlset") ||
    trimmed.startsWith("<sitemapindex")
  );
}

function getSitemapLocations(input: unknown): string[] {
  if (!input) return [];
  const entries = Array.isArray(input) ? input : [input];
  return entries
    .map((entry) => {
      if (isRecord(entry)) {
        const loc = entry["loc"];
        return typeof loc === "string" ? loc : null;
      }
      return null;
    })
    .filter((loc): loc is string => typeof loc === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object";
}

function getParsedSitemapSections(parsed: unknown): {
  sitemap: unknown;
  url: unknown;
} {
  if (!parsed || typeof parsed !== "object") {
    return { sitemap: undefined, url: undefined };
  }

  const root = parsed as {
    sitemapindex?: { sitemap?: unknown };
    urlset?: { url?: unknown };
  };

  return {
    sitemap: root.sitemapindex?.sitemap,
    url: root.urlset?.url,
  };
}

function isTimeoutError(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  return "name" in error && error.name === "TimeoutError";
}

async function fetchSitemapDocumentWithRetry(sitemapUrl: string): Promise<{
  nestedSitemaps: string[];
  pageUrls: string[];
  timedOut: boolean;
}> {
  const normalizedSitemapUrl = normalizeUrl(sitemapUrl);
  if (!normalizedSitemapUrl) {
    return { nestedSitemaps: [], pageUrls: [], timedOut: false };
  }

  let lastError: unknown = null;

  for (let attempt = 0; attempt <= SITEMAP_RETRIES; attempt++) {
    try {
      const response = await fetchDiscoveryDocument(
        normalizedSitemapUrl,
        SITEMAP_FETCH_TIMEOUT_MS,
      );
      if (!response) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const finalUrl = normalizeUrl(response.url, normalizedSitemapUrl);
      if (!finalUrl || !isSameOrigin(finalUrl, normalizedSitemapUrl)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      if (!response.ok) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const body = await response.text();
      if (!isProbablySitemapXml(response.headers.get("content-type"), body)) {
        return { nestedSitemaps: [], pageUrls: [], timedOut: false };
      }

      const parsed = xmlParser.parse(body) as unknown;
      const sections = getParsedSitemapSections(parsed);
      const nestedSitemaps = getSitemapLocations(sections.sitemap)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);
      const pageUrls = getSitemapLocations(sections.url)
        .map((loc) => normalizeUrl(loc, finalUrl))
        .filter((loc): loc is string => loc !== null);

      return { nestedSitemaps, pageUrls, timedOut: false };
    } catch (error) {
      lastError = error;
      if (!isTimeoutError(error) || attempt === SITEMAP_RETRIES) {
        break;
      }
    }
  }

  return {
    nestedSitemaps: [],
    pageUrls: [],
    timedOut: isTimeoutError(lastError),
  };
}

/**
 * Discover all page URLs from robots.txt + sitemaps for an origin.
 * Also tries the default /sitemap.xml if not listed in robots.txt.
 *
 * Returns every discovered URL (bounded by maxDiscoveredUrls), not just the
 * crawl's page budget: the full set is persisted as sitemap membership so a
 * URL the crawl later reaches by link still reports inSitemap=true, while
 * the caller caps what enters the frontier (Workflow step-state limits).
 */
export async function discoverUrls(
  origin: string,
  maxPages = 50,
): Promise<{
  urls: string[];
  robotsText: string | null;
  coverage: DiscoveryCoverage;
}> {
  const robotsText = await fetchRobotsTxtText(origin);
  const robots = parseRobotsTxt(origin, robotsText);

  // Collect sitemap URLs: from robots.txt + default location
  const sitemapSources = new Set(robots.sitemapUrls);
  sitemapSources.add(`${origin}/sitemap.xml`);

  const maxDiscoveredUrls = Math.min(Math.max(maxPages * 20, 500), 50_000);
  const allUrls = new Set<string>();

  const queue: Array<{ url: string; depth: number }> = Array.from(
    sitemapSources,
  )
    .map((url) => normalizeUrl(url, origin))
    .filter((url): url is string => url !== null)
    .filter((url) => isSameOrigin(url, origin))
    .map((url) => ({ url, depth: MAX_SITEMAP_DEPTH }));
  const seenSitemapDocs = new Set<string>();
  const coverage: DiscoveryCoverage = {
    robotsDeclaredSitemaps: robots.sitemapUrls.length,
    sitemapDocsFetched: 0,
    sitemapDocsFailed: 0,
    sitemapDocsTimedOut: 0,
    urlsFromSitemaps: 0,
    sitemapDocCapReached: false,
    urlCapReached: false,
  };

  while (queue.length > 0 && allUrls.size < maxDiscoveredUrls) {
    if (coverage.sitemapDocsFetched >= MAX_SITEMAP_DOCS) {
      coverage.sitemapDocCapReached = true;
      break;
    }
    const batch = queue.splice(0, SITEMAP_CONCURRENCY);
    await Promise.all(
      batch.map(async ({ url, depth }) => {
        const normalizedUrl = normalizeUrl(url);
        if (
          !normalizedUrl ||
          !isSameOrigin(normalizedUrl, origin) ||
          depth <= 0 ||
          seenSitemapDocs.has(normalizedUrl)
        ) {
          return;
        }

        seenSitemapDocs.add(normalizedUrl);
        coverage.sitemapDocsFetched += 1;

        const result = await fetchSitemapDocumentWithRetry(normalizedUrl);
        if (
          result.pageUrls.length === 0 &&
          result.nestedSitemaps.length === 0
        ) {
          coverage.sitemapDocsFailed += 1;
          if (result.timedOut) {
            coverage.sitemapDocsTimedOut += 1;
          }
          return;
        }

        for (const pageUrl of result.pageUrls) {
          if (!isSameOrigin(pageUrl, origin)) continue;
          if (allUrls.size >= maxDiscoveredUrls) {
            coverage.urlCapReached = true;
            break;
          }
          const before = allUrls.size;
          allUrls.add(pageUrl);
          if (allUrls.size > before) {
            coverage.urlsFromSitemaps += 1;
          }
        }

        if (depth <= 1) return;

        for (const nestedUrl of result.nestedSitemaps) {
          if (!isSameOrigin(nestedUrl, origin)) continue;
          if (!seenSitemapDocs.has(nestedUrl)) {
            queue.push({ url: nestedUrl, depth: depth - 1 });
          }
        }
      }),
    );
  }

  if (coverage.sitemapDocsFailed > 0) {
    console.warn(
      `Sitemap discovery completed with partial failures for ${origin}: fetched=${coverage.sitemapDocsFetched}, failed=${coverage.sitemapDocsFailed}, timedOut=${coverage.sitemapDocsTimedOut}, discoveredUrls=${allUrls.size}`,
    );
  }

  return {
    urls: Array.from(allUrls),
    robotsText,
    coverage,
  };
}
