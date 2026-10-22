/**
 * Evidence-scored page-type classification.
 *
 * Combines independent evidence groups — JSON-LD @types, Open Graph type,
 * URL patterns (R3), and DOM affordances — into a single honest verdict:
 * product | category | blog | other. URL patterns are detection evidence
 * per the plan's negative spec D11: a URL match alone never decides the
 * type. When evidence is absent or URL-only the classifier returns null and
 * nothing is persisted.
 */

import { isJsonLdNode, jsonLdTypeNames } from "./json-ld";

export const PAGE_TYPE_NAMES = [
  "product",
  "category",
  "blog",
  "other",
] as const;

export type PageTypeName = (typeof PAGE_TYPE_NAMES)[number];

export interface PageTypeClassification {
  type: PageTypeName;
  confidence: number;
}

/** Classified inputs the analyzer passes in — all evidence, no DOM work. */
export interface PageTypeEvidence {
  /** Serialized JSON-LD payload from the analyzer (null when absent). */
  structuredDataJson: string | null;
  /** og:type meta content (null when absent). */
  ogType: string | null;
  /** Page URL the evidence was gathered from. */
  pageUrl: string;
  /** Internal links on the page that match a product URL pattern. */
  internalProductLinkCount: number;
  /** True when an add-to-cart affordance is present. */
  hasAddToCart: boolean;
}

// R3 URL-pattern heuristics from the Salla crawler reference. These are the
// Salla shapes (/product/<slug>, /item/<slug>, /category/x, /collections/x,
// trailing "-c<id>") but they rhyme with most e-commerce URL schemes.
// Evidence only — never a decision on their own.
const PRODUCT_URL_RE = /\/(?:product|products|item)s?\//i;
const CATEGORY_URL_RE = /\/(?:categor(?:y|ies)|collections?)\//i;
// Salla category suffix: a path ending in "-c<id>" (e.g. /shoes-c18).
const SALLA_SUFFIX_RE = /-c\d+\/?$/i;
const BLOG_URL_RE = /\/(?:blog|posts?|news|articles?)\//i;

/** URL-pattern matcher, exported so the analyzer can count product links. */
export function matchesProductUrlPattern(url: string): boolean {
  return PRODUCT_URL_RE.test(url) || SALLA_SUFFIX_RE.test(url);
}

/**
 * One evidence group's per-type confidence. Weights are additive across the
 * groups that fired, capped, and never reach certainty.
 */
type EvidenceWeights = Partial<Record<PageTypeName, number>>;

const MAX_CONFIDENCE = 0.95;

function roundConfidence(value: number): number {
  return Math.round(Math.min(MAX_CONFIDENCE, value) * 100) / 100;
}

/**
 * Collect @type values from a serialized JSON-LD payload. Handles single
 * nodes, arrays, inline "@graph" collections, and the analyzer's synthetic
 * multi-block "@graph" — including truncation markers, which keep their
 * @type.
 */
export function collectJsonLdTypes(payloadJson: string): string[] {
  let root: unknown;
  try {
    root = JSON.parse(payloadJson);
  } catch {
    return [];
  }

  const types = new Set<string>();
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isJsonLdNode(node)) return;
    for (const part of jsonLdTypeNames(node["@type"])) {
      if (part) types.add(part);
    }
    if (node["@graph"]) visit(node["@graph"]);
  };

  visit(root);
  return Array.from(types);
}

function urlWeights(pageUrl: string): EvidenceWeights | null {
  if (PRODUCT_URL_RE.test(pageUrl)) return { product: 0.3 };
  if (CATEGORY_URL_RE.test(pageUrl) || SALLA_SUFFIX_RE.test(pageUrl)) {
    return { category: 0.3 };
  }
  if (BLOG_URL_RE.test(pageUrl)) return { blog: 0.3 };
  return null;
}

function jsonLdWeights(types: string[]): EvidenceWeights | null {
  if (types.includes("Product")) return { product: 0.6 };
  if (types.includes("BlogPosting") || types.includes("Article")) {
    return { blog: 0.6 };
  }
  // Breadcrumbs also appear on product pages, so breadcrumb/ItemList alone
  // is only medium evidence for a listing.
  if (
    types.some((type) =>
      ["ItemList", "CollectionPage", "BreadcrumbList"].includes(type),
    )
  ) {
    return { category: 0.4 };
  }
  return null;
}

function ogTypeWeights(ogType: string | null): EvidenceWeights | null {
  if (!ogType) return null;
  const value = ogType.trim().toLowerCase();
  if (value === "product") return { product: 0.3 };
  if (value === "article") return { blog: 0.3 };
  // Most frameworks tag every page og:type="website": on a page without any
  // product/category/blog evidence this is an honest "none of the three".
  if (value === "website") return { other: 0.3 };
  return null;
}

function affordanceWeights(evidence: PageTypeEvidence): EvidenceWeights | null {
  if (evidence.hasAddToCart) return { product: 0.4 };
  // A listing pattern that repeats across several internal links reads like
  // a category/listing page.
  if (evidence.internalProductLinkCount >= 3) return { category: 0.4 };
  return null;
}

/** Priority order for equal-confidence ties is product > blog > category. */
const TIE_PRIORITY: PageTypeName[] = ["product", "blog", "category"];

/**
 * Classify a page type from the evidence at hand. Returns null when:
 * - no evidence group fired at all, or
 * - the only fired group is the URL pattern (D11: URL alone never decides).
 */
export function classifyPageType(
  evidence: PageTypeEvidence,
): PageTypeClassification | null {
  const url = urlWeights(evidence.pageUrl);
  const jsonLd = jsonLdWeights(
    evidence.structuredDataJson
      ? collectJsonLdTypes(evidence.structuredDataJson)
      : [],
  );
  const og = ogTypeWeights(evidence.ogType);
  const dom = affordanceWeights(evidence);

  const corroborating = [jsonLd, og, dom];
  if (corroborating.every((group) => group === null)) {
    // URL-pattern-only pages stay unclassified (negative spec D11).
    return null;
  }

  // og:type="website" without any type-specific evidence anywhere is an
  // honest "none of product/category/blog" verdict (moderate confidence:
  // it is one group's word).
  if (
    jsonLd === null &&
    dom === null &&
    og !== null &&
    "other" in og &&
    Object.keys(og).length === 1
  ) {
    return {
      type: "other",
      confidence: roundConfidence(og.other ?? 0),
    };
  }

  // URL participates as weak evidence whenever anything else fired.
  const totals: Partial<Record<PageTypeName, number>> = {};
  for (const group of [...corroborating, url]) {
    if (!group) continue;
    for (const typeName of PAGE_TYPE_NAMES) {
      const weight = group[typeName];
      if (weight === undefined) continue;
      totals[typeName] = (totals[typeName] ?? 0) + weight;
    }
  }

  // Reduce over the tie priority so equal sums resolve deterministically.
  // "other" can only win the sums, never a tie (see TIE_PRIORITY): a
  // website-declared page with stray product evidence stays unclassified?
  // No — this branch only runs when corroboration exists, so the sums rank
  // whatever actually fired.
  const best = TIE_PRIORITY.reduce(
    (winner, candidate) =>
      (totals[candidate] ?? 0) > (totals[winner] ?? 0) ? candidate : winner,
    TIE_PRIORITY[0],
  );
  if ((totals[best] ?? 0) === 0) {
    // Corroboration exists but exclusively in "other" (og:type=website
    // handled above) — nothing product/category/blog-shaped fired.
    return null;
  }
  return { type: best, confidence: roundConfidence(totals[best] ?? 0) };
}
