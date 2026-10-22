/**
 * Product schema validation for Salla catalog pages (Phase 2).
 *
 * Judges the product structured markup only: a field counts when its
 * evidence tier is structured-data (JSON-LD, microdata, OG product meta).
 * A price visible in plain HTML but absent from the Product markup keeps
 * the page flagged — the verdict is about the schema, and the two issue
 * types keep validity apart from rich-result eligibility:
 *
 *   - required  (name, image, offers.price) → valid product markup
 *   - recommended (offers.priceCurrency, offers.availability) → richer
 *     merchant listings
 *
 * Nothing here claims the product lacks the value itself (D6/D12): the
 * details list schema members only.
 */
import type { CrawledPageResult, DetectedIssue } from "../types";
import { parseSallaExtractionJson } from "./extraction";
import type { EvidenceTier, Field, ProductImageEvidence } from "./extraction";

function hasStructuredEvidence(
  field: Field<unknown> | ProductImageEvidence | null,
): boolean {
  return field?.from === "structured-data";
}

export function validateProductSchema(
  page: CrawledPageResult,
): DetectedIssue[] {
  if (
    page.pageType !== "product" ||
    page.extractionState !== "STATIC_COMPLETE"
  ) {
    return [];
  }
  const extraction = parseSallaExtractionJson(page.sallaExtractionJson);
  if (!extraction || extraction.kind !== "product") {
    return [];
  }

  const missingRequired: string[] = [];
  if (!hasStructuredEvidence(extraction.name)) {
    missingRequired.push("name");
  }
  if (!extraction.images.some((image) => hasStructuredEvidence(image))) {
    missingRequired.push("image");
  }
  if (
    !hasStructuredEvidence(extraction.price) &&
    !hasStructuredEvidence(extraction.priceRaw)
  ) {
    missingRequired.push("offers.price");
  }

  const issues: DetectedIssue[] = [];
  if (missingRequired.length > 0) {
    issues.push({
      issueType: "product-schema-missing-required",
      pageId: page.id,
      pageUrl: page.url,
      details: { fields: missingRequired },
    });
  }

  const missingRecommended: string[] = [];
  if (!hasStructuredEvidence(extraction.currency)) {
    missingRecommended.push("offers.priceCurrency");
  }
  if (
    extraction.availability.from !== ("structured-data" satisfies EvidenceTier)
  ) {
    missingRecommended.push("offers.availability");
  }
  if (missingRecommended.length > 0) {
    issues.push({
      issueType: "product-schema-missing-recommended",
      pageId: page.id,
      pageUrl: page.url,
      details: { fields: missingRecommended },
    });
  }

  return issues;
}
