import type { WorkflowStep } from "cloudflare:workers";
import type { CrawledPageResult } from "@/server/lib/audit/types";
import type { RobotsResult } from "@/server/lib/audit/discovery";
import { describe, expect, it, vi } from "vitest";
import { runCrawlPhase } from "@/server/workflows/siteAuditWorkflowCrawl";

// In-memory KV stand-in: progress reads return null, writes are kept so a
// later read within the same mock sees them.
const kvStore = vi.hoisted(() => new Map<string, string>());
vi.mock("cloudflare:workers", () => ({
  env: {
    KV: {
      async get(key: string) {
        return kvStore.get(key) ?? null;
      },
      async put(key: string, value: string) {
        kvStore.set(key, value);
      },
      async delete(key: string) {
        kvStore.delete(key);
      },
    },
  },
}));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
// runCrawlPhase pre-warms the analyzer before its first batch; stub it so
// the import cost and real parsing stay out of these tests.
vi.mock("@/server/lib/audit/page-analyzer", () => ({
  analyzeHtml: () => {
    throw new Error("analyzer is not expected in the cancel-check tests");
  },
  classifyExtractionState: () => "STATIC_PARTIAL",
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {
    async updateAuditProgress() {
      return undefined;
    },
    async insertCrawledBatch() {
      return undefined;
    },
  },
}));
// No network in tests: every fetched page comes back as a clean 200 with
// two internal links so the frontier keeps rolling across iterations.
vi.mock("@/server/workflows/site-audit-workflow-helpers", () => ({
  crawlPageWithThrottle: async (
    _throttle: unknown,
    url: string,
  ): Promise<{ notFetched: false; result: CrawledPageResult }> => ({
    notFetched: false,
    result: {
      id: url,
      url,
      statusCode: 200,
      fetchClass: "ok",
      extractionState: "STATIC_COMPLETE",
      failureReason: null,
      retryAfter: null,
      redirectUrl: null,
      title: "Page",
      metaDescription: "",
      canonicalUrl: null,
      robotsMeta: null,
      xRobotsTag: null,
      headerCanonicalUrl: null,
      ogTitle: null,
      ogDescription: null,
      ogImage: null,
      h1Count: 1,
      h2Count: 0,
      h3Count: 0,
      h4Count: 0,
      h5Count: 0,
      h6Count: 0,
      headingOrder: [1],
      wordCount: 40,
      contentHash: null,
      htmlBytes: 64 * 1024,
      isHtml: true,
      imagesTotal: 0,
      imagesMissingAlt: 0,
      images: [],
      links: [
        {
          targetUrl: "https://example.com/discovered-a",
          anchor: "A",
          isInternal: true,
          isNofollow: false,
        },
        {
          targetUrl: "https://example.com/discovered-b",
          anchor: "B",
          isInternal: true,
          isNofollow: false,
        },
      ],
      hasStructuredData: false,
      structuredDataJson: null,
      hreflangTags: [],
      isIndexable: true,
      responseTimeMs: 10,
      platform: null,
      platformConfidence: 0,
      pageType: null,
      pageTypeConfidence: null,
      sallaExtractionJson: null,
      crawlDepth: 1,
      inSitemap: false,
    },
  }),
}));

const allowAll: RobotsResult = { isAllowed: () => true, sitemapUrls: [] };

describe("runCrawlPhase cancel check", () => {
  // The crawl phase only forwards the step to pgStep, which this suite
  // mocks, so a null stand-in is enough to drive the loop.
  const noStep = null! as WorkflowStep;
  const baseParams = {
    auditId: "audit-1",
    workflowInstanceId: "wf-1",
    origin: "https://example.com",
    startUrl: "https://example.com/",
    maxPages: 50,
    robots: allowAll,
    sitemapUrls: [],
  };

  it("stops before any fetch when the cancel flag is raised and reports an unexhausted frontier", async () => {
    const result = await runCrawlPhase(noStep, baseParams, {
      isCancelled: async () => true,
    });

    // Nothing was fetched, D8 holds: the seed page stays queued, not failed.
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.stoppedEarly).toBe(false);
    expect(result.pages).toEqual([]);
    expect(result.frontier.discovered).toBe(1);
    expect(result.frontier.remaining).toBe(1);
  });

  it("finalizes as cancelled when the flag is raised between batches", async () => {
    let cancelChecks = 0;
    const result = await runCrawlPhase(noStep, baseParams, {
      isCancelled: async () => {
        cancelChecks += 1;
        return cancelChecks > 1;
      },
    });

    // One clean page was fetched before the stop; its state stays intact
    // (D8) and the frontier reports what was never reached: the two URLs
    // the fetched page linked to stay queued.
    expect(result.cancelled).toBe(true);
    expect(result.completed).toBe(false);
    expect(result.pages).toHaveLength(1);
    expect(result.frontier.discovered).toBe(3);
    expect(result.frontier.remaining).toBe(2);
  });

  it("reports a non-cancelled run when no cancellation is requested", async () => {
    const result = await runCrawlPhase(noStep, baseParams, {
      isCancelled: async () => false,
    });

    // Seed + the two discovered a/b pages (whose re-discovered links
    // dedupe away), then the frontier drains and the run completes.
    expect(result.cancelled).toBe(false);
    expect(result.completed).toBe(true);
    expect(result.pages).toHaveLength(3);
    expect(result.frontier.discovered).toBe(3);
    expect(result.frontier.remaining).toBe(0);
  });
});
