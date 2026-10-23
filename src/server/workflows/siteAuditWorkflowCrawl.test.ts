import type { CrawledPageResult } from "@/server/lib/audit/types";
import type { RobotsResult } from "@/server/lib/audit/discovery";
import { describe, expect, it, vi } from "vitest";
import {
  buildPageSummaries,
  requeuePendingEntries,
  selectNextCrawlBatch,
} from "@/server/workflows/siteAuditWorkflowFrontier";

// The frontier helpers are pure; the mocks below only keep the workflow
// module graph importable (progress KV, pgStep, repository) without a DB.
vi.mock("cloudflare:workers", () => ({ env: { KV: {} } }));
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: (
    _step: unknown,
    _name: string,
    _config: unknown,
    fn: () => unknown,
  ) => fn(),
}));
vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: {},
}));

const allowAll: RobotsResult = { isAllowed: () => true, sitemapUrls: [] };
const disallowProducts: RobotsResult = {
  isAllowed: (url) => !url.startsWith("https://example.com/products"),
  sitemapUrls: [],
};

function page(over: Partial<CrawledPageResult>): CrawledPageResult {
  return {
    id: "https://example.com/page",
    url: "https://example.com/page",
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
    h1Text: null,
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
    links: [],
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
    crawlDepth: 0,
    inSitemap: false,
    ...over,
  };
}

type QueueEntry = { url: string; depth: number | null };

describe("selectNextCrawlBatch", () => {
  it("drains the link queue before sitemap-seeded URLs", () => {
    const linkQueue: QueueEntry[] = [
      { url: "https://example.com/b", depth: 1 },
    ];
    const sitemapQueue: QueueEntry[] = [
      { url: "https://example.com/a", depth: null },
    ];

    const batch = selectNextCrawlBatch({
      linkQueue,
      sitemapQueue,
      queued: new Set(),
      visited: new Set(),
      robots: allowAll,
      remaining: 10,
    });

    expect(batch.map((entry) => entry.url)).toEqual([
      "https://example.com/b",
      "https://example.com/a",
    ]);
  });

  it("skips robots-disallowed URLs without consuming batch slots", () => {
    const batch = selectNextCrawlBatch({
      linkQueue: [
        { url: "https://example.com/products/1", depth: 1 },
        { url: "https://example.com/about", depth: 1 },
      ],
      sitemapQueue: [],
      queued: new Set(),
      visited: new Set(),
      robots: disallowProducts,
      remaining: 10,
    });

    expect(batch.map((entry) => entry.url)).toEqual([
      "https://example.com/about",
    ]);
  });

  it("treats tracking-param variants as the same page across batches", () => {
    const visited = new Set<string>();
    const first = selectNextCrawlBatch({
      linkQueue: [{ url: "https://example.com/products?fbclid=abc", depth: 1 }],
      sitemapQueue: [],
      queued: new Set(),
      visited,
      robots: allowAll,
      remaining: 10,
    });
    expect(first.map((entry) => entry.url)).toEqual([
      "https://example.com/products?fbclid=abc",
    ]);
    // The visited mark is stored by dedup key (tracking params collapsed).
    const utmVariantKey = [...visited][0];
    expect(utmVariantKey).toContain("https://example.com/products");
    expect(utmVariantKey).not.toContain("fbclid");

    // The plain URL from a later batch collapses to the same key: skipped.
    const second = selectNextCrawlBatch({
      linkQueue: [{ url: "https://example.com/products", depth: 1 }],
      sitemapQueue: [],
      queued: new Set(),
      visited,
      robots: allowAll,
      remaining: 10,
    });
    expect(second).toEqual([]);
  });

  it("keeps pagination pages distinct from each other", () => {
    const batch = selectNextCrawlBatch({
      linkQueue: [
        { url: "https://example.com/blog?page=2", depth: 1 },
        { url: "https://example.com/blog?page=3", depth: 1 },
      ],
      sitemapQueue: [],
      queued: new Set(),
      visited: new Set(),
      robots: allowAll,
      remaining: 10,
    });

    expect(batch).toHaveLength(2);
  });

  it("caps the batch by the concurrency bound and remaining budget", () => {
    const linkQueue: QueueEntry[] = Array.from(
      { length: 30 },
      (_, i) => ({ url: `https://example.com/p/${i}`, depth: 1 }) as QueueEntry,
    );
    const batch = selectNextCrawlBatch({
      linkQueue,
      sitemapQueue: [],
      queued: new Set(),
      visited: new Set(),
      robots: allowAll,
      remaining: 3,
    });

    expect(batch).toHaveLength(3);
    expect(linkQueue).toHaveLength(27);
  });
});

describe("requeuePendingEntries", () => {
  it("restores untouched URLs to the front of their original queues in selection order", () => {
    const linkQueue: QueueEntry[] = [];
    const sitemapQueue: QueueEntry[] = [];
    const visited = new Set([
      "https://example.com/selected-1",
      "https://example.com/selected-2",
    ]);

    requeuePendingEntries({
      batchEntries: [
        { url: "https://example.com/selected-1", depth: 1 },
        { url: "https://example.com/selected-2", depth: null },
      ],
      entries: [
        { url: "https://example.com/selected-2", depth: null },
        { url: "https://example.com/selected-1", depth: 1 },
      ],
      visited,
      queued: new Set(),
      linkQueue,
      sitemapQueue,
    });

    // Selection order restored (selected-1 first), visited marks released,
    // and the sitemap-seeded entry went back to the sitemap queue.
    expect(linkQueue.map((entry) => entry.url)).toEqual([
      "https://example.com/selected-1",
    ]);
    expect(sitemapQueue.map((entry) => entry.url)).toEqual([
      "https://example.com/selected-2",
    ]);
    expect([...visited]).toEqual([]);
  });
});

describe("buildPageSummaries", () => {
  it("keeps frontier candidates internal, deduped, minus known pages", () => {
    const visited = new Set(["https://example.com/nav"]);
    const queued = new Set(["https://example.com/queued"]);
    const pages = [
      page({
        id: "p1",
        url: "https://example.com/one",
        links: [
          {
            targetUrl: "https://example.com/nav?utm_source=x",
            anchor: "Nav",
            isInternal: true,
            isNofollow: false,
          },
          {
            targetUrl: "https://example.com/queued",
            anchor: "Queued",
            isInternal: true,
            isNofollow: false,
          },
          {
            targetUrl: "https://example.com/target-1",
            anchor: "Target 1",
            isInternal: true,
            isNofollow: false,
          },
          {
            targetUrl: "https://external.example.com/",
            anchor: "External",
            isInternal: false,
            isNofollow: false,
          },
        ],
      }),
    ];

    const summaries = buildPageSummaries(pages, visited, queued);

    expect(summaries).toHaveLength(1);
    // utm variant of the visited nav collapses to the same dedup key and is
    // excluded; queued and external targets are excluded too.
    expect(summaries[0].internalLinks).toEqual([
      "https://example.com/target-1",
    ]);
  });

  it("dedupes repeated targets across pages in the same batch", () => {
    const linked = (id: string): CrawledPageResult =>
      page({
        id,
        url: `https://example.com/${id}`,
        links: [
          {
            targetUrl: "https://example.com/shared-target",
            anchor: "Same",
            isInternal: true,
            isNofollow: false,
          },
        ],
      });

    const summaries = buildPageSummaries(
      [linked("a"), linked("b")],
      new Set(),
      new Set(),
    );

    expect(summaries[0].internalLinks).toEqual([
      "https://example.com/shared-target",
    ]);
    expect(summaries[1].internalLinks).toEqual([]);
  });

  it("truncates summary titles to the durable-state cap", () => {
    const summaries = buildPageSummaries(
      [page({ id: "p", url: "https://example.com/p", title: "x".repeat(500) })],
      new Set(),
      new Set(),
    );
    expect(summaries[0].title).toHaveLength(300);
  });
});
