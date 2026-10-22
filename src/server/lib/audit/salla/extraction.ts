/**
 * Shared model for the Salla adapter's evidence-shaped extraction partials.
 *
 * Every field carries its evidence tier (`structured-data` = JSON-LD, microdata
 * and OG markup; `html` = visible DOM and data attributes; `api` exists in the
 * taxonomy but is never emitted here — the OAuth connector may only fill gaps,
 * never overwrite public evidence). Missing evidence stays null: availability
 * is the only field with a non-evidence fallback, and that fallback is the
 * explicit `UNKNOWN` value (negative specs D6, D12: never manufacture values).
 *
 * The extraction payload is persisted per page as capped JSON in
 * audit_pages.salla_extraction_json; parseSallaExtractionJson is the reader.
 */

import { z } from "zod";
import { jsonCodec } from "@/shared/json";
import type { CheerioAPI } from "cheerio";
import { isJsonLdNode, jsonLdTypeNames, type JsonLdNode } from "./json-ld";
import type { PageTypeName } from "./page-type-evidence";

export const EVIDENCE_TIERS = ["structured-data", "html", "api"] as const;
export type EvidenceTier = (typeof EVIDENCE_TIERS)[number];

export const AVAILABILITY_VALUES = [
  "InStock",
  "OutOfStock",
  "PreOrder",
  "OnBackorder",
  "UNKNOWN",
] as const;
export type AvailabilityValue = (typeof AVAILABILITY_VALUES)[number];

/**
 * One evidence-backed field value and where it came from. Writers emit only
 * the structured-data/html tiers; the api tier is reserved for the OAuth
 * connector and never overwrites public evidence (R2).
 */
export interface Field<T> {
  value: T;
  from: EvidenceTier;
}

/**
 * Availability after the R1 ladder. `from` records the strongest evidence
 * source; it is null only when the value is the honest UNKNOWN default.
 */
export interface AvailabilityEvidence {
  value: AvailabilityValue;
  from: EvidenceTier | null;
}

/** R9: a product ID taken from the URL slug is always weak evidence. */
export interface ExternalIdEvidence {
  value: string;
  weak: true;
}

export interface ProductImageEvidence {
  url: string;
  alt: string | null;
  from: EvidenceTier;
}

export interface ProductVariantEvidence {
  name: Field<string> | null;
  sku: Field<string> | null;
  price: Field<number> | null;
  /** variant price − page price, only when both exist as numbers. */
  priceDelta: Field<number> | null;
  availability: AvailabilityEvidence | null;
}

export interface SallaProductExtraction {
  kind: "product";
  name: Field<string> | null;
  sku: Field<string> | null;
  mpn: Field<string> | null;
  brand: Field<string> | null;
  description: Field<string> | null;
  price: Field<number> | null;
  /** Unparsed price text kept alongside the numeric parse when both exist. */
  priceRaw: Field<string> | null;
  compareAtPrice: Field<number> | null;
  compareAtPriceRaw: Field<string> | null;
  /** Currency is never defaulted (D6): absent evidence stays null. */
  currency: Field<string> | null;
  availability: AvailabilityEvidence;
  externalId: ExternalIdEvidence | null;
  images: ProductImageEvidence[];
  variants: ProductVariantEvidence[];
}

export interface CategoryMemberUrl {
  url: string;
  from: EvidenceTier;
}

export interface SallaCategoryExtraction {
  kind: "category";
  name: Field<string> | null;
  /** Breadcrumb-derived path, in order; null without breadcrumb evidence. */
  path: Field<string[]> | null;
  memberProductUrls: CategoryMemberUrl[];
}

export interface SallaBlogExtraction {
  kind: "blog";
  title: Field<string> | null;
  datePublished: Field<string> | null;
  dateModified: Field<string> | null;
  author: Field<string> | null;
}

export type SallaExtraction =
  | SallaProductExtraction
  | SallaCategoryExtraction
  | SallaBlogExtraction;

/** zod counterparts of the writer types (trusted at the API boundary only). */
const evidenceTierSchema = z.enum(EVIDENCE_TIERS);
const stringFieldSchema = z.object({
  value: z.string().min(1),
  from: evidenceTierSchema,
});
const numberFieldSchema = z.object({
  value: z.number().finite(),
  from: evidenceTierSchema,
});
const availabilityEvidenceSchema = z.object({
  value: z.enum(AVAILABILITY_VALUES),
  from: evidenceTierSchema.nullable(),
});
const externalIdEvidenceSchema = z.object({
  value: z.string().min(1),
  weak: z.literal(true),
});
const productImageSchema = z.object({
  url: z.string().min(1),
  alt: z.string().nullable(),
  from: evidenceTierSchema,
});
const productVariantSchema = z.object({
  name: stringFieldSchema.nullable(),
  sku: stringFieldSchema.nullable(),
  price: numberFieldSchema.nullable(),
  priceDelta: numberFieldSchema.nullable(),
  availability: availabilityEvidenceSchema.nullable(),
});
const categoryMemberUrlSchema = z.object({
  url: z.string().min(1),
  from: evidenceTierSchema,
});
const categoryPathSchema = z.object({
  value: z.array(z.string().min(1)).min(1),
  from: evidenceTierSchema,
});

const productExtractionSchema = z.object({
  kind: z.literal("product"),
  name: stringFieldSchema.nullable(),
  sku: stringFieldSchema.nullable(),
  mpn: stringFieldSchema.nullable(),
  brand: stringFieldSchema.nullable(),
  description: stringFieldSchema.nullable(),
  price: numberFieldSchema.nullable(),
  priceRaw: stringFieldSchema.nullable(),
  compareAtPrice: numberFieldSchema.nullable(),
  compareAtPriceRaw: stringFieldSchema.nullable(),
  currency: stringFieldSchema.nullable(),
  availability: availabilityEvidenceSchema,
  externalId: externalIdEvidenceSchema.nullable().default(null),
  images: z.array(productImageSchema).max(30).default([]),
  variants: z.array(productVariantSchema).max(30).default([]),
});
const categoryExtractionSchema = z.object({
  kind: z.literal("category"),
  name: stringFieldSchema.nullable(),
  path: categoryPathSchema.nullable(),
  memberProductUrls: z.array(categoryMemberUrlSchema).max(100).default([]),
});
const blogExtractionSchema = z.object({
  kind: z.literal("blog"),
  title: stringFieldSchema.nullable(),
  datePublished: stringFieldSchema.nullable(),
  dateModified: stringFieldSchema.nullable(),
  author: stringFieldSchema.nullable(),
});

export const sallaExtractionSchema = z.discriminatedUnion("kind", [
  productExtractionSchema,
  categoryExtractionSchema,
  blogExtractionSchema,
]);

const sallaExtractionCodec = jsonCodec(sallaExtractionSchema);

/** Read-side parser for persisted audit_pages.salla_extraction_json rows. */
export function parseSallaExtractionJson(
  json: string | null,
): SallaExtraction | null {
  if (!json) return null;
  const result = sallaExtractionCodec.safeParse(json);
  return result.success ? result.data : null;
}

/**
 * Persistence cap. Extraction is supporting evidence, not a payload store:
 * product pages with giant galleries or descriptions are serialized in a
 * degenerate shoe (no description, 5 images, 3 variants) before being
 * dropped entirely — the drop is honest, not lossy-but-silent.
 */
const MAX_EXTRACTION_JSON_CHARS = 12_000;
const DEGENERATE_IMAGE_COUNT = 5;
const DEGENERATE_VARIANT_COUNT = 3;

function degenerate(extraction: SallaExtraction): SallaExtraction {
  if (extraction.kind !== "product") return extraction;
  return {
    ...extraction,
    externalId: extraction.externalId ?? null,
    description: null,
    images: extraction.images.slice(0, DEGENERATE_IMAGE_COUNT),
    variants: extraction.variants.slice(0, DEGENERATE_VARIANT_COUNT),
  };
}

export function serializeSallaExtraction(
  extraction: SallaExtraction,
): string | null {
  for (const candidate of [extraction, degenerate(extraction)]) {
    const serialized = JSON.stringify(candidate, null, 0);
    if (serialized.length <= MAX_EXTRACTION_JSON_CHARS) return serialized;
  }
  return null;
}

export interface SallaExtractionInput {
  pageUrl: string;
  pageType: PageTypeName;
  structuredDataJson: string | null;
  /** Visible body text, for the availability keyword ladder (R1). */
  bodyText: string;
  /** First heading texts, the category/blog name fallback. */
  h1s: string[];
  /** Page title text, the blog-title fallback. */
  title: string;
  /**
   * Internal link targets, already normalized by the analyzer; used by the
   * category extractor for member-product harvesting (R4).
   */
  internalLinks: string[];
  $: CheerioAPI;
}

/**
 * Collect JSON-LD nodes matching a type test. Handles single nodes, arrays,
 * the analyzer's synthetic multi-block "@graph", inline "@graph" collections,
 * and truncation markers (which keep their @type but lose fields — having no
 * fields to extract, they simply match nothing beyond @type lookups).
 */
export function collectJsonLdNodes(
  payloadJson: string,
  types: readonly string[],
): JsonLdNode[] {
  let root: unknown;
  try {
    root = JSON.parse(payloadJson);
  } catch {
    return [];
  }

  const found: JsonLdNode[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      for (const item of node) visit(item);
      return;
    }
    if (!isJsonLdNode(node)) return;
    const nodeTypes = jsonLdTypeNames(node["@type"]);
    if (nodeTypes.some((type) => types.includes(type))) {
      found.push(node);
    }
    if (node["@graph"]) visit(node["@graph"]);
  };

  visit(root);
  return found;
}

/** Map a schema.org availability term (URI or bare) onto the ladder value. */
export function mapSchemaAvailability(raw: string): AvailabilityValue | null {
  const term = raw.split("/").pop()?.trim().toLowerCase() ?? "";
  if (!term) return null;
  if (term.startsWith("instock")) return "InStock";
  if (term.startsWith("outofstock") || term.startsWith("soldout")) {
    return "OutOfStock";
  }
  if (term.startsWith("preorder") || term.startsWith("presale")) {
    return "PreOrder";
  }
  if (term.startsWith("backorder")) return "OnBackorder";
  return null;
}

/** Keyword ladder step (R1): visible text in English and Arabic. Negation
 * phrases are tested before their positive counterparts ("غير متوفر"
 * contains "متوفر" as a substring). */
const STOCK_KEYWORDS: Array<{
  pattern: RegExp;
  value: AvailabilityValue;
}> = [
  { pattern: /pre[- ]?order|طلب مسبق/i, value: "PreOrder" },
  {
    pattern:
      /out? of stock|sold out|غير متوفر|نفد|نفذ من|نفذت من|نفذت الكمية|نفدت الكمية|انتهى من المخزون|توقف البيع/i,
    value: "OutOfStock",
  },
  { pattern: /in stock|متوفر/i, value: "InStock" },
];

export function availabilityFromKeywords(
  text: string,
): AvailabilityEvidence | null {
  for (const keyword of STOCK_KEYWORDS) {
    if (keyword.pattern.test(text)) {
      return { value: keyword.value, from: "html" };
    }
  }
  return null;
}

/** Merge R2 precedence: structured-data over html per field. */
export function mergeField<T>(
  structured: Field<T> | null,
  html: Field<T> | null,
): Field<T> | null {
  return structured ?? html;
}

/** First non-empty string from an arbitrary JSON-LD string-ish value. */
export function firstJsonString(value: unknown): string | null {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (Array.isArray(value)) {
    for (const item of value) {
      if (typeof item === "string" && item.trim()) return item.trim();
    }
  }
  return null;
}
