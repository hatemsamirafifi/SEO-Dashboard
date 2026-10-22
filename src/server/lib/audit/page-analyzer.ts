/**
 * HTML page analyzer using cheerio.
 *
 * Extracts SEO-relevant data from a page's HTML:
 * title, meta description, headings, images, links, canonical, OG tags,
 * structured data, robots meta, word count, hreflang.
 */
import * as cheerio from "cheerio";
import type { ExtractionState } from "@/shared/audit-fetch-class";
import { normalizeUrl, isSameOrigin } from "./url-utils";
import type { PageAnalysis, PageLink } from "./types";
import {
  classifyPageType,
  matchesProductUrlPattern,
  type PageTypeEvidence,
} from "./salla/page-type-evidence";
import {
  serializeSallaExtraction,
  type SallaExtractionInput,
} from "./salla/extraction";
import { extractProduct } from "./salla/product-extractor";
import { extractCategory } from "./salla/category-extractor";
import { extractBlog } from "./salla/blog-extractor";

/** Whole parsed JSON-LD payload stored per page. */
const MAX_JSONLD_CHARS = 40_000;
/** Below this word count a page is suspiciously empty for a real page. */
const MIN_SANE_WORD_COUNT = 20;

/**
 * A render-root container left completely empty by the server. The full
 * word-count gate plus the emptiness requirement keep hydrated or
 * server-rendered content from being mistaken for a shell — an empty
 * `<div id="root"></div>` alone is not proof of anything.
 */
const EMPTY_CSR_ROOT =
  /<(?:div|main)[^>]*\bid=["']?(?:__next|root|app)["']?[^>]*>\s*<\/(?:div|main)>|<(?:app-root|ng-view)\b[^>]*>\s*<\/(?:app-root|ng-view)>/i;
/** An app bootstrap script: external bundle or an ES module entry. */
const BOOTSTRAP_SCRIPT =
  /<script\b[^>]*\bsrc\s*=|<script\b[^>]*\stype=["']module["']/i;
/** Framework state blobs only a client-side app injects. */
const INLINE_STATE_MARKERS = /__NEXT_DATA__|__APOLLO_STATE__|data-reactroot/i;

/**
 * Scan server-rendered HTML for evidence that meaningful content is
 * script-rendered.
 *
 * Heuristic-only by design (this fork does not execute JavaScript): a
 * shell requires BOTH an empty CSR render root and an app bootstrap
 * script (or an inline framework state blob). Anything ambiguous stays
 * STATIC_PARTIAL and must not produce confirmed missing-* findings.
 */
export function classifyExtractionState(
  html: string,
  analysis: { wordCount: number },
): ExtractionState {
  if (analysis.wordCount >= MIN_SANE_WORD_COUNT) return "STATIC_COMPLETE";
  const emptyRoot = EMPTY_CSR_ROOT.test(html);
  if (emptyRoot) {
    // An empty root without any app script is invalid HTML, not a shell
    // (and an ld+json script is data, not a bootstrap).
    return BOOTSTRAP_SCRIPT.test(html) || INLINE_STATE_MARKERS.test(html)
      ? "RENDERING_REQUIRED"
      : "STATIC_PARTIAL";
  }
  return INLINE_STATE_MARKERS.test(html)
    ? "RENDERING_REQUIRED"
    : "STATIC_PARTIAL";
}

/**
 * Human-readable @type label of a JSON-LD block: a string type, the joined
 * types of an array, or "unknown" when the block declares none.
 */
function jsonLdTypeLabel(parsed: unknown): string {
  if (typeof parsed !== "object" || parsed === null) return "unknown";
  const declared: unknown = Reflect.get(parsed, "@type");
  if (typeof declared === "string") return declared;
  if (Array.isArray(declared)) {
    return declared.filter((entry) => typeof entry === "string").join(",");
  }
  return "unknown";
}

function metaContentOrNull($: cheerio.CheerioAPI, name: string): string | null {
  // Attribute values are matched case-sensitively by CSS selectors, but the
  // real web contains <meta NAME="description"> (parsed by their own rules —
  // both Google and cheerio's HTML tokenizer read tag/attribute names as
  // case-insensitive). Scan metas explicitly instead of trusting the selector.
  let content: string | null = null;
  $("meta").each((_, el) => {
    if (($(el).attr("name") ?? "").toLowerCase() !== name) return;
    const value = $(el).attr("content");
    if (typeof value === "string" && content === null) content = value;
  });
  return content;
}

/**
 * Parse every JSON-LD block on the page, tolerate individually broken
 * blocks, and emit a single capped JSON payload (multi-block pages are
 * merged via a synthetic @graph, matching common vocabulary conventions).
 */
function extractStructuredData($: cheerio.CheerioAPI): {
  hasStructuredData: boolean;
  structuredDataJson: string | null;
} {
  let hasStructuredData = false;
  const blocks: unknown[] = [];
  let accBytes = 0;
  $('script[type="application/ld+json"]').each((_, el) => {
    hasStructuredData = true;
    const raw = $(el).text().trim();
    if (!raw || accBytes >= MAX_JSONLD_CHARS) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      // A block we cannot parse is not a block we can interpret; the
      // presence flag above still records that the page declares data.
      return;
    }
    let serialized = JSON.stringify(parsed);
    if (serialized.length > MAX_JSONLD_CHARS) {
      // Keep the atomic block's shape instead of a truncated string that is
      // no longer valid JSON if another tool parses it back.
      serialized = JSON.stringify({
        "@type": jsonLdTypeLabel(parsed),
        truncated: true,
      });
    }
    if (accBytes + serialized.length > MAX_JSONLD_CHARS) return;
    // Store the (possibly truncation-shaped) serialized form, not the raw
    // object, so the final payload actually honors the cap.
    blocks.push(JSON.parse(serialized));
    accBytes += serialized.length;
  });

  if (!hasStructuredData || blocks.length === 0)
    return { hasStructuredData, structuredDataJson: null };

  const payload = blocks.length === 1 ? blocks[0] : { "@graph": blocks };
  return { hasStructuredData, structuredDataJson: JSON.stringify(payload) };
}

/**
 * Analyze an HTML string and extract all SEO-relevant data.
 */
export function analyzeHtml(
  html: string,
  pageUrl: string,
  statusCode: number,
  responseTimeMs: number,
  redirectUrl: string | null = null,
): PageAnalysis {
  const $ = cheerio.load(html);

  const title = $("title").first().text().trim();

  const metaDescription = metaContentOrNull($, "description")?.trim() ?? "";

  const canonical = $('link[rel="canonical"]').first().attr("href") ?? null;

  const robotsMeta = metaContentOrNull($, "robots");

  // --- Open Graph ---
  const ogTitle =
    $('meta[property="og:title"]').first().attr("content") ?? null;
  const ogDescription =
    $('meta[property="og:description"]').first().attr("content") ?? null;
  const ogImage =
    $('meta[property="og:image"]').first().attr("content") ?? null;
  const ogType = $('meta[property="og:type"]').first().attr("content") ?? null;

  // --- Headings ---
  const h1s: string[] = [];
  $("h1").each((_, el) => {
    h1s.push($(el).text().trim());
  });

  const headingOrder: number[] = [];
  $("h1, h2, h3, h4, h5, h6").each((_, el) => {
    const tag =
      "tagName" in el && typeof el.tagName === "string"
        ? el.tagName.toLowerCase()
        : null;
    if (tag) {
      const level = parseInt(tag.charAt(1), 10);
      if (!isNaN(level)) headingOrder.push(level);
    }
  });

  // --- Word count (visible text in body) ---
  // Remove script/style/noscript tags, then count words in remaining text
  const bodyClone = $("body").clone();
  bodyClone.find("script, style, noscript, svg").remove();
  const bodyText = bodyClone.text().replace(/\s+/g, " ").trim();
  const wordCount = bodyText ? bodyText.split(/\s+/).length : 0;

  const images: Array<{ src: string | null; alt: string | null }> = [];
  $("img").each((_, el) => {
    images.push({
      src: $(el).attr("src") ?? null,
      alt: $(el).attr("alt") ?? null,
    });
  });

  // --- Links (deduped by target URL; first anchor wins) ---
  const linksByTarget = new Map<string, PageLink>();

  $("a[href]").each((_, el) => {
    const href = $(el).attr("href");
    if (!href) return;

    // Skip javascript:, mailto:, tel:, #anchors
    if (/^(javascript:|mailto:|tel:|#)/.test(href)) return;

    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved) return;
    if (linksByTarget.has(resolved)) return;

    const anchor = $(el).text().replace(/\s+/g, " ").trim().slice(0, 200);
    const rel = $(el).attr("rel")?.toLowerCase() ?? "";
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: anchor || null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: rel.split(/\s+/).includes("nofollow"),
    });
  });

  // Pagination continuation: <link rel="next"> in the head points at the
  // next page of a sequence even when the body renders no anchor for it.
  // Harvest it as a link so the frontier follows the sequence; a broken
  // rel=next target is a real broken internal link.
  $("link[rel][href]").each((_, el) => {
    const relValues = ($(el).attr("rel") ?? "").toLowerCase().split(/\s+/);
    if (!relValues.includes("next")) return;
    const href = $(el).attr("href");
    if (!href) return;
    const resolved = normalizeUrl(href, pageUrl);
    if (!resolved || linksByTarget.has(resolved)) return;
    linksByTarget.set(resolved, {
      targetUrl: resolved,
      anchor: null,
      isInternal: isSameOrigin(resolved, pageUrl),
      isNofollow: false,
    });
  });
  const links = Array.from(linksByTarget.values());

  // --- Structured data (JSON-LD) ---
  const { hasStructuredData, structuredDataJson } = extractStructuredData($);

  // --- Page-type classification (evidence-scored, null when unclassifiable)
  const hasAddToCart = detectAddToCartAffordance($);
  const internalProductLinkCount = Array.from(links).filter(
    (link) => link.isInternal && matchesProductUrlPattern(link.targetUrl),
  ).length;
  const classification = classifyPageType({
    structuredDataJson,
    ogType,
    pageUrl,
    internalProductLinkCount,
    hasAddToCart,
  } satisfies PageTypeEvidence);

  // --- Salla adapter: evidence-shaped extraction on classified pages (R2) ---
  let sallaExtractionJson: string | null = null;
  if (
    classification?.type === "product" ||
    classification?.type === "category" ||
    classification?.type === "blog"
  ) {
    const extractionInput: SallaExtractionInput = {
      pageUrl,
      pageType: classification.type,
      structuredDataJson,
      bodyText,
      h1s,
      title,
      internalLinks: links
        .filter((link) => link.isInternal)
        .map((link) => link.targetUrl),
      $,
    };
    const extraction =
      classification.type === "product"
        ? extractProduct(extractionInput)
        : classification.type === "category"
          ? extractCategory(extractionInput)
          : extractBlog(extractionInput);
    sallaExtractionJson = serializeSallaExtraction(extraction);
  }

  const hreflangTags: string[] = [];
  $('link[rel="alternate"][hreflang]').each((_, el) => {
    const hreflang = $(el).attr("hreflang");
    if (hreflang) hreflangTags.push(hreflang);
  });

  return {
    url: pageUrl,
    statusCode,
    redirectUrl,
    responseTimeMs,
    title,
    metaDescription,
    canonical,
    robotsMeta,
    ogTitle,
    ogDescription,
    ogImage,
    ogType,
    h1s,
    headingOrder,
    wordCount,
    bodyText,
    images,
    links,
    hasStructuredData,
    structuredDataJson,
    hreflangTags,
    pageType: classification?.type ?? null,
    pageTypeConfidence: classification?.confidence ?? null,
    sallaExtractionJson,
  };
}

/**
 * Add-to-cart affordance evidence: bounded selector list (data attributes and
 * cart-submit forms are the stable cross-platform markers; Shopify uses
 * name="add") plus visible button text in English and Arabic.
 */
const ADD_TO_CART_TEXT_RE =
  /add (?:it )?to (?:cart|bag|basket)|أضف إلى السلة|أضف للعربة|أضف إلى التسوقة/i;

function detectAddToCartAffordance($: cheerio.CheerioAPI): boolean {
  const selector =
    "[data-add-to-cart], button[name=add], input[name=add], " +
    'form[action*="cart"] button[type=submit], .add-to-cart, #add-to-cart';
  if ($(selector).length > 0) return true;
  let found = false;
  $("button, input[type=submit]").each((_, el) => {
    if (found) return;
    const element = $(el);
    const text = `${element.text()} ${element.attr("value") ?? ""}`;
    if (ADD_TO_CART_TEXT_RE.test(text.trim())) found = true;
  });
  return found;
}
