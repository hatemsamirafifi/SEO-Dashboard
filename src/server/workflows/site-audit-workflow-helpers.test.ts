import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createCrawlThrottle } from "@/server/lib/audit/crawl-throttle";
import {
  crawlPage,
  crawlPageWithThrottle,
} from "@/server/workflows/site-audit-workflow-helpers";

const PAGE_URL = "https://example.com/page";
const PAGE_HTML =
  "<html><head><title>A page</title></head><body><h1>A page</h1></body></html>";

/**
 * Answer each fetch with the next reply, repeating the last one. Every call
 * builds a fresh Response: a body can only be read (or cancelled) once.
 */
function stubFetch(...replies: Array<{ status: number; retryAfter?: string }>) {
  let index = 0;
  return vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    const reply = replies[Math.min(index++, replies.length - 1)];
    return new Response(PAGE_HTML, {
      status: reply.status,
      headers: {
        "content-type": "text/html",
        ...(reply.retryAfter ? { "retry-after": reply.retryAfter } : {}),
      },
    });
  });
}

function crawl() {
  return crawlPageWithThrottle(
    createCrawlThrottle(Date.now() + 90_000),
    PAGE_URL,
  );
}

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("crawlPageWithThrottle", () => {
  it("waits out the server's Retry-After and keeps the retried page", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch(
      { status: 429, retryAfter: "5" },
      { status: 200 },
    );

    const promise = crawl();
    await vi.advanceTimersByTimeAsync(4_000);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(2_000);
    const entry = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(entry.notFetched).toBe(false);
    if (!entry.notFetched) {
      expect(entry.result.statusCode).toBe(200);
      expect(entry.result.fetchClass).toBe("ok");
      expect(entry.result.title).toBe("A page");
    }
  }, 30_000);

  it("records a page the site keeps rate limiting, without calling it blocked", async () => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter: "1" });

    const promise = crawl();
    await vi.advanceTimersByTimeAsync(30_000);
    const entry = await promise;

    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(entry.notFetched).toBe(false);
    if (!entry.notFetched) {
      expect(entry.result.fetchClass).toBe("rate_limited");
    }
  }, 30_000);

  // A long Retry-After is deferred to a later chunk; one past the audit's
  // whole cooldown budget is recorded as the page's final answer.
  it.each([
    ["defers the URL when its cooldown outlasts the chunk", "600", null],
    [
      "records a final 429 when the wait exceeds the cooldown budget",
      "3600",
      "rate_limited",
    ],
  ])("%s", async (_label, retryAfter, fetchClass) => {
    vi.useFakeTimers();
    const fetchMock = stubFetch({ status: 429, retryAfter });

    const promise = crawl();
    await vi.advanceTimersByTimeAsync(10_000);
    const entry = await promise;

    if (fetchClass === null) {
      expect(entry.notFetched).toBe(true);
    } else {
      expect(entry.notFetched).toBe(false);
      if (!entry.notFetched) expect(entry.result.fetchClass).toBe(fetchClass);
    }
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not retry a 403 — bot protection is not a speed limit", async () => {
    const fetchMock = stubFetch({ status: 403 });

    const entry = await crawl();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(entry.notFetched).toBe(false);
    if (!entry.notFetched) {
      expect(entry.result.fetchClass).toBe("blocked");
    }
  });

  it("preserves extracted metadata and nested values when releasing the HTML", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          `<html><head>
            <title>Example &amp; café 🌱</title>
            <meta name="description" content="Example description &amp; more">
            <meta name="robots" content="noindex">
            <meta property="og:title" content="Example social title 🌱">
            <meta property="og:description" content="Example description">
            <meta property="og:image" content="/social.png">
            <link rel="canonical" href="/canonical">
            <link rel="alternate" hreflang="en" href="/en">
            <script type="application/ld+json">{}</script>
          </head><body><h1>Hello</h1>
          <h2>World</h2>
          <p>${"Readable server-rendered content ".repeat(6)}</p>
            <img src="/photo.png" alt="Example photo 🌱"><img src="/missing.png">
            <img alt="">
            <a href="/next" rel="nofollow">More &amp; more 🌱</a>
            <a href="https://other.example/">External</a>
          </body></html>`,
          {
            headers: {
              "content-type": "text/html",
              "x-robots-tag": "nofollow",
              link: '<https://example.com/header>; rel="canonical"',
            },
          },
        ),
      ),
    );

    const page = await crawlPage("https://example.com/");

    expect(page).toMatchObject({
      url: "https://example.com/",
      statusCode: 200,
      fetchClass: "ok",
      extractionState: "STATIC_COMPLETE",
      redirectUrl: null,
      title: "Example & café 🌱",
      metaDescription: "Example description & more",
      canonicalUrl: "https://example.com/canonical",
      robotsMeta: "noindex",
      xRobotsTag: "nofollow",
      headerCanonicalUrl: "https://example.com/header",
      ogTitle: "Example social title 🌱",
      ogDescription: "Example description",
      ogImage: "/social.png",
      h1Count: 1,
      h1Text: "Hello",
      h2Count: 1,
      h3Count: 0,
      headingOrder: [1, 2],
      isHtml: true,
      imagesTotal: 3,
      imagesMissingAlt: 1,
      images: [
        { src: "/photo.png", alt: "Example photo 🌱" },
        { src: "/missing.png", alt: null },
        { src: null, alt: "" },
      ],
      links: [
        {
          targetUrl: "https://example.com/next",
          anchor: "More & more 🌱",
          isInternal: true,
          isNofollow: true,
        },
        {
          targetUrl: "https://other.example/",
          anchor: "External",
          isInternal: false,
          isNofollow: false,
        },
      ],
      hasStructuredData: true,
      structuredDataJson: "{}",
      hreflangTags: ["en"],
      isIndexable: false,
    });
    // Depth and sitemap membership are attached by the crawl pool, which
    // accepted each URL, not by the fetch helper itself.
    expect(page.crawlDepth).toBe(null);
    expect(page.inSitemap).toBe(false);
    expect(page.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(page.htmlBytes).toBeGreaterThan(0);
  });

  it("records a redirect hop as its own NOT_EXTRACTED row with its target", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockResolvedValue(
          new Response(null, { status: 301, headers: { location: "/docs/" } }),
        ),
    );

    const page = await crawlPage("https://example.com/docs");

    expect(page).toMatchObject({
      statusCode: 301,
      fetchClass: "ok",
      extractionState: "NOT_EXTRACTED",
      redirectUrl: "https://example.com/docs/",
      isHtml: false,
      links: [],
    });
  });

  it("records transport failures honestly with their failure reason", async () => {
    const timeoutError = new Error("aborted");
    timeoutError.name = "TimeoutError";
    vi.spyOn(globalThis, "fetch").mockRejectedValue(timeoutError);
    const timedOut = await crawlPage(PAGE_URL);
    expect(timedOut).toMatchObject({
      statusCode: 0,
      fetchClass: "error",
      extractionState: "EXTRACTION_FAILED",
      failureReason: "fetch_timeout",
    });

    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockRejectedValue(
      new TypeError("failed to fetch"),
    );
    const failed = await crawlPage(PAGE_URL);
    expect(failed).toMatchObject({
      statusCode: 0,
      fetchClass: "error",
      failureReason: "network_error",
    });
  });

  it("marks a truncated read as STATIC_PARTIAL instead of complete", async () => {
    // 2.5 MiB of real words: the head metadata fits in the read window,
    // the body tail does not.
    const words = "Readable server-rendered content ".repeat(80_000);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(`<html><body><p>${words}</p></body></html>`, {
          headers: { "content-type": "text/html" },
        }),
      ),
    );

    const page = await crawlPage(PAGE_URL);

    expect(page.extractionState).toBe("STATIC_PARTIAL");
    expect(page.htmlBytes).toBe(2 * 1024 * 1024);
  });
});

describe("crawlPage memory retention", () => {
  it("does not retain large source HTML in queued crawl results", () => {
    // A dedicated V8 process makes GC available without depending on the test
    // runner's heap. Exercise the real reader/parser with separate streamed
    // bodies; keeping just their titles used to retain every 1 MiB document.
    const result = spawnSync(
      process.execPath,
      [
        "--expose-gc",
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        `
          import assert from "node:assert/strict";
          import { crawlPage } from ${JSON.stringify(new URL("./site-audit-workflow-helpers.ts", import.meta.url).href)};
          const html = '<title>Example memory regression 🌱</title>' +
            '<meta name="description" content="A small description">' +
            '<script>' + 'x'.repeat(1024 * 1024) + '</script>';
          const bytes = new TextEncoder().encode(html);
          globalThis.fetch = async () => {
            // A fresh stream per call: each Response body may only be
            // consumed once, so one shared offset would feed page after
            // page an empty stream instead of the same document.
            let offset = 0;
            return new Response(new ReadableStream({
              pull(controller) {
                if (offset >= bytes.length) return controller.close();
                controller.enqueue(bytes.subarray(offset, offset + 65536));
                offset += 65536;
              },
            }), { headers: { "content-type": "text/html" } });
          };
          const collect = async () => {
            await new Promise(resolve => setTimeout(resolve, 0));
            globalThis.gc();
            globalThis.gc();
            const { heapUsed, external } = process.memoryUsage();
            return heapUsed + external;
          };
          await crawlPage("https://example.com/warmup");
          const before = await collect();
          const pages = [];
          for (let i = 0; i < 50; i++) {
            pages.push(await crawlPage("https://example.com/" + i));
          }
          const retained = (await collect()) - before;
          assert.equal(pages.length, 50);
          assert.equal(pages[49].title, "Example memory regression 🌱");
          assert.ok(retained < 16 * 1024 * 1024,
            "Queued results retained " + retained + " bytes of source HTML");
        `,
      ],
      // The child crawls 50 × 1 MiB documents in a dedicated V8 process; on a
      // loaded CI machine that comfortably outruns the default 20s, and a
      // timeout here reads as a false memory regression.
      { encoding: "utf8", timeout: 120_000 },
    );

    expect(result.error).toBeUndefined();
    expect(result.status, result.stderr).toBe(0);
  }, 150_000);
});
