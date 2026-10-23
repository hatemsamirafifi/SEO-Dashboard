import type { WorkflowStep } from "cloudflare:workers";
import type { RobotsResult } from "@/server/lib/audit/discovery";
import type { CrawlThrottleState } from "@/server/lib/audit/crawl-throttle";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import {
  adjustCrawlWindow,
  CRAWL_WINDOW,
} from "@/server/lib/audit/crawl-window";
import type {
  CrawledPageResult,
  StepPageSummary,
} from "@/server/lib/audit/types";
import { isSameOrigin, normalizeUrl } from "@/server/lib/audit/url-utils";
import { isCrawlableUrl } from "@/server/lib/audit/url-policy";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import { runPageReporters } from "@/server/lib/audit/issues/page-reporters";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { crawlPageWithThrottle } from "@/server/workflows/site-audit-workflow-helpers";
import { pgStep } from "@/server/workflows/pgStep";
import {
  buildPageSummaries,
  dedupKeyOf,
  requeuePendingEntries,
  selectNextCrawlBatch,
  type QueueEntry,
} from "@/server/workflows/siteAuditWorkflowFrontier";

/**
 * One crawl batch may not stretch forever: a site handing out minutes-long
 * 429 pauses stops this batch early (URLs wait, requeued, for a later
 * batch) instead of hanging a Workflow step.
 */
const MAX_BATCH_MS = 10 * 60_000;

function shouldQueueCrawlLink(
  link: string,
  origin: string,
  robots: RobotsResult,
  visited: Set<string>,
  queued: Set<string>,
): boolean {
  const key = dedupKeyOf(link);
  return (
    isSameOrigin(link, origin) &&
    isCrawlableUrl(link) &&
    robots.isAllowed(link) &&
    !visited.has(key) &&
    !queued.has(key)
  );
}

type CrawlPhaseParams = {
  auditId: string;
  workflowInstanceId: string;
  origin: string;
  startUrl: string;
  maxPages: number;
  robots: RobotsResult;
  sitemapUrls: string[];
};

/** What later phases need per page — no link lists (those stay in D1). */
export type CrawledPageSummary = Omit<StepPageSummary, "internalLinks">;

export type CrawlPhaseResult = {
  pages: CrawledPageSummary[];
  /** True when the frontier was exhausted before hitting maxPages. */
  completed: boolean;
  /** True when the crawl ended early: rate limits or inaccessible fetches. */
  stoppedEarly: boolean;
  /** True when the user cancelled mid-crawl (D8: page states stay intact). */
  cancelled: boolean;
  /** Where the frontier stood at loop exit — feeds the finalize counters. */
  frontier: { discovered: number; remaining: number };
};

export async function runCrawlPhase(
  step: WorkflowStep,
  params: CrawlPhaseParams,
  deps?: { isCancelled?: () => Promise<boolean> },
): Promise<CrawlPhaseResult> {
  const {
    auditId,
    workflowInstanceId,
    origin,
    startUrl,
    maxPages,
    robots,
    sitemapUrls,
  } = params;
  const visited = new Set<string>();
  const queued = new Set<string>();
  // Link-discovered URLs crawl first (BFS from the start URL); sitemap-only
  // URLs drain last so link discovery isn't starved of page budget and
  // orphan detection stays meaningful.
  const linkQueue: QueueEntry[] = [];
  const sitemapQueue: QueueEntry[] = [];
  // Membership is keyed by dedup key (see dedupKeyOf), so a link-reached
  // ?utm_ variant of a sitemap URL still reports inSitemap=true. Prefer the
  // full membership set persisted at discovery — the seed list passed in is
  // a frontier-capped fallback for replay robustness.
  const sitemapSet = new Set<string>();
  const summaries: CrawledPageSummary[] = [];
  let stoppedEarly = false;
  let cancelled = false;
  // Readoutside any durable step so each replay and each live batch sees a
  // fresh answer; a read failure means "keep crawling" rather than an
  // instance kill for a transient DB hiccup.
  const isCancelled =
    deps?.isCancelled ??
    (() => AuditRepository.getAuditCancelFlag(auditId).catch(() => false));

  const normalizedStart = normalizeUrl(startUrl) ?? startUrl;
  if (
    robots.isAllowed(normalizedStart) &&
    isSameOrigin(normalizedStart, origin)
  ) {
    linkQueue.push({ url: normalizedStart, depth: 0 });
    queued.add(dedupKeyOf(normalizedStart));
  }

  const membership = await AuditProgressKV.loadSitemapMembership(auditId);
  const membershipUrls = membership?.urls ?? [];
  for (const sitemapUrl of membershipUrls.length > 0
    ? membershipUrls
    : sitemapUrls) {
    const normalized = normalizeUrl(sitemapUrl);
    if (!normalized) continue;
    sitemapSet.add(dedupKeyOf(normalized));
    if (!shouldQueueCrawlLink(normalized, origin, robots, visited, queued)) {
      continue;
    }
    sitemapQueue.push({ url: normalized, depth: null });
    queued.add(dedupKeyOf(normalized));
  }

  // Evaluate the page analyzer once, before any measured fetch: its lazy
  // import is a one-time module evaluation, and paying it inside the first
  // concurrent batch would block the event loop and inflate the other
  // fetches' responseTimeMs with initialization time instead of network
  // latency. Everything the analyzer's graph needs (cheerio, the Salla
  // extractors) is evaluated here, before the first batch.
  await import("@/server/lib/audit/page-analyzer").catch(() => {});

  let crawlBatchIndex = 0;
  while (
    (linkQueue.length > 0 || sitemapQueue.length > 0) &&
    summaries.length < maxPages
  ) {
    if (await isCancelled()) {
      cancelled = true;
      break;
    }

    const batchEntries = selectNextCrawlBatch({
      linkQueue,
      sitemapQueue,
      queued,
      visited,
      robots,
      remaining: maxPages - summaries.length,
    });
    if (batchEntries.length === 0) continue;

    crawlBatchIndex += 1;
    const { pages, requeued, throttled } = await runCrawlBatch(step, {
      crawlBatchIndex,
      auditId,
      batchEntries,
      sitemapSet,
      visited,
      queued,
    });
    // Keep only the slim summary in memory: at 10k pages, retaining link
    // lists for the whole crawl would not fit in the 128MB Worker heap.
    summaries.push(
      ...pages.map(({ internalLinks: _links, ...summary }) => summary),
    );

    // Requeue before any early exit: entries the origin deferred or that
    // the throttle stopped mid-top-up must return to the frontier even
    // when this batch produced nothing.
    requeuePendingEntries({
      batchEntries,
      entries: requeued,
      visited,
      queued,
      linkQueue,
      sitemapQueue,
    });

    if (pages.length === 0) {
      // Nothing could be fetched this batch: the origin is paused or
      // unreachable and continuing would spin. End the crawl early; the
      // remaining frontier is reported as uncrawled, truthfully.
      stoppedEarly = true;
      break;
    }
    if (throttled) {
      // The throttle hit a hard stop (severe rate limiting).
      stoppedEarly = true;
      break;
    }

    enqueueDiscoveredLinks({
      crawledBatch: pages,
      // Depth lookup needs every candidate's depth; requeued entries simply
      // never produce a pageResult, so passing the full batch is equivalent.
      batchEntries,
      linkQueue,
      queued,
      visited,
      origin,
      robots,
    });
    await persistCrawlProgress({
      step,
      crawlBatchIndex,
      auditId,
      workflowInstanceId,
      crawledBatch: pages,
      pagesCrawled: summaries.length,
      visitedCount: visited.size,
      queueLength: linkQueue.length + sitemapQueue.length,
      maxPages,
    });
  }

  // Unique URLs that ever entered the frontier: selectNextCrawlBatch moves
  // keys from `queued` to `visited`, so the union is an exact count. The
  // remaining queues report what a completed_partial (or cancelled) audit
  // never reached.
  const frontier = {
    discovered: visited.size + queued.size,
    remaining: linkQueue.length + sitemapQueue.length,
  };

  return {
    pages: summaries,
    completed:
      !cancelled &&
      linkQueue.length === 0 &&
      sitemapQueue.length === 0 &&
      !stoppedEarly,
    stoppedEarly,
    cancelled,
    frontier,
  };
}

type SettledFetch = {
  entry: QueueEntry;
  outcome: Awaited<ReturnType<typeof crawlPageWithThrottle>>;
};

interface BatchOutcome {
  pages: StepPageSummary[];
  /** Entries selected but never fetched this batch (origin paused). */
  requeued: QueueEntry[];
  /** The throttle demanded a hard crawl stop. */
  throttled: boolean;
}

async function runCrawlBatch(
  step: WorkflowStep,
  input: {
    crawlBatchIndex: number;
    auditId: string;
    batchEntries: QueueEntry[];
    sitemapSet: Set<string>;
    visited: Set<string>;
    queued: Set<string>;
  },
): Promise<BatchOutcome> {
  const { crawlBatchIndex, auditId } = input;
  return pgStep(step, `crawl-batch-${crawlBatchIndex}`, undefined, async () => {
    const prior = await AuditProgressKV.loadCrawlState(auditId);
    const throttle = createCrawlThrottle(
      Date.now() + MAX_BATCH_MS,
      prior?.throttle as CrawlThrottleState | undefined,
    );
    let windowSize = prior?.windowSize ?? CRAWL_WINDOW.initial;

    const pages: CrawledPageResult[] = [];
    const requeued: QueueEntry[] = [];
    const pending: QueueEntry[] = [...input.batchEntries];
    const inFlight = new Map<Promise<SettledFetch>, QueueEntry>();

    for (;;) {
      while (
        inFlight.size < windowSize &&
        pending.length > 0 &&
        (await throttle.ready())
      ) {
        // throttle.ready() reserves a slot synchronously when ready, so
        // sequential top-ups cannot overreach the origin pacing.
        //
        // Subrequest accounting (Phase 3 review): one crawlPage is exactly
        // one subrequest — redirects are followed manually and each hop is
        // its own page row, so a URL never chains subrequests. The window
        // caps the batch at 25 in-flight fetches, comfortably under the
        // 50-subrequest ceiling for a single step.
        const entry = pending.shift()!;
        const settled = crawlPageWithThrottle(throttle, entry.url).then(
          (outcome) => ({ entry, outcome }),
        );
        inFlight.set(settled, entry);
      }
      // The throttle can stop admitting mid-top-up; entries the batch
      // selected but never started must return to the frontier instead of
      // being dropped with their visited marks.
      if (inFlight.size === 0) {
        requeued.push(...pending);
        pending.length = 0;
        break;
      }

      // Race wrapped pairs so the winning promise itself stays available as
      // the map key to evict.
      const [completed, settled] = await Promise.race(
        [...inFlight.keys()].map((promise) =>
          promise.then((value) => [promise, value] as const),
        ),
      );
      inFlight.delete(completed);
      const { entry, outcome } = settled;
      if (outcome.notFetched) {
        requeued.push(entry);
        continue;
      }
      const result = outcome.result;
      result.crawlDepth = entry.depth;
      result.inSitemap = input.sitemapSet.has(dedupKeyOf(entry.url));
      pages.push(result);

      // Adapt the window per settled page: politeness reacts quickly,
      // growth still requires a large clean sample.
      windowSize = adjustCrawlWindow(windowSize, pages);
    }

    // Checkpoint throttle + window so a later batch resumes the site's
    // pacing instead of resetting it.
    await AuditProgressKV.saveCrawlState(auditId, {
      throttle: throttle.state,
      windowSize,
    });

    // Deterministic ids keep the D1 writes idempotent across step retries.
    for (const page of pages) {
      page.id = await deterministicAuditRowId(auditId, page.url);
    }

    const issues = pages.flatMap((page) => runPageReporters(page));
    await AuditRepository.insertCrawledBatch(auditId, pages, issues);

    const summaries = buildPageSummaries(pages, input.visited, input.queued);
    return {
      pages: summaries,
      requeued,
      throttled: throttle.stopped,
    };
  });
}

function enqueueDiscoveredLinks(params: {
  crawledBatch: StepPageSummary[];
  batchEntries: QueueEntry[];
  linkQueue: QueueEntry[];
  queued: Set<string>;
  visited: Set<string>;
  origin: string;
  robots: RobotsResult;
}) {
  const {
    crawledBatch,
    batchEntries,
    linkQueue,
    queued,
    visited,
    origin,
    robots,
  } = params;
  const depthByUrl = new Map(
    batchEntries.map((entry) => [entry.url, entry.depth]),
  );

  for (const pageResult of crawledBatch) {
    const pageDepth = depthByUrl.get(pageResult.url) ?? null;
    const childDepth = pageDepth === null ? null : pageDepth + 1;

    for (const link of pageResult.internalLinks) {
      if (!shouldQueueCrawlLink(link, origin, robots, visited, queued)) {
        continue;
      }
      linkQueue.push({ url: link, depth: childDepth });
      queued.add(dedupKeyOf(link));
    }

    // Redirect targets continue the same navigation path: same depth.
    const redirectTarget = pageResult.redirectUrl;
    if (
      redirectTarget &&
      shouldQueueCrawlLink(redirectTarget, origin, robots, visited, queued)
    ) {
      linkQueue.push({ url: redirectTarget, depth: pageDepth });
      queued.add(dedupKeyOf(redirectTarget));
    }
  }
}

async function persistCrawlProgress(params: {
  step: WorkflowStep;
  crawlBatchIndex: number;
  auditId: string;
  workflowInstanceId: string;
  crawledBatch: StepPageSummary[];
  pagesCrawled: number;
  visitedCount: number;
  queueLength: number;
  maxPages: number;
}) {
  const {
    step,
    crawlBatchIndex,
    auditId,
    workflowInstanceId,
    crawledBatch,
    pagesCrawled,
    visitedCount,
    queueLength,
    maxPages,
  } = params;
  // KV push + D1 progress in one step — merging them halves the per-batch
  // step count against the ~1k step budget. The D1 update is idempotent; the
  // KV push can duplicate entries on a partial retry, which is acceptable for
  // an ephemeral progress feed (capped list, short TTL).
  await pgStep(
    step,
    `progress-batch-${crawlBatchIndex}`,
    undefined,
    async () => {
      await AuditProgressKV.pushCrawledUrls(
        auditId,
        crawledBatch.map((pageResult) => ({
          url: pageResult.url,
          statusCode: pageResult.statusCode,
          title: pageResult.title,
          crawledAt: Date.now(),
        })),
      );
      await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
        pagesCrawled,
        pagesTotal: Math.min(visitedCount + queueLength, maxPages),
      });
    },
  );
}
