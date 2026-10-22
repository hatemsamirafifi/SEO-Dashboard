import type { Fixture } from "./types";
import { lorem, htmlResponse, renderPage } from "../lib";
import { article } from "./helpers";
import { CAT, productCard, sallaHeadExtra } from "./sallaShared";

// Salla is the dominant Saudi e-commerce platform. These fixtures reproduce
// the shapes a Salla-hosted store serves: a readable product page, a sparse
// category grid, query-param pagination that canonicalizes, a
// client-side-rendered storefront shell, and a bot-mitigation challenge
// served with a healthy 200. Platform evidence echoes what the audit's
// detector looks for: the generator meta, the Salla asset host, and the
// Salla JS SDK usage.
//
// Word counts here are load-bearing: classification (STATIC_COMPLETE vs
// RENDERING_REQUIRED) and thin-content both key off the word count, so keep
// them deliberate when editing.

// 1 — healthy product page -------------------------------------------------

const productPage: Fixture = {
  path: "/salla/product/desk-lamp",
  category: CAT,
  name: "Salla: healthy product page",
  summary:
    "A Salla-hosted product page that the static crawler should read cleanly.",
  lesson:
    "Salla storefront pages carry the platform's generator meta and SDK script. The audit detects the platform, then the same generic extraction rules read the product content.",
  expectedIssues: [],
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: productPage,
        title: "Desk Lamp with Adjustable Brightness",
        metaDescription:
          "A Salla product page extracts cleanly with the static crawler: name, price, availability, and a self-canonical.",
        canonical: `${ctx.origin}/salla/product/desk-lamp`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Desk Lamp","image":"${ctx.origin}/img/placeholder.svg","description":"Adjustable desk lamp","sku":"DL-01","brand":{"@type":"Brand","name":"Store"},"offers":{"@type":"Offer","price":"199.00","priceCurrency":"SAR","availability":"https://schema.org/InStock"}}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/electronics">Electronics</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Desk Lamp with Adjustable Brightness",
  lede: "A Salla-hosted shopping page that every SEO check should read as healthy.",
  sections: [
    {
      h2: "Why this product page is healthy",
      body: lorem(60),
    },
    {
      h2: "What the platform detector sees",
      body: lorem(55),
    },
  ],
})}`,
      }),
    ),
};

// 2 — category page: thin grid, with a ?page=2 sibling ----------------------
const categoryPage: Fixture = {
  path: "/salla/category/electronics",
  category: CAT,
  name: "Salla: thin category grid",
  summary:
    "A product-listing page whose only text is product names and prices.",
  lesson:
    "Category grids with nothing but repeated product tiles are thin content: the audit should say so and encourage descriptive category copy.",
  expectedIssues: ["thin-content"],
  handler: (ctx) => {
    // Salla pagination lives on ?page=N query URLs, which share the category
    // pathname. Serve the paginated variant from the same route.
    const page = new URL(ctx.request.url).searchParams.get("page");
    if (page === "2") {
      return htmlResponse(
        renderPage({
          fixture: categoryPage,
          title: "Electronics store - Page 2",
          metaDescription:
            "The second page of the electronics category, canonicalized to the category's base URL the way Salla pagination does.",
          canonical: `${ctx.origin}/salla/category/electronics`,
          headExtra: sallaHeadExtra(),
          bodyHtml: article({
            h1: "Electronics",
            lede: "The category copy gives page two enough words that the canonical verdict is the only finding.",
            sections: [
              { h2: "More of the same catalog", body: lorem(65) },
              { h2: "Why pagination still matters", body: lorem(60) },
            ],
          }),
        }),
      );
    }
    return htmlResponse(
      renderPage({
        fixture: categoryPage,
        title: "Electronics in a Salla Store",
        metaDescription:
          "A Salla category page with a product grid but no descriptive copy, so the category ranks on thin content.",
        canonical: `${ctx.origin}/salla/category/electronics`,
        headExtra: sallaHeadExtra(),
        showPanel: false,
        bodyHtml: `
<h1>Electronics</h1>
<div class="grid">
${productCard("/salla/product/desk-lamp", "LED Desk Lamp", "199")}
${productCard("/salla/product/desk-lamp", "Table Lamp", "249")}
${productCard("/salla/product/desk-lamp", "Floor Lamp", "349")}
${productCard("/salla/product/desk-lamp", "Bedside Lamp", "99")}
</div>
<p class="next"><a href="/salla/category/electronics?page=2">Page 2</a></p>`,
      }),
    );
  },
};

// 3 — client-side rendered storefront shell ---------------------------------
const csrShelf: Fixture = {
  path: "/salla/csr/store-home",
  category: CAT,
  name: "Salla: client-rendered storefront",
  summary:
    "Serves an empty render root plus the Salla SDK: content arrives only in JavaScript.",
  lesson:
    "When a page ships an empty shell, the audit cannot read real content, so it must not invent SEO verdicts. The page is marked extraction-uncertain and stays free of confirmed missing-* findings.",
  expectedIssues: [],
  linkedFromCatalog: false,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: csrShelf,
        title: "Store loading in the browser",
        metaDescription:
          "A Salla storefront whose product content is injected by JavaScript on the client.",
        headExtra: sallaHeadExtra(),
        showPanel: false,
        bodyHtml: `<div id="root"></div>
<a href="/status/csr-shell">CSR shell</a>`,
      }),
    ),
};

// 4 — healthy blog post -----------------------------------------------------
const blogPost: Fixture = {
  path: "/salla/blog/state-of-storefronts",
  category: CAT,
  name: "Salla: healthy blog post",
  summary:
    "A Salla-hosted blog article with Article JSON-LD, hreflang alternates, and a self-canonical.",
  lesson:
    "Blogging lives on the platform too. The audit treats a platform-hosted blog with the same generic extraction rules as any other page.",
  expectedIssues: [],
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: blogPost,
        title: "State of Storefronts in 2026",
        metaDescription:
          "A Salla blog post that extracts cleanly: headings, article JSON-LD, hreflang alternates, and a self-canonical.",
        canonical: `${ctx.origin}/salla/blog/state-of-storefronts`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"BlogPosting","headline":"State of Storefronts in 2026","inLanguage":"en"}</script>`,
        bodyHtml:
          article({
            h1: "State of Storefronts in 2026",
            lede: "What hosted storefront platforms changed this year.",
            sections: [
              {
                h2: "Static extraction is the default path",
                body: lorem(70),
              },
              {
                h2: "Where rendering still matters",
                body: lorem(65),
              },
            ],
          }) + `\n<p><a href="/salla/csr/store-home">Store home</a></p>`,
      }),
    ),
};

// 5 — a bot-mitigation challenge served with a 200 ---------------------------
const challengePage: Fixture = {
  path: "/salla/challenge/warehouse-locked",
  category: CAT,
  name: "Salla: challenge page with a 200 status",
  summary:
    'Returns 200 OK with a "Just a moment..." interstitial — bot mitigation can hide behind a healthy status code.',
  lesson:
    "The audit recognizes the challenge HTML and marks the page as blocked instead of flagging content issues against markup that was never the real page.",
  expectedIssues: ["blocked-page"],
  linkedFromCatalog: false,
  handler: () =>
    htmlResponse(
      renderPage({
        fixture: challengePage,
        title: "Just a moment...",
        metaDescription: "A challenge page served with a healthy 200 status.",
        bodyHtml: article({
          h1: "Just a moment...",
          lede: "This Salla storefront passes the status check while serving a challenge.",
          sections: [
            {
              h2: "Status codes are not content checks",
              body: "Some mitigation product configurations return the challenge interstitial with a 200 status, because the challenge activates with JavaScript. A crawler that trusts the 200 sees a strange page and reports phantom issues like a missing heading or thin content.",
            },
          ],
        }),
      }),
    ),
};

// 6 — sparse product markup: null honesty -------------------------------
// Names the product in JSON-LD and stops there. The extraction keeps every
// unknown null, and the schema validator flags the markup gaps while the page
// itself reads as ordinary copy.

import { sallaProductFixtures } from "./sallaProducts";

export const sallaFixtures: Fixture[] = [
  productPage,
  categoryPage,
  csrShelf,
  blogPost,
  challengePage,
  ...sallaProductFixtures,
];
