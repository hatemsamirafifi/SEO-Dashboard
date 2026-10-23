/**
 * Rich-result schema gap detector.
 *
 * Runs inside the per-page issue pass on completed static extractions only.
 * It reports the gap a page type creates (a product page without Product
 * markup, a post without Article/BlogPosting, a category without a
 * BreadcrumbList) or, for non-product types, an existing document that is
 * not rich-result eligible. Product markup quality stays with the Salla
 * product-schema reporters so a page is never reported twice.
 */
import type { PageTypeName } from "../audit/salla/page-type-evidence";
import {
  collectJsonLdNodes,
  parseSallaExtractionJson,
} from "../audit/salla/extraction";
import type { CrawledPageResult, DetectedIssue } from "../audit/types";
import type { SchemaEntityType } from "./types";
import { validateSchema } from "./validate";

const ELIGIBLE_TYPES: Record<
  Exclude<PageTypeName, "other">,
  readonly SchemaEntityType[]
> = {
  product: ["Product"],
  blog: ["Article", "BlogPosting"],
  category: ["BreadcrumbList"],
};

export function detectSchemaGap(page: CrawledPageResult): DetectedIssue | null {
  if (page.extractionState !== "STATIC_COMPLETE") return null;
  if (!page.isHtml || !page.isIndexable) return null;
  if (
    page.pageType !== "product" &&
    page.pageType !== "category" &&
    page.pageType !== "blog"
  ) {
    return null;
  }
  const candidates = ELIGIBLE_TYPES[page.pageType];
  const nodes = page.structuredDataJson
    ? collectJsonLdNodes(page.structuredDataJson, candidates)
    : [];

  // On extracted Salla products the product-schema reporters already judge
  // markup presence and completeness from the same evidence.
  if (
    page.pageType === "product" &&
    parseSallaExtractionJson(page.sallaExtractionJson)?.kind === "product"
  ) {
    return null;
  }

  if (nodes.length === 0) {
    return issue(page, {
      gap: "missing",
      schemaType: candidates[0],
      candidates: [...candidates],
    });
  }

  // A truncated block kept its @type but lost its properties; judging it as
  // incomplete would manufacture a verdict from missing evidence.
  const node = nodes.find((candidate) => candidate.truncated !== true);
  if (!node) return null;

  // Product markup quality is reported by the product-schema reporters.
  if (page.pageType === "product") return null;

  const validation = validateSchema(node);
  if (validation.richResultEligible !== false) return null;
  return issue(page, {
    gap: "incomplete",
    schemaType: candidates[0],
    candidates: [...candidates],
    missing: validation.missingRichResultRequired,
  });
}

function issue(
  page: CrawledPageResult,
  details: Record<string, unknown>,
): DetectedIssue {
  return {
    issueType: "schema-gap",
    pageId: page.id,
    pageUrl: page.url,
    details,
  };
}
