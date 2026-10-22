import type { Fixture } from "./types";
import { htmlResponse, renderPage } from "../lib";
import { lorem } from "../lib";
import { article } from "./helpers";
import { CAT, productCard, sallaHeadExtra } from "./sallaShared";

const sparseProduct: Fixture = {
  path: "/salla/product/heavy-duty-garden-hose",
  category: CAT,
  name: "Salla: sparse product markup",
  summary:
    "Product JSON-LD that names the product and nothing else: no image, no offer price, no currency, no availability.",
  lesson:
    "The extractor never guesses: price, currency and availability stay null without markup evidence, and the schema validator splits what makes the markup valid from what makes it eligible for rich results.",
  expectedIssues: [
    "product-schema-missing-required",
    "product-schema-missing-recommended",
  ],
  linkedFromCatalog: false,
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: sparseProduct,
        title: "Heavy-Duty Garden Hose",
        metaDescription:
          "A Salla product page whose structured markup names the product but leaves image and offer fields unwritten.",
        canonical: `${ctx.origin}/salla/product/heavy-duty-garden-hose`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Heavy-Duty Garden Hose","sku":"HGH-2024"}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/home-appliances">Home appliances</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Heavy-Duty Garden Hose",
  lede: "A product listing whose visible copy is fine while its structured markup stops after the name.",
  sections: [
    {
      h2: "What the markup actually says",
      body: lorem(60),
    },
    {
      h2: "Everything else stays null",
      body: lorem(60),
    },
  ],
})}`,
      }),
    ),
};

// 7 — variants: per-option stock and price deltas -------------------------
// hasVariant nodes with their own offers: variant two costs more and is not
// presently purchasable, variant one only carries a price.
const variantProduct: Fixture = {
  path: "/salla/product/canvas-tote-bag",
  category: CAT,
  name: "Salla: product with variants",
  summary:
    "A product page whose Product JSON-LD declares two hasVariant options with their own offers.",
  lesson:
    "Variant evidence is kept per-option: prices, stock labels, and price deltas are read straight from the offers, with nothing invented for options that omit them.",
  expectedIssues: [],
  linkedFromCatalog: false,
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: variantProduct,
        title: "Canvas Tote Bag",
        metaDescription:
          "A Salla product page declaring two options with their own offers, one priced below and one above the base price.",
        canonical: `${ctx.origin}/salla/product/canvas-tote-bag`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Canvas Tote Bag","image":"${ctx.origin}/img/placeholder.svg","sku":"CTB-1","brand":{"@type":"Brand","name":"Store"},"offers":{"@type":"Offer","price":"89.00","priceCurrency":"SAR","availability":"https://schema.org/InStock"},"hasVariant":[{"@type":"Product","name":"Small","sku":"CTB-1-S","offers":{"@type":"Offer","price":"79.00"}},{"@type":"Product","name":"Large","sku":"CTB-1-L","offers":{"@type":"Offer","price":"119.00","availability":"https://schema.org/OutOfStock"}}]}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/home-appliances">Home appliances</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Canvas Tote Bag",
  lede: "Two sizes of one product, with their offers written into per-option markup.",
  sections: [
    {
      h2: "How the options are marked up",
      body: lorem(60),
    },
    {
      h2: "Reading the offer details carefully",
      body: lorem(55),
    },
  ],
})}`,
      }),
    ),
};

// 8 — multi-block JSON-LD via @graph --------------------------------------
// Salla themes often ship one script with a @graph collection. Classification,
// extraction, and breadcrumb harvesting must all see through it.
const graphProduct: Fixture = {
  path: "/salla/product/rustic-bookshelf",
  category: CAT,
  name: "Salla: product in a @graph block",
  summary:
    "One JSON-LD script whose @graph holds the breadcrumb trail and the Product node.",
  lesson:
    "Structured data inside @graph collections is walked like any other block: the product stays classified and its breadcrumb path is harvested from the same script.",
  expectedIssues: [],
  linkedFromCatalog: false,
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: graphProduct,
        title: "Rustic Bookshelf",
        metaDescription:
          "A Salla product page whose structured data lives in a single @graph collection: breadcrumb list plus product.",
        canonical: `${ctx.origin}/salla/product/rustic-bookshelf`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Store home","item":"${ctx.origin}/salla/csr/store-home"},{"@type":"ListItem","position":2,"name":"Home appliances","item":"${ctx.origin}/salla/category/home-appliances"},{"@type":"ListItem","position":3,"name":"Rustic Bookshelf"}]},{"@type":"Product","name":"Rustic Bookshelf","image":"${ctx.origin}/img/placeholder.svg","sku":"RBS-2","offers":{"@type":"Offer","price":"1249.00","priceCurrency":"SAR","availability":"https://schema.org/InStock"}}]}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/home-appliances">Home appliances</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Rustic Bookshelf",
  lede: "One markup script carries both the navigation trail and the product description.",
  sections: [
    {
      h2: "Why one script carries both",
      body: lorem(60),
    },
    {
      h2: "Walking the graph",
      body: lorem(55),
    },
  ],
})}`,
      }),
    ),
};

// 9 — canonical points at a different domain ------------------------------
const misCanonicalProduct: Fixture = {
  path: "/salla/product/misplaced-canonical",
  category: CAT,
  name: "Salla: canonical points to another domain",
  summary:
    "A fully-specified product page whose canonical URL belongs to a different site.",
  lesson:
    "A cross-domain canonical is more serious than a self-referential mismatch: while the declaration stands, search engines may index the other domain's copy and ignore this page.",
  expectedIssues: ["canonical-cross-domain"],
  linkedFromCatalog: false,
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: misCanonicalProduct,
        title: "Misplaced Canonical Coffee Grinder",
        metaDescription:
          "A healthy product page in every field except the canonical, which points at another domain entirely.",
        canonical: `https://other-store.example/salla/product/misplaced-canonical`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Misplaced Canonical Coffee Grinder","image":"${ctx.origin}/img/placeholder.svg","sku":"MCG-9","offers":{"@type":"Offer","price":"449.00","priceCurrency":"SAR","availability":"https://schema.org/InStock"}}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/home-appliances">Home appliances</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Misplaced Canonical Coffee Grinder",
  lede: "The product markup is complete; the canonical is the single defect on this page.",
  sections: [
    {
      h2: "One declaration in the wrong place",
      body: lorem(60),
    },
    {
      h2: "Why domains matter for canonicals",
      body: lorem(55),
    },
  ],
})}`,
      }),
    ),
};

// 10 — canonical points at a redirect loop ---------------------------------
const loopedCanonicalProduct: Fixture = {
  path: "/salla/product/looped-canonical",
  category: CAT,
  name: "Salla: canonical points into a redirect loop",
  summary:
    "A complete product page whose canonical URL is the self-redirecting /redirect/loop address.",
  lesson:
    "A canonical that can never resolve is worth nothing: the multipage check catches catalog pages pointing their canonical at an address stuck in a cycle.",
  expectedIssues: ["canonicalized-page", "canonical-redirect-loop"],
  linkedFromCatalog: false,
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: loopedCanonicalProduct,
        title: "Looped Canonical Ceramic Vase",
        metaDescription:
          "A healthy product page whose canonical declaration lands on a URL that redirects to itself forever.",
        canonical: `${ctx.origin}/redirect/loop`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@type":"Product","name":"Looped Canonical Ceramic Vase","image":"${ctx.origin}/img/placeholder.svg","sku":"LCV-3","offers":{"@type":"Offer","price":"199.00","priceCurrency":"SAR","availability":"https://schema.org/InStock"}}</script>`,
        bodyHtml: `
<nav class="crumbs"><a href="/salla/category/home-appliances">Home appliances</a> / <a href="/salla/csr/store-home">Store home</a></nav>
${article({
  h1: "Looped Canonical Ceramic Vase",
  lede: "The product markup is complete; the canonical declaration is the single defect here.",
  sections: [
    {
      h2: "A canonical that never resolves",
      body: lorem(60),
    },
    {
      h2: "How the check sees the cycle",
      body: lorem(55),
    },
  ],
})}`,
      }),
    ),
};

// 11 — healthy listing with structured breadcrumbs --------------------------
// A category page with real ItemList markup, a BreadcrumbList, descriptive
// copy and self-canonical — the version of a Salla category that passes
// cleanly and links every product fixture above.
const homeAppliancesListing: Fixture = {
  path: "/salla/category/home-appliances",
  category: CAT,
  name: "Salla: structured category listing",
  summary:
    "A category page with ItemList and BreadcrumbList JSON-LD plus descriptive copy — the healthy model of a Salla collection page.",
  lesson:
    "Listing markup feeds category hierarchy and member-product harvests; combined with real copy it is the thin-content contrast the electronics grid shows.",
  expectedIssues: [],
  handler: (ctx) =>
    htmlResponse(
      renderPage({
        fixture: homeAppliancesListing,
        title: "Home Appliances in a Salla Store",
        metaDescription:
          "A structured category listing with ItemList markup, a breadcrumb trail, and enough descriptive copy to stay healthy.",
        canonical: `${ctx.origin}/salla/category/home-appliances`,
        headExtra:
          sallaHeadExtra() +
          `<script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"BreadcrumbList","itemListElement":[{"@type":"ListItem","position":1,"name":"Store home","item":"${ctx.origin}/salla/csr/store-home"},{"@type":"ListItem","position":2,"name":"Home appliances"}]},{"@type":"ItemList","itemListElement":[{"@type":"ListItem","position":1,"name":"LED Desk Lamp","url":"${ctx.origin}/salla/product/desk-lamp"},{"@type":"ListItem","position":2,"name":"Heavy-Duty Garden Hose","url":"${ctx.origin}/salla/product/heavy-duty-garden-hose"},{"@type":"ListItem","position":3,"name":"Canvas Tote Bag","url":"${ctx.origin}/salla/product/canvas-tote-bag"},{"@type":"ListItem","position":4,"name":"Rustic Bookshelf","url":"${ctx.origin}/salla/product/rustic-bookshelf"},{"@type":"ListItem","position":5,"name":"Misplaced Canonical Coffee Grinder","url":"${ctx.origin}/salla/product/misplaced-canonical"},{"@type":"ListItem","position":6,"name":"Looped Canonical Ceramic Vase","url":"${ctx.origin}/salla/product/looped-canonical"}]}]}</script>`,
        bodyHtml: `
<h1>Home appliances</h1>
<p class="lede">A structured listing page that links its catalog the way a Salla collection should.</p>
<div class="grid">
${productCard("/salla/product/desk-lamp", "LED Desk Lamp", "199")}
${productCard("/salla/product/heavy-duty-garden-hose", "Heavy-Duty Garden Hose", "129")}
${productCard("/salla/product/canvas-tote-bag", "Canvas Tote Bag", "89")}
${productCard("/salla/product/rustic-bookshelf", "Rustic Bookshelf", "1249")}
${productCard("/salla/product/misplaced-canonical", "Coffee Grinder", "449")}
${productCard("/salla/product/looped-canonical", "Ceramic Vase", "199")}
</div>
<h2>Where this listing is healthy</h2>
<p>${lorem(60)}</p>
<h2>What the markup carries</h2>
<p>${lorem(55)}</p>`,
      }),
    ),
};

export const sallaProductFixtures: Fixture[] = [
  sparseProduct,
  variantProduct,
  graphProduct,
  misCanonicalProduct,
  loopedCanonicalProduct,
  homeAppliancesListing,
];
