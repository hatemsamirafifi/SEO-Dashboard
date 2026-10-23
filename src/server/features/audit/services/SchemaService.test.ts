import { beforeEach, describe, expect, it, vi } from "vitest";
import { SchemaService } from "@/server/features/audit/services/SchemaService";

vi.mock("@/server/features/audit/repositories/AuditRepository", () => ({
  AuditRepository: hoistedRepoMocks.AuditRepository,
}));

const hoistedRepoMocks = vi.hoisted(() => ({
  AuditRepository: {
    getAuditPageForProject: vi.fn(),
  },
}));

const repo = hoistedRepoMocks.AuditRepository;

function productExtractionJson() {
  return JSON.stringify({
    kind: "product",
    name: { value: "Widget", from: "structured-data" },
    sku: null,
    mpn: null,
    brand: null,
    description: { value: "A fine widget", from: "html" },
    price: { value: 49.5, from: "structured-data" },
    priceRaw: { value: "49.50", from: "structured-data" },
    compareAtPrice: null,
    compareAtPriceRaw: null,
    currency: { value: "SAR", from: "structured-data" },
    availability: { value: "InStock", from: "structured-data" },
    externalId: null,
    images: [
      {
        url: "https://cdn.example.com/p1.jpg",
        alt: "Widget",
        from: "structured-data",
      },
    ],
    variants: [],
  });
}

function pageRow(over: Record<string, unknown> = {}) {
  return {
    id: "pg1",
    auditId: "a1",
    url: "https://shop.example.com/products/widget",
    statusCode: 200,
    redirectUrl: null,
    title: "Widget",
    metaDescription: "A fine widget",
    canonicalUrl: null,
    robotsMeta: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrderJson: null,
    wordCount: 100,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    imagesJson: null,
    internalLinkCount: 0,
    externalLinkCount: 0,
    hasStructuredData: false,
    hreflangTagsJson: null,
    isIndexable: true,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    crawlDepth: 0,
    inSitemap: true,
    contentHash: null,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    htmlBytes: 1000,
    structuredDataJson: null,
    sallaExtractionJson: productExtractionJson(),
    platform: null,
    platformConfidence: null,
    pageType: "product",
    pageTypeConfidence: 1,
    responseTimeMs: 100,
    ...over,
  };
}

const input = {
  pageId: "pg1",
  auditId: "a1",
  projectId: "p1",
};

describe("SchemaService.getPageSchema", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the page is outside the project scope", async () => {
    repo.getAuditPageForProject.mockResolvedValue(null);

    const result = await SchemaService.getPageSchema(input);

    expect(result).toBeNull();
    expect(repo.getAuditPageForProject).toHaveBeenCalledWith({
      pageId: "pg1",
      auditId: "a1",
      projectId: "p1",
    });
  });

  it("returns type availability without a proposal when no type is requested", async () => {
    repo.getAuditPageForProject.mockResolvedValue(pageRow());

    const result = await SchemaService.getPageSchema(input);

    expect(result?.availableTypes).toHaveLength(12);
    expect(
      result?.availableTypes.find((entry) => entry.type === "Product")?.ok,
    ).toBe(true);
    expect(result?.requestedType).toBeNull();
    expect(result?.proposal).toBeNull();
    expect(result?.validation).toBeNull();
    expect(result?.diff).toBeNull();
    expect(result?.reasons).toEqual([]);
  });

  it("returns the proposal, validation, and diff for a product page", async () => {
    repo.getAuditPageForProject.mockResolvedValue(pageRow());

    const result = await SchemaService.getPageSchema({
      ...input,
      type: "Product",
    });

    expect(result?.requestedType).toBe("Product");
    expect(result?.reasons).toEqual([]);
    expect(result?.proposal?.type).toBe("Product");
    expect(result?.proposal?.jsonLd).toMatchObject({
      name: "Widget",
      offers: { price: 49.5, priceCurrency: "SAR", availability: "InStock" },
    });
    expect(result?.validation?.valid).toBe(true);
    expect(result?.validation?.richResultEligible).toBe(true);
    expect(
      result?.diff?.entries.every((entry) => entry.status === "added"),
    ).toBe(true);
  });

  it("returns refusal reasons when the requested type has no evidence", async () => {
    repo.getAuditPageForProject.mockResolvedValue(pageRow());

    const result = await SchemaService.getPageSchema({
      ...input,
      type: "FAQPage",
    });

    expect(result?.proposal).toBeNull();
    expect(result?.validation).toBeNull();
    expect(result?.reasons).toEqual([
      "No observed FAQPage structured data on this page",
    ]);
  });

  it("never proposes schema from incomplete extractions", async () => {
    repo.getAuditPageForProject.mockResolvedValue(
      pageRow({ extractionState: "RENDERING_REQUIRED" }),
    );

    const result = await SchemaService.getPageSchema({
      ...input,
      type: "Product",
    });

    expect(result?.proposal).toBeNull();
    expect(result?.reasons[0]).toContain("RENDERING_REQUIRED");
  });

  it("tolerates unreadable images JSON", async () => {
    repo.getAuditPageForProject.mockResolvedValue(
      pageRow({ imagesJson: "{not-json" }),
    );

    const result = await SchemaService.getPageSchema({
      ...input,
      type: "WebPage",
    });

    expect(result?.proposal?.type).toBe("WebPage");
    expect(
      result?.proposal?.properties.map((property) => property.path),
    ).not.toContain("primaryImageOfPage.url");
  });
});
