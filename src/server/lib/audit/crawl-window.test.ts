import type { CrawledPageResult } from "@/server/lib/audit/types";
import { describe, expect, it } from "vitest";
import {
  adjustCrawlWindow,
  clampCrawlWindow,
  CRAWL_WINDOW,
} from "@/server/lib/audit/crawl-window";

const PAGE_URL = "https://example.com/page";

/**
 * Minimal page fixture: the window only inspects fetch class, fetch time,
 * and how big the page's body was. Every variant is a complete
 * CrawledPageResult so tests cannot silently rely on missing fields.
 */
function page(over: Partial<CrawledPageResult>): CrawledPageResult {
  return {
    id: PAGE_URL,
    url: PAGE_URL,
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    retryAfter: null,
    redirectUrl: null,
    title: "Ok",
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
    links: [],
    hasStructuredData: false,
    structuredDataJson: null,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 200,
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

describe("clampCrawlWindow", () => {
  it("keeps the window inside [min, max]", () => {
    expect(clampCrawlWindow(0)).toBe(CRAWL_WINDOW.min);
    expect(clampCrawlWindow(1_000)).toBe(CRAWL_WINDOW.max);
    expect(clampCrawlWindow(10)).toBe(10);
  });
});

describe("adjustCrawlWindow", () => {
  it("changes nothing on an empty segment", () => {
    expect(adjustCrawlWindow(8, [])).toBe(8);
  });

  it("shrinks when a third of the segment is troubled", () => {
    const recent = [
      page({ fetchClass: "error" }),
      page({ fetchClass: "error" }),
      page({ fetchClass: "error" }),
      ...Array.from({ length: 6 }, () => page({})),
    ];
    expect(adjustCrawlWindow(8, recent)).toBe(4);
  });

  it("counts blocks and rate limits as trouble too", () => {
    const recent = [
      page({ fetchClass: "blocked" }),
      page({ fetchClass: "rate_limited" }),
      page({}),
    ];
    expect(adjustCrawlWindow(8, recent)).toBe(4);
  });

  it("never shrinks below two", () => {
    expect(adjustCrawlWindow(2, [page({ fetchClass: "error" })])).toBe(2);
  });

  it("treats ten-second responses as troubled and faster ones as clean", () => {
    expect(
      adjustCrawlWindow(8, [
        page({ responseTimeMs: 10_000 }),
        page({}),
        page({}),
      ]),
    ).toBe(4);
    expect(
      adjustCrawlWindow(8, [
        page({ responseTimeMs: 9_999 }),
        page({}),
        page({}),
      ]),
    ).toBe(8);
  });

  it("never grows beyond the byte budget of the observed page sizes", () => {
    // 25 x 16 MiB pages: growth alone would want 13, but the 48 MiB
    // in-flight budget over this page size only supports three slots.
    const recent = Array.from({ length: 25 }, () =>
      page({ htmlBytes: 16 * 1024 * 1024, responseTimeMs: 200 }),
    );
    expect(adjustCrawlWindow(8, recent)).toBe(3);
  });

  it("grows on a clean, mostly fast, full-size sample", () => {
    const recent = Array.from({ length: 25 }, () =>
      page({ responseTimeMs: 500 }),
    );
    expect(adjustCrawlWindow(8, recent)).toBe(13);
  });

  it("refuses growth until a full-size sample proves the site is fast", () => {
    const recent = Array.from({ length: 24 }, () =>
      page({ responseTimeMs: 500 }),
    );
    expect(adjustCrawlWindow(8, recent)).toBe(8);
  });

  it("does not shrink a mid-sized window that stays mostly clean", () => {
    const recent = [
      page({ fetchClass: "error" }),
      ...Array.from({ length: 11 }, () => page({})),
    ];
    expect(adjustCrawlWindow(12, recent)).toBe(12);
  });
});
