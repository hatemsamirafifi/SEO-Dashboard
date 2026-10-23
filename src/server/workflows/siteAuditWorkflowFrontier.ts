/**
 * Pure frontier helpers for the site audit crawl: batch selection, requeue
 * of unvisited entries, and the slim per-page summaries the crawl step
 * returns. Kept free of DB and Workflow access so they can be unit tested
 * directly.
 */
import { CRAWL_WINDOW } from "@/server/lib/audit/crawl-window";
import type { RobotsResult } from "@/server/lib/audit/discovery";
import type {
  CrawledPageResult,
  StepPageSummary,
} from "@/server/lib/audit/types";
import { crawlDedupKey } from "@/server/lib/audit/url-utils";

// Upper bound of the rolling window: the crawl adapts between min and max
// based on observed fetch outcomes (see crawl-window.ts). Pages are pulled
// one at a time into the window, so a slow or blocked page only occupies one
// slot instead of stalling a whole fixed batch.
const BATCH_CONCURRENCY = CRAWL_WINDOW.max;
// Keep durable step state under the ~1MiB limit: full link lists live in D1;
// the step return only carries new-to-the-frontier targets, deduped across
// the batch and capped.
//
// Phase 3 cap review: the cap is on the *union* of new targets across the
// batch, not per page, so the worst case is 2,000 URLs ≈ 200 KB of step
// state — comfortably inside the 1MiB Workflows limit. Raising it would
// only add frontier noise: the crawl visits at most maxPages URLs anyway.
const MAX_FRONTIER_LINKS_PER_BATCH = 2_000;
const MAX_SUMMARY_TITLE_CHARS = 300;

/**
 * Crawl membership is keyed by tracking-param-collapsed URL: ?utm_source=
 * variants of one page occupy one frontier slot, while meaningful params
 * (?page=N, filters) keep distinct pages distinct. The frontier itself
 * carries full URLs — the first-seen variant is the one crawled and stored.
 */
export const dedupKeyOf = (url: string): string => crawlDedupKey(url) ?? url;

export interface QueueEntry {
  url: string;
  /** Clicks from the start URL; null when only reachable via sitemap. */
  depth: number | null;
}

/**
 * Put URLs that a paused throttle refused back at the front of their
 * queue, in original selection order, so a later batch fetches them.
 */
export function requeuePendingEntries(params: {
  batchEntries: QueueEntry[];
  entries: QueueEntry[];
  visited: Set<string>;
  queued: Set<string>;
  linkQueue: QueueEntry[];
  sitemapQueue: QueueEntry[];
}) {
  const { batchEntries, entries, visited, queued, linkQueue, sitemapQueue } =
    params;
  if (entries.length === 0) return;
  const selectionOrder = new Map(
    batchEntries.map((entry, index) => [entry.url, index]),
  );
  const inOrder = [...entries].toSorted(
    (a, b) =>
      (selectionOrder.get(a.url) ?? 0) - (selectionOrder.get(b.url) ?? 0),
  );
  for (const entry of inOrder.toReversed()) {
    visited.delete(dedupKeyOf(entry.url));
    queued.add(dedupKeyOf(entry.url));
    if (entry.depth === null) sitemapQueue.unshift(entry);
    else linkQueue.unshift(entry);
  }
}

export function selectNextCrawlBatch(params: {
  linkQueue: QueueEntry[];
  sitemapQueue: QueueEntry[];
  queued: Set<string>;
  visited: Set<string>;
  robots: RobotsResult;
  remaining: number;
}) {
  const { linkQueue, sitemapQueue, queued, visited, robots, remaining } =
    params;
  const batchSize = Math.min(BATCH_CONCURRENCY, remaining);
  const batchEntries: QueueEntry[] = [];

  while (
    (linkQueue.length > 0 || sitemapQueue.length > 0) &&
    batchEntries.length < batchSize
  ) {
    const entry = (linkQueue.length > 0 ? linkQueue : sitemapQueue).shift()!;
    queued.delete(dedupKeyOf(entry.url));
    if (visited.has(dedupKeyOf(entry.url))) continue;
    if (!robots.isAllowed(entry.url)) continue;
    visited.add(dedupKeyOf(entry.url));
    batchEntries.push(entry);
  }

  return batchEntries;
}

/**
 * Frontier candidates only: drop targets already visited/queued and dedupe
 * across the batch, so the step return stays far under the ~1MiB
 * durable-state limit even on mega-menu sites.
 */
export function buildPageSummaries(
  pages: CrawledPageResult[],
  visited: Set<string>,
  queued: Set<string>,
): StepPageSummary[] {
  const seenTargets = new Set<string>();
  return pages.map((page) => {
    const internalLinks: string[] = [];
    for (const link of page.links) {
      if (!link.isInternal) continue;
      if (seenTargets.size >= MAX_FRONTIER_LINKS_PER_BATCH) break;
      const key = dedupKeyOf(link.targetUrl);
      if (visited.has(key) || queued.has(key)) continue;
      if (seenTargets.has(key)) continue;
      seenTargets.add(key);
      internalLinks.push(link.targetUrl);
    }
    return {
      id: page.id,
      url: page.url,
      statusCode: page.statusCode,
      fetchClass: page.fetchClass,
      redirectUrl: page.redirectUrl,
      title: page.title.slice(0, MAX_SUMMARY_TITLE_CHARS),
      internalLinks,
    };
  });
}
