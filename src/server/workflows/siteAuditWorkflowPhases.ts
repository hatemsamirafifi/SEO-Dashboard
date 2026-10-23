import type { WorkflowStep } from "cloudflare:workers";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import {
  discoverUrls,
  parseRobotsTxt,
  type DiscoveryCoverage,
} from "@/server/lib/audit/discovery";
import {
  fetchAndStoreLighthouseResult,
  selectLighthouseSample,
} from "@/server/lib/audit/lighthouse";
import { getOrigin } from "@/server/lib/audit/url-utils";
import {
  hasCoverageDeficit,
  extractionCompleteRatio,
  resolveFinalStatus,
} from "@/server/lib/audit/finalize";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import { AuditProgressKV } from "@/server/lib/audit/progress-kv";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";
import type { AuditConfig } from "@/server/lib/audit/types";
import { captureServerEvent } from "@/server/lib/posthog";
import {
  runCrawlPhase,
  type CrawledPageSummary,
  type CrawlPhaseResult,
} from "@/server/workflows/siteAuditWorkflowCrawl";
import { pgStep } from "@/server/workflows/pgStep";

const LIGHTHOUSE_URL_BATCH_SIZE = 10;

// Workflows rejects step outputs over 1MiB; keep the sitemap seed list well
// under that. The crawl visits at most maxPages URLs, so extra seeds are moot.
//
// Phase 3 cap review: 768KiB stays below the 1MiB step limit with room
// for the step envelope, and the seeds are also mirrored into KV (same
// 1MiB value ceiling) — the budget covers both.
const SITEMAP_SEED_BYTE_BUDGET = 768 * 1024;

function capSitemapSeeds(urls: string[], maxPages: number): string[] {
  const seeds: string[] = [];
  let bytes = 0;
  for (const url of urls) {
    if (seeds.length >= maxPages) break;
    bytes += url.length + 3; // JSON quotes + comma
    if (bytes > SITEMAP_SEED_BYTE_BUDGET) break;
    seeds.push(url);
  }
  return seeds;
}

type AuditPhasesParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
};

export async function runAuditPhases(
  step: WorkflowStep,
  params: AuditPhasesParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
  } = params;
  const origin = getOrigin(startUrl);
  const maxPages = config.maxPages;

  const discovery = await runDiscoveryPhase(
    step,
    auditId,
    workflowInstanceId,
    origin,
    maxPages,
  );
  // Parsed outside the step from checkpointed text, so replays see the exact
  // robots rules the original run used (a live re-fetch could differ and
  // desync the frontier from already-persisted crawl batches).
  const robots = parseRobotsTxt(origin, discovery.robotsText);
  const crawl = await runCrawlPhase(step, {
    auditId,
    workflowInstanceId,
    origin,
    startUrl,
    maxPages,
    robots,
    sitemapUrls: discovery.sitemapUrls,
  });

  // Re-check the cancel flag after the crawl loop: a user may have pressed
  // stop while the last batch ran; that intent must win even when the crawl
  // actually managed to drain its queue in the meantime.
  const cancelRequested =
    crawl.cancelled ||
    (await AuditRepository.getAuditCancelFlag(auditId).catch(() => false));

  if (!cancelRequested) {
    await runLighthousePhase(step, {
      auditId,
      workflowInstanceId,
      billingCustomer,
      projectId,
      startUrl,
      config,
      pages: crawl.pages,
    });
  }

  await finalizeAudit({
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
    coverage: discovery.coverage,
    cancelRequested,
  });
}

async function runDiscoveryPhase(
  step: WorkflowStep,
  auditId: string,
  workflowInstanceId: string,
  origin: string,
  maxPages: number,
) {
  return pgStep(step, "discover-urls", undefined, async () => {
    const result = await discoverUrls(origin, maxPages);
    // Full sitemap membership lives in KV (not step state — the ~1MiB
    // Workflows limit only affords frontier-capped seeds): a sitemap URL the
    // crawl later reaches by link still reports inSitemap=true, even past
    // the seed cap. Idempotent put, safe on step replay.
    await AuditProgressKV.saveSitemapMembership(auditId, {
      urls: result.urls,
      coverage: result.coverage,
    });
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      pagesTotal: Math.min(result.coverage.urlsFromSitemaps + 1, maxPages),
      currentPhase: "crawling",
    });
    return {
      sitemapUrls: capSitemapSeeds(result.urls, maxPages),
      robotsText: result.robotsText,
      coverage: result.coverage,
    };
  });
}

type LighthousePhaseParams = {
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  pages: CrawledPageSummary[];
};

async function runLighthousePhase(
  step: WorkflowStep,
  params: LighthousePhaseParams,
) {
  const {
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    pages,
  } = params;
  if (config.lighthouseStrategy === "none") return;

  const lighthouseWork = await selectLighthousePages({
    step,
    auditId,
    workflowInstanceId,
    pages,
    startUrl,
    strategy: config.lighthouseStrategy,
  });

  let completedChecks = 0;
  let failedChecks = 0;
  let lighthouseBatchIndex = 0;

  for (let i = 0; i < lighthouseWork.length; i += LIGHTHOUSE_URL_BATCH_SIZE) {
    const batch = lighthouseWork.slice(i, i + LIGHTHOUSE_URL_BATCH_SIZE);
    lighthouseBatchIndex += 1;
    const priorCompleted = completedChecks;
    const priorFailed = failedChecks;

    // Fetch, store (R2 + D1) and update progress inside one step. The step
    // returns only counts; full results live in D1.
    const counts = await pgStep(
      step,
      `lighthouse-batch-${lighthouseBatchIndex}`,
      undefined,
      async () => {
        const perUrlResults = await Promise.all(
          batch.map(async ({ url, pageId }) => {
            const [mobileResult, desktopResult] = await Promise.all([
              fetchAndStoreLighthouseResult({
                url,
                pageId,
                strategy: "mobile",
                billingCustomer,
                projectId,
                auditId,
              }),
              fetchAndStoreLighthouseResult({
                url,
                pageId,
                strategy: "desktop",
                billingCustomer,
                projectId,
                auditId,
              }),
            ]);
            return [mobileResult, desktopResult];
          }),
        );
        const results = perUrlResults.flat();
        await AuditRepository.insertLighthouseResults(auditId, results);

        const failed = results.filter((result) => result.errorMessage).length;
        const completed = results.length - failed;
        await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
          lighthouseCompleted: priorCompleted + completed,
          lighthouseFailed: priorFailed + failed,
        });
        return { completed, failed };
      },
    );

    completedChecks += counts.completed;
    failedChecks += counts.failed;
  }
}

async function selectLighthousePages(params: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  pages: CrawledPageSummary[];
  startUrl: string;
  strategy: AuditConfig["lighthouseStrategy"];
}) {
  const { step, auditId, workflowInstanceId, pages, startUrl, strategy } =
    params;
  return pgStep(step, "select-lighthouse-sample", undefined, async () => {
    const sample = selectLighthouseSample(pages, startUrl, strategy);
    const selectedUrls = new Set(sample);

    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "lighthouse",
      lighthouseTotal: sample.length * 2,
      lighthouseCompleted: 0,
      lighthouseFailed: 0,
    });
    return pages.flatMap((page) =>
      selectedUrls.has(page.url) ? [{ url: page.url, pageId: page.id }] : [],
    );
  });
}

async function finalizeAudit(args: {
  step: WorkflowStep;
  auditId: string;
  workflowInstanceId: string;
  billingCustomer: BillingCustomerContext;
  projectId: string;
  startUrl: string;
  config: AuditConfig;
  crawl: CrawlPhaseResult;
  coverage: DiscoveryCoverage;
  cancelRequested: boolean;
}) {
  const {
    step,
    auditId,
    workflowInstanceId,
    billingCustomer,
    projectId,
    startUrl,
    config,
    crawl,
    coverage,
    cancelRequested,
  } = args;

  await pgStep(step, "multipage-checks", undefined, async () => {
    await AuditRepository.updateAuditProgress(auditId, workflowInstanceId, {
      currentPhase: "finalizing",
    });

    // Integrity guard: pages are persisted inside crawl-batch steps. If the
    // crawl claims pages but D1 has none (e.g. an instance started under the
    // pre-incremental-persistence code was replayed under this code), fail
    // loudly instead of completing with an empty audit.
    if (
      crawl.pages.length > 0 &&
      !(await AuditRepository.hasPagesForAudit(auditId))
    ) {
      throw new Error(
        `Audit ${auditId}: crawl reported ${crawl.pages.length} pages but none were persisted`,
      );
    }

    const issues = await runMultipageChecks({
      auditId,
      startUrl,
      crawlCompleted: crawl.completed,
    });
    await AuditRepository.insertIssues(auditId, issues);
    return { issueCount: issues.length };
  });

  await pgStep(step, "finalize", undefined, async () => {
    // Counters come from the persisted page rows (SQL aggregation) so they
    // reconcile exactly with what readers can see; urls_discovered comes
    // from the frontier set accounting, which additionally covers URLs the
    // crawl queued but never fetched.
    const pages = await AuditRepository.getAuditPageCounters(auditId);
    const counters = {
      ...pages,
      urlsDiscovered: Math.max(pages.urlsFetched, crawl.frontier.discovered),
    };
    const frontierRemaining = Math.max(
      0,
      counters.urlsDiscovered - counters.urlsFetched,
    );
    const status = resolveFinalStatus({
      cancelRequested,
      deficit: hasCoverageDeficit({ counters, frontierRemaining }),
    });

    await AuditRepository.finalizeAuditRun(auditId, workflowInstanceId, {
      status,
      counters,
    });
    await captureServerEvent({
      distinctId: billingCustomer.userId,
      event: "site_audit:complete",
      organizationId: billingCustomer.organizationId,
      properties: {
        project_id: projectId,
        status,
        pages_crawled: counters.urlsFetched,
        pages_total: counters.urlsFetched,
        run_lighthouse: config.lighthouseStrategy !== "none",
        urls_discovered: counters.urlsDiscovered,
        urls_blocked: counters.urlsBlocked,
        urls_failed: counters.urlsFailed,
        urls_skipped: counters.urlsSkipped,
        urls_rendering_required: counters.urlsRenderingRequired,
        urls_not_crawled: frontierRemaining,
        extraction_complete_count: counters.urlsExtractionComplete,
        extraction_complete_ratio: extractionCompleteRatio(counters),
        crawl_stopped_early: crawl.stoppedEarly,
        // Discovery coverage ledger (crawl-quality metrics feed)
        robots_declared_sitemaps: coverage.robotsDeclaredSitemaps,
        sitemap_docs_fetched: coverage.sitemapDocsFetched,
        sitemap_docs_failed: coverage.sitemapDocsFailed,
        sitemap_urls_discovered: coverage.urlsFromSitemaps,
        sitemap_doc_cap_reached: coverage.sitemapDocCapReached,
        discovery_url_cap_reached: coverage.urlCapReached,
      },
    });
    await AuditProgressKV.clear(auditId);
  });
}
