import { type AuditService } from "@/server/features/audit/services/AuditService";
import type { PageSchemaResult } from "@/server/features/audit/services/SchemaService";
import type { SchemaEntityType } from "@/shared/schema-types";

type AuditResultsFixture = Awaited<ReturnType<typeof AuditService.getResults>>;
type AuditPageRow = AuditResultsFixture["pages"][number];

const AUDIT_ID = "e2e-audit";
const PRODUCT_PAGE_ID = "e2e-page-product";
const BLOG_PAGE_ID = "e2e-page-blog";
const PRODUCT_URL = "https://example.com/products/widget";
const BLOG_URL = "https://example.com/blog/launch-guide";

function page(
  overrides: Partial<AuditPageRow> & Pick<AuditPageRow, "id" | "url">,
): AuditPageRow {
  return {
    auditId: AUDIT_ID,
    statusCode: 200,
    redirectUrl: null,
    title: null,
    metaDescription: null,
    canonicalUrl: null,
    robotsMeta: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 2,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    wordCount: 420,
    imagesTotal: 4,
    imagesMissingAlt: 0,
    internalLinkCount: 12,
    externalLinkCount: 2,
    hasStructuredData: false,
    isIndexable: true,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    crawlDepth: 1,
    inSitemap: true,
    contentHash: "e2e-content-hash",
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    htmlBytes: 24_000,
    sallaExtractionJson: null,
    platform: null,
    platformConfidence: null,
    pageType: null,
    pageTypeConfidence: null,
    responseTimeMs: 180,
    ...overrides,
  };
}

const PAGES: AuditPageRow[] = [
  page({
    id: PRODUCT_PAGE_ID,
    url: PRODUCT_URL,
    title: "Widget | Example Store",
    pageType: "product",
    hasStructuredData: true,
    sallaExtractionJson: '{"product":{}}',
  }),
  page({
    id: BLOG_PAGE_ID,
    url: BLOG_URL,
    title: "Launch guide",
    pageType: "blog",
    wordCount: 980,
  }),
];

export function getStatusFixture(
  auditId: string,
): Awaited<ReturnType<typeof AuditService.getStatus>> | null {
  if (auditId !== AUDIT_ID) return null;
  return {
    id: AUDIT_ID,
    startUrl: "https://example.com/",
    status: "completed" as const,
    pagesCrawled: PAGES.length,
    pagesTotal: PAGES.length,
    lighthouseTotal: 0,
    lighthouseCompleted: 0,
    lighthouseFailed: 0,
    currentPhase: null,
    startedAt: "2026-10-23T10:00:00.000Z",
    completedAt: "2026-10-23T10:02:00.000Z",
    urls: {
      urlsDiscovered: PAGES.length,
      urlsFetched: PAGES.length,
      urlsAnalyzed: PAGES.length,
      urlsBlocked: 0,
      urlsFailed: 0,
      urlsSkipped: 0,
      urlsRenderingRequired: 0,
      urlsExtractionComplete: PAGES.length,
    },
    extractionCompleteRatio: 1,
  };
}

export function getResultsFixture(auditId: string): AuditResultsFixture | null {
  if (auditId !== AUDIT_ID) return null;
  return {
    audit: {
      id: AUDIT_ID,
      startUrl: "https://example.com/",
      status: "completed" as const,
      pagesCrawled: PAGES.length,
      pagesTotal: PAGES.length,
      startedAt: "2026-10-23T10:00:00.000Z",
      completedAt: "2026-10-23T10:02:00.000Z",
      config: { maxPages: 100, lighthouseStrategy: "none" as const },
    },
    pages: PAGES,
    lighthouse: [],
    issues: [],
  };
}

function availableType(
  type: SchemaEntityType,
  ok: boolean,
  reasons: string[] = [],
) {
  return { type, ok, reasons };
}

const AVAILABLE_TYPES = [
  availableType("Product", true),
  availableType("BreadcrumbList", true),
  availableType("WebPage", true),
  availableType("Article", false, ["Page type blog is required for Article."]),
  availableType("Organization", false, [
    "No observed Organization node in this page's existing JSON-LD.",
  ]),
];

function productResult(): PageSchemaResult {
  return {
    page: {
      id: PRODUCT_PAGE_ID,
      url: PRODUCT_URL,
      pageType: "product",
      extractionState: "STATIC_COMPLETE",
    },
    availableTypes: AVAILABLE_TYPES,
    requestedType: "Product",
    proposal: {
      type: "Product",
      jsonLd: {
        "@context": "https://schema.org",
        "@type": "Product",
        name: "Widget",
        offers: {
          "@type": "Offer",
          price: "19.00",
          priceCurrency: "USD",
        },
      },
      properties: [
        { path: "name", value: "Widget", source: "title" },
        {
          path: "offers.price",
          value: "19.00",
          source: "salla.product.price",
        },
      ],
      notes: ["Availability omitted: not observed in this audit."],
    },
    validation: {
      valid: true,
      errors: [],
      richResultEligible: true,
      missingRichResultRequired: [],
      missingRichResultRecommended: ["availability"],
    },
    diff: {
      entries: [
        {
          path: "name",
          status: "kept",
          existing: "Widget",
          proposed: "Widget",
          source: "title",
        },
        {
          path: "offers.price",
          status: "changed",
          existing: "24.00",
          proposed: "19.00",
          source: "salla.product.price",
        },
        {
          path: "offers.availability",
          status: "existing_only",
          existing: "https://schema.org/InStock",
          proposed: null,
          source: null,
        },
      ],
      notes: [],
    },
    reasons: [],
  };
}

function blogResult(inputType: SchemaEntityType): PageSchemaResult {
  return {
    page: {
      id: BLOG_PAGE_ID,
      url: BLOG_URL,
      pageType: "blog",
      extractionState: "STATIC_COMPLETE",
    },
    availableTypes: [
      availableType("Article", true),
      availableType("BlogPosting", true),
      availableType("WebPage", true),
      availableType("Product", false, [
        "Page type product is required for Product.",
      ]),
    ],
    requestedType: inputType,
    proposal: {
      type: inputType,
      jsonLd: {
        "@context": "https://schema.org",
        "@type": inputType,
        headline: "Launch guide",
      },
      properties: [
        { path: "headline", value: "Launch guide", source: "title" },
      ],
      notes: [],
    },
    validation: {
      valid: true,
      errors: [],
      richResultEligible: true,
      missingRichResultRequired: [],
      missingRichResultRecommended: [],
    },
    diff: {
      entries: [
        {
          path: "headline",
          status: "added",
          existing: null,
          proposed: "Launch guide",
          source: "title",
        },
      ],
      notes: [],
    },
    reasons: [],
  };
}

export function getPageSchemaFixture(input: {
  pageId: string;
  type?: SchemaEntityType;
}): PageSchemaResult | null {
  if (input.pageId === PRODUCT_PAGE_ID) {
    if (input.type === "Product") return productResult();
    return {
      page: {
        id: PRODUCT_PAGE_ID,
        url: PRODUCT_URL,
        pageType: "product",
        extractionState: "STATIC_COMPLETE",
      },
      availableTypes: AVAILABLE_TYPES,
      requestedType: input.type ?? null,
      proposal: null,
      validation: null,
      diff: null,
      reasons: input.type
        ? [
            `${input.type} cannot be generated for a product page in this fixture.`,
          ]
        : [],
    };
  }

  if (input.pageId === BLOG_PAGE_ID) {
    if (!input.type) {
      return {
        page: {
          id: BLOG_PAGE_ID,
          url: BLOG_URL,
          pageType: "blog",
          extractionState: "STATIC_COMPLETE",
        },
        availableTypes: blogResult("Article").availableTypes,
        requestedType: null,
        proposal: null,
        validation: null,
        diff: null,
        reasons: [],
      };
    }
    return blogResult(input.type);
  }

  return null;
}
