import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import type { CrawledPageResult } from "../types";
import {
  serializeSallaExtraction,
  type SallaExtractionInput,
  type SallaProductExtraction,
} from "./extraction";
import { extractProduct } from "./product-extractor";
import { validateProductSchema } from "./schema-validation";

function load(html: string): CheerioAPI {
  return cheerio.load(html);
}

function input(
  options: {
    html?: string;
    structuredDataJson?: string | null;
    pageUrl?: string;
    bodyText?: string;
    h1s?: string[];
  } = {},
): SallaExtractionInput {
  return {
    pageUrl: options.pageUrl ?? "https://store.sa/product/rug-23815",
    pageType: "product" as const,
    structuredDataJson: options.structuredDataJson ?? null,
    bodyText: options.bodyText ?? "",
    h1s: options.h1s ?? [],
    title: "",
    internalLinks: [],
    $: load(options.html ?? "<html><body></body></html>"),
  };
}

function completeStructuredJson(): string {
  return JSON.stringify({
    "@type": "Product",
    name: "Berber Rug",
    sku: "SKU-1",
    offers: {
      "@type": "Offer",
      price: 149.99,
      priceCurrency: "SAR",
      availability: "https://schema.org/InStock",
    },
    image: "https://cdn.sa/img/rug.jpg",
  });
}

function makePage(
  overrides: Partial<CrawledPageResult>,
  extraction: SallaProductExtraction,
): CrawledPageResult {
  return {
    id: "page-1",
    url: "https://store.sa/product/rug-23815",
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    retryAfter: null,
    htmlBytes: 12_000,
    structuredDataJson: null,
    redirectUrl: null,
    title: "Berber Rug",
    metaDescription: "A rug.",
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
    wordCount: 500,
    contentHash: "abc123",
    isHtml: true,
    imagesTotal: 1,
    imagesMissingAlt: 0,
    images: [],
    links: [],
    hasStructuredData: true,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 200,
    platform: "salla",
    platformConfidence: 0.9,
    pageType: "product",
    pageTypeConfidence: 0.9,
    sallaExtractionJson: serializeSallaExtraction(extraction),
    crawlDepth: 1,
    inSitemap: true,
    ...overrides,
  };
}

/** The field names a schema gap carries, narrowed to strings. */
function fieldNames(
  issue: { details?: Record<string, unknown> } | undefined,
): string[] | undefined {
  const fields = issue?.details?.fields;
  if (!Array.isArray(fields)) return undefined;
  return fields.filter((field): field is string => typeof field === "string");
}

function fieldIssues(page: CrawledPageResult): {
  required: string[] | undefined;
  recommended: string[] | undefined;
} {
  const issues = validateProductSchema(page);
  const required = fieldNames(
    issues.find(
      (issue) => issue.issueType === "product-schema-missing-required",
    ),
  );
  const recommended = fieldNames(
    issues.find(
      (issue) => issue.issueType === "product-schema-missing-recommended",
    ),
  );
  return { required, recommended };
}

describe("validateProductSchema", () => {
  it("flags required and recommended gaps for a name-only product", () => {
    const extraction = extractProduct(input());
    const { required, recommended } = fieldIssues(makePage({}, extraction));
    expect(required).toEqual(["name", "image", "offers.price"]);
    expect(recommended).toEqual([
      "offers.priceCurrency",
      "offers.availability",
    ]);
  });

  it("passes a complete structured product", () => {
    const extraction = extractProduct(
      input({ structuredDataJson: completeStructuredJson() }),
    );
    expect(validateProductSchema(makePage({}, extraction))).toEqual([]);
  });

  it("keeps HTML-tier evidence out of the schema verdict", () => {
    const extraction = extractProduct(
      input({
        h1s: ["Visible Product Name"],
        html: '<img src="https://cdn.sa/img/rug.jpg" alt="rug">',
        bodyText: "متوفر الآن",
      }),
    );
    const { required, recommended } = fieldIssues(makePage({}, extraction));
    expect(required).toEqual(["name", "image", "offers.price"]);
    expect(recommended).toEqual([
      "offers.priceCurrency",
      "offers.availability",
    ]);
  });

  it("parses structured raw price text as offers.price evidence", () => {
    const extraction = extractProduct(
      input({ html: '<span itemprop="price">1.234,56</span>' }),
    );
    const { required, recommended } = fieldIssues(makePage({}, extraction));
    expect(required).toEqual(["name", "image"]);
    expect(recommended).toEqual([
      "offers.priceCurrency",
      "offers.availability",
    ]);
  });

  it("accepts structured availability but flags html-tier availability", () => {
    const extraction = extractProduct(
      input({
        structuredDataJson: completeStructuredJson(),
        html: "<button data-add-to-cart disabled>أضف إلى السلة</button>",
        bodyText: "in stock",
      }),
    );
    expect(validateProductSchema(makePage({}, extraction))).toEqual([]);
  });

  it("skips category, partial, and missing extractions", () => {
    const extraction = extractProduct(input());
    expect(
      validateProductSchema(makePage({ pageType: "category" }, extraction)),
    ).toEqual([]);
    expect(
      validateProductSchema(
        makePage({ extractionState: "STATIC_PARTIAL" }, extraction),
      ),
    ).toEqual([]);
    expect(
      validateProductSchema(
        makePage({ sallaExtractionJson: null }, extraction),
      ),
    ).toEqual([]);
  });
});
