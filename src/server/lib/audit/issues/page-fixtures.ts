/** Shared page fixture for the per-page issue reporter tests. */
import type { CrawledPageResult, PageLink } from "@/server/lib/audit/types";
import {
  serializeSallaExtraction,
  type SallaProductExtraction,
} from "@/server/lib/audit/salla/extraction";

export const HEALTHY_LINK: PageLink = {
  targetUrl: "https://example.com/catalog",
  anchor: "Catalog",
  isInternal: true,
  isNofollow: false,
};

export function makePage(
  overrides: Partial<CrawledPageResult>,
): CrawledPageResult {
  return {
    id: "page-1",
    url: "https://example.com/a",
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    retryAfter: null,
    htmlBytes: 12_000,
    structuredDataJson: null,
    redirectUrl: null,
    title: "A perfectly reasonable page title",
    metaDescription:
      "A reasonable meta description that says something useful about the page.",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h1Text: null,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1, 2, 3],
    wordCount: 500,
    contentHash: "abc123",
    isHtml: true,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [HEALTHY_LINK],
    hasStructuredData: false,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 200,
    platform: null,
    platformConfidence: 0,
    pageType: null,
    pageTypeConfidence: null,
    sallaExtractionJson: null,
    crawlDepth: 1,
    inSitemap: true,
    ...overrides,
  };
}

export function sparseProductJson(): string {
  const sparse: SallaProductExtraction = {
    kind: "product",
    name: null,
    sku: null,
    mpn: null,
    brand: null,
    description: null,
    price: null,
    priceRaw: null,
    compareAtPrice: null,
    compareAtPriceRaw: null,
    currency: null,
    availability: { value: "UNKNOWN", from: null },
    externalId: null,
    images: [],
    variants: [],
  };
  const serialized = serializeSallaExtraction(sparse);
  if (!serialized) {
    throw new Error("sparse product extraction did not serialize");
  }
  return serialized;
}

export function completeProductJson(): string {
  const complete: SallaProductExtraction = {
    kind: "product",
    name: { value: "Berber Rug", from: "structured-data" },
    sku: { value: "SKU-1", from: "structured-data" },
    mpn: null,
    brand: null,
    description: null,
    price: { value: 149.99, from: "structured-data" },
    priceRaw: null,
    compareAtPrice: null,
    compareAtPriceRaw: null,
    currency: { value: "SAR", from: "structured-data" },
    availability: { value: "InStock", from: "structured-data" },
    externalId: null,
    images: [
      {
        url: "https://cdn.sa/img/rug.jpg",
        alt: null,
        from: "structured-data",
      },
    ],
    variants: [],
  };
  const serialized = serializeSallaExtraction(complete);
  if (!serialized) {
    throw new Error("complete product extraction did not serialize");
  }
  return serialized;
}
