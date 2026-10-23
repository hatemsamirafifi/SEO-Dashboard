import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  analyzeHtml,
  classifyExtractionState,
} from "@/server/lib/audit/page-analyzer";
import { parseSallaExtractionJson } from "@/server/lib/audit/salla/extraction";

const PAGE_URL = "https://example.com/blog/post";

// Structured-data assertions read the persisted JSON through a schema so
// the test never asserts on an `any` value.
const structuredBlockSchema = z.object({
  "@type": z.string().optional(),
  truncated: z.boolean().optional(),
});

describe("analyzeHtml", () => {
  it("extracts key data from a full, well-formed document", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <title>Example &amp; café 🌱</title>
        <meta name="description" content="Example description &amp; more">
        <meta name="robots" content="noindex">
        <meta property="og:title" content="Example social title 🌱">
        <meta property="og:image" content="/social.png">
        <link rel="canonical" href="/canonical">
        <link rel="alternate" hreflang="en" href="/en">
        <link rel="alternate" hreflang="fr" href="/fr">
        <script type="application/ld+json">{}</script>
      </head><body><h1>Hello</h1>
      <h2>World</h2>
        <img src="/photo.png" alt="Example photo 🌱"><img src="/missing.png">
        <img alt="">
        <a href="/next" rel="NOFOLLOW">More &amp; more</a>
        <a href="/next">Duplicate target</a>
        <a href="https://other.example/">External</a>
        <a href="#section">Anchor</a>
        <a href="mailto:hi@example.com">Mail</a>
      </body></html>`,
      PAGE_URL,
      200,
      123,
    );

    expect(analysis.title).toBe("Example & café 🌱");
    expect(analysis.metaDescription).toBe("Example description & more");
    expect(analysis.robotsMeta).toBe("noindex");
    expect(analysis.ogTitle).toBe("Example social title 🌱");
    expect(analysis.canonical).toBe("/canonical");
    expect(analysis.h1s).toEqual(["Hello"]);
    expect(analysis.headingOrder).toEqual([1, 2]);
    expect(analysis.wordCount).toBe(10);
    expect(analysis.images).toEqual([
      { src: "/photo.png", alt: "Example photo 🌱" },
      { src: "/missing.png", alt: null },
      { src: null, alt: "" },
    ]);
    expect(analysis.links).toEqual([
      {
        targetUrl: "https://example.com/next",
        anchor: "More & more",
        isInternal: true,
        isNofollow: true,
      },
      {
        targetUrl: "https://other.example/",
        anchor: "External",
        isInternal: false,
        isNofollow: false,
      },
    ]);
    expect(analysis.hasStructuredData).toBe(true);
    expect(analysis.structuredDataJson).toBe("{}");
    expect(analysis.hreflangTags).toEqual(["en", "fr"]);
    // The URL rhyme is the only page-type evidence this document shows, so
    // the D11 rule keeps the type unclassified.
    expect(analysis.pageType).toBeNull();
    expect(analysis.pageTypeConfidence).toBeNull();
    expect(analysis.ogType).toBeNull();
    // Passthrough fields are echoes of what the caller already knows.
    expect(analysis.statusCode).toBe(200);
    expect(analysis.responseTimeMs).toBe(123);
  });

  it("classifies a product page from layered evidence", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <title>Silk Pillow — Example</title>
        <meta property="og:type" content="product">
        <script type="application/ld+json">{"@context":"https://schema.org","@type":"Product"}</script>
      </head><body>
        <h1>Silk Pillow</h1>
        <button data-add-to-cart>Add to cart</button>
        <a href="/product/silk-pillow-case">Case</a>
      </body></html>`,
      "https://example.com/product/silk-pillow",
      200,
      42,
    );

    expect(analysis.ogType).toBe("product");
    expect(analysis.pageType).toBe("product");
    // JSON-LD 0.6 + og 0.3 + URL 0.3 (+ DOM) = capped.
    expect(analysis.pageTypeConfidence).toBe(0.95);
    // The product page also carries the adapter extraction payload.
    expect(analysis.sallaExtractionJson).not.toBeNull();
    const parsed = parseSallaExtractionJson(analysis.sallaExtractionJson);
    expect(parsed?.kind).toBe("product");
    expect(parsed?.kind === "product" ? parsed.availability.value : null).toBe(
      "UNKNOWN",
    );
    // Versus: the bare @type carries no offers, so no price evidence exists.
    expect(parsed?.kind === "product" ? parsed.price : null).toBeNull();
  });

  it("classifies an Arabic storefront product page from DOM affordances", () => {
    const analysis = analyzeHtml(
      `<html><body>
        <h1>وسادة حرير</h1>
        <form action="/cart">
          <button type="submit">أضف إلى السلة</button>
        </form>
      </body></html>`,
      "https://example.com/product/10545",
      200,
      42,
    );

    // URL rhyme (0.3) + Arabic add-to-cart affordance (0.4) combine.
    expect(analysis.pageType).toBe("product");
    expect(analysis.pageTypeConfidence).toBe(0.7);
    // Extraction also runs on DOM-affordance-classified pages and answers
    // honestly: the button is enabled and no stock text exists.
    const parsed = parseSallaExtractionJson(analysis.sallaExtractionJson);
    expect(parsed?.kind).toBe("product");
    expect(parsed?.kind === "product" ? parsed.availability : null).toEqual({
      value: "UNKNOWN",
      from: null,
    });
    expect(parsed?.kind === "product" ? parsed.name : null).toEqual({
      value: "وسادة حرير",
      from: "html",
    });
  });

  it("persists category extraction with the page's member-product links", () => {
    const analysis = analyzeHtml(
      `<html><body>
        <h1>Classic Rugs</h1>
        <a href="/product/rug-a-21">A</a>
        <a href="/product/rug-b-22">B</a>
        <a href="/product/rug-c-23">C</a>
        <a href="/blog/rug-care">Care</a>
      </body></html>`,
      "https://example.com/collections/rugs",
      200,
      42,
    );

    expect(analysis.pageType).toBe("category");
    const parsed = parseSallaExtractionJson(analysis.sallaExtractionJson);
    const memberUrls =
      parsed?.kind === "category"
        ? parsed.memberProductUrls.map((member) => member.url).toSorted()
        : [];
    expect(memberUrls).toEqual([
      "https://example.com/product/rug-a-21",
      "https://example.com/product/rug-b-22",
      "https://example.com/product/rug-c-23",
    ]);
  });

  it("leaves extraction null on pages that did not classify", () => {
    const analysis = analyzeHtml(
      `<html><body><h1>About us</h1></body></html>`,
      "https://example.com/about",
      200,
      0,
    );
    expect(analysis.pageType).toBeNull();
    expect(analysis.sallaExtractionJson).toBeNull();
  });

  it("harvests <link rel=next> as a Pagination continuation without clobbering body anchors", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <title>Blog</title>
        <link rel="next" href="/blog?page=3">
        <link rel="alternate" hreflang="en" href="/en/blog?page=3">
      </head><body>
        <a href="/blog?page=2">Prev page</a>
      </body></html>`,
      PAGE_URL,
      200,
      0,
    );

    const targets = analysis.links.map((link) => link.targetUrl);
    // Head rel=next becomes a link so the frontier follows the sequence;
    // hreflang alternates are NOT harvested as links.
    expect(targets).toContain("https://example.com/blog?page=3");
    expect(targets).not.toContain("https://example.com/en/blog?page=3");
    const relNext = analysis.links.find(
      (link) => link.targetUrl === "https://example.com/blog?page=3",
    );
    expect(relNext?.anchor).toBeNull();
    expect(relNext?.isInternal).toBe(true);
  });

  it("reads meta names case-insensitively and keeps the first duplicate", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <meta name="Description" content="one two">
        <meta name="description" content="never">
        <meta NAME="ROBOTS" CONTENT="NOINDEX">
      </head><body></body></html>`,
      PAGE_URL,
      200,
      0,
    );
    expect(analysis.metaDescription).toBe("one two");
    expect(analysis.robotsMeta).toBe("NOINDEX");
  });

  it("does not lose the title on a headless fragment", () => {
    expect(analyzeHtml("<p>Only body</p>", PAGE_URL, 200, 0).title).toBe("");
  });

  it("keeps parsing through unclosed and misnested tags", () => {
    const analysis = analyzeHtml(
      "<title>Broken-ish document</title><h1>Head<h2>Sub</h2><p>And even more words keep coming right here</p>",
      PAGE_URL,
      200,
      0,
    );
    expect(analysis.title).toBe("Broken-ish document");
    expect(analysis.headingOrder).toEqual([1, 2]);
  });

  it("merges several JSON-LD blocks into one @graph payload", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <script type="application/ld+json">{"a":1}</script>
        <script type="application/ld+json">{"b":2}</script>
      </head></html>`,
      PAGE_URL,
      200,
      0,
    );
    expect(JSON.parse(analysis.structuredDataJson ?? "null")).toEqual({
      "@graph": [{ a: 1 }, { b: 2 }],
    });
  });

  it("tolerates an unparseable JSON-LD block next to a good one", () => {
    const analysis = analyzeHtml(
      `<html><head>
        <script type="application/ld+json">{"nope":</script>
        <script type="application/ld+json">{"good":true}</script>
      </head></html>`,
      PAGE_URL,
      200,
      0,
    );
    expect(JSON.parse(analysis.structuredDataJson ?? "null")).toEqual({
      good: true,
    });
  });

  it("keeps an oversized JSON-LD block valid but truncated", () => {
    const oversized = JSON.stringify({
      "@type": "Thing",
      text: "x".repeat(45_000),
    });
    const analysis = analyzeHtml(
      `<html><head>
        <script type="application/ld+json">${oversized}</script>
      </head></html>`,
      PAGE_URL,
      200,
      0,
    );
    const parsed = structuredBlockSchema.safeParse(
      JSON.parse(analysis.structuredDataJson ?? "null"),
    );
    expect(parsed.success ? parsed.data["@type"] : null).toBe("Thing");
    expect(parsed.success ? parsed.data.truncated : null).toBe(true);
    expect(analysis.structuredDataJson?.length).toBeLessThanOrEqual(40_000);
  });

  it("stops accumulating JSON-LD once the payload cap is reached", () => {
    // 39_986 chars of payload text serialize to ~39_994 bytes: adding the
    // next 9-byte block would push the payload over the cap, so the cap
    // drops it whole instead of merging partially.
    const big = JSON.stringify({ a: "x".repeat(39_986) });
    const small = JSON.stringify({ b: 1 });
    expect(big.length).toBe(39_994);
    const analysis = analyzeHtml(
      `<html><head>
        <script type="application/ld+json">${big}</script>
        <script type="application/ld+json">${small}</script>
      </head></html>`,
      PAGE_URL,
      200,
      0,
    );
    // The final payload is still the single first block, unmerged.
    expect(JSON.parse(analysis.structuredDataJson ?? "null")).toEqual({
      a: "x".repeat(39_986),
    });
  });

  it("records the ld+json presence flag even when no block parses", () => {
    const analysis = analyzeHtml(
      `<html><head><script type="application/ld+json">{"broken":</script></head></html>`,
      PAGE_URL,
      200,
      0,
    );
    expect(analysis.hasStructuredData).toBe(true);
    expect(analysis.structuredDataJson).toBe(null);
  });
});

describe("classifyExtractionState", () => {
  it.each([
    '<div id="root"><h2>A server-rendered heading</h2></div><script src="/app.js"></script>',
    '<div id="root"><a href="/about">About</a></div><script src="/app.js"></script>',
    '<div id="app"><img src="/photo.png"></div><script src="/app.js"></script>',
    '<div id="root"></div><script type="application/ld+json">{}</script>',
    '<p>Short but valid content</p><script src="/analytics.js"></script>',
    '<div id="root"></div>',
    `<div id="root">${"Readable server-rendered content ".repeat(10)}</div><script src="/app.js"></script>`,
  ])(
    "does not confuse ordinary HTML, hydrated content, or structured data with a shell",
    (html) => {
      const analysis = analyzeHtml(html, PAGE_URL, 200, 0);
      expect(classifyExtractionState(html, analysis)).not.toBe(
        "RENDERING_REQUIRED",
      );
    },
  );

  it.concurrent.each([
    '<div id="root"></div><script src="/app.js"></script>',
    '<div id="app"></div><script type="module" src="/app.js"></script>',
    '<main id="root"></main><script src="/app.js"></script>',
    '<app-root></app-root><script type="module" src="/main.js"></script>',
    "<script>window.__NEXT_DATA__ = {};</script>",
    "<div data-reactroot></div>",
    "<script>__APOLLO_STATE__</script>",
  ])(
    "treats an empty CSR root plus a bootstrap (or inline state) as a shell: %s",
    (html) => {
      expect(classifyExtractionState(html, { wordCount: 0 })).toBe(
        "RENDERING_REQUIRED",
      );
    },
  );

  it("does not mistake a bare empty root div or an ld+json script for a shell", () => {
    expect(
      classifyExtractionState('<div id="root"></div>', { wordCount: 0 }),
    ).toBe("STATIC_PARTIAL");
    expect(
      classifyExtractionState(
        '<div id="root"></div><script type="application/ld+json">{}</script>',
        { wordCount: 0 },
      ),
    ).toBe("STATIC_PARTIAL");
  });

  it("classifies twenty-plus words of visible text as complete", () => {
    const analysis = analyzeHtml(
      `<body>${"Readable server-rendered content ".repeat(10)}</body>`,
      PAGE_URL,
      200,
      0,
    );
    expect(classifyExtractionState(analysis.bodyText, analysis)).toBe(
      "STATIC_COMPLETE",
    );
  });

  it("classifies an under-twenty-word page without any marker as partial", () => {
    const analysis = analyzeHtml(
      "<body><p>One two three four five</p></body>",
      PAGE_URL,
      200,
      0,
    );
    expect(classifyExtractionState(analysis.bodyText, analysis)).toBe(
      "STATIC_PARTIAL",
    );
  });
});
