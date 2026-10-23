import { describe, expect, it } from "vitest";
import { generateSchema, proposeSchemaTypes } from "./generate";
import { validateSchema } from "./validate";
import type {
  SallaBlogExtraction,
  SallaCategoryExtraction,
  SallaProductExtraction,
} from "../audit/salla/extraction";
import type { SchemaPageInput } from "./types";

function pageInput(over: Partial<SchemaPageInput> = {}): SchemaPageInput {
  return {
    url: "https://shop.example.com/products/widget",
    canonicalUrl: null,
    title: "Widget",
    metaDescription: "A fine widget",
    ogTitle: null,
    ogDescription: null,
    ogImage: "https://cdn.example.com/og.jpg",
    images: [{ src: "https://cdn.example.com/a.jpg", alt: "Widget" }],
    pageType: null,
    extractionState: "STATIC_COMPLETE",
    isIndexable: true,
    structuredDataJson: null,
    sallaExtractionJson: null,
    ...over,
  };
}

function productExtraction(
  over: Partial<SallaProductExtraction> = {},
): SallaProductExtraction {
  return {
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
    ...over,
  };
}

function productPage(over: Partial<SchemaPageInput> = {}): SchemaPageInput {
  return pageInput({
    pageType: "product",
    sallaExtractionJson: JSON.stringify(productExtraction()),
    ...over,
  });
}

function categoryPage(over: Partial<SchemaPageInput> = {}): SchemaPageInput {
  const category: SallaCategoryExtraction = {
    kind: "category",
    name: { value: "Widgets", from: "structured-data" },
    path: { value: ["Home", "Widgets", "Gadgets"], from: "html" },
    memberProductUrls: [],
  };
  return pageInput({
    pageType: "category",
    sallaExtractionJson: JSON.stringify(category),
    ...over,
  });
}

function blogPage(over: Partial<SchemaPageInput> = {}): SchemaPageInput {
  const blog: SallaBlogExtraction = {
    kind: "blog",
    title: { value: "How widgets are made", from: "structured-data" },
    datePublished: { value: "2026-01-02", from: "structured-data" },
    dateModified: { value: "2026-02-03", from: "structured-data" },
    author: { value: "Ada Lovelace", from: "structured-data" },
  };
  return pageInput({
    pageType: "blog",
    sallaExtractionJson: JSON.stringify(blog),
    ...over,
  });
}

describe("generateSchema", () => {
  it("emits only observed product properties with provenance", () => {
    const result = generateSchema(productPage(), "Product");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      description: "A fine widget",
      image: ["https://cdn.example.com/p1.jpg"],
      offers: {
        "@type": "Offer",
        price: 49.5,
        url: "https://shop.example.com/products/widget",
        priceCurrency: "SAR",
        availability: "InStock",
      },
    });
    for (const property of result.proposal.properties) {
      expect(property.source.trim().length).toBeGreaterThan(0);
      const topLevel = property.path.split(/[.[]/)[0];
      expect(result.proposal.jsonLd[topLevel]).toBeDefined();
    }
    expect(result.proposal.notes).toEqual([]);
  });

  it("omits offers entirely when no price was observed", () => {
    const result = generateSchema(
      productPage({
        sallaExtractionJson: JSON.stringify(
          productExtraction({
            price: null,
            priceRaw: null,
            currency: null,
            availability: { value: "UNKNOWN", from: null },
          }),
        ),
      }),
      "Product",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd).not.toHaveProperty("offers");
    expect(result.proposal.notes).toContain(
      "No observed price; offers omitted",
    );
    const serialized = JSON.stringify(result.proposal.jsonLd);
    expect(serialized).not.toContain("price");
    expect(serialized).not.toContain("availability");

    const report = validateSchema(result.proposal.jsonLd);
    expect(report.valid).toBe(true);
    expect(report.richResultEligible).toBe(false);
    expect(report.missingRichResultRequired).toContain("offers.price");
  });

  it("refuses pages whose extraction is not complete", () => {
    for (const extractionState of [
      "ACCESS_BLOCKED",
      "RENDERING_REQUIRED",
      "NOT_EXTRACTED",
      "EXTRACTION_FAILED",
    ] as const) {
      const result = generateSchema(
        productPage({ extractionState }),
        "Product",
      );
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.reasons[0]).toContain(extractionState);
    }
  });

  it("refuses a product without extraction evidence", () => {
    const result = generateSchema(
      pageInput({ pageType: "product", sallaExtractionJson: null }),
      "Product",
    );
    expect(result).toEqual({
      ok: false,
      type: "Product",
      reasons: ["No product extraction evidence on this page"],
    });
  });

  it("builds a breadcrumb trail from the observed category path", () => {
    const result = generateSchema(categoryPage(), "BreadcrumbList");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd.itemListElement).toEqual([
      { "@type": "ListItem", position: 1, name: "Home" },
      { "@type": "ListItem", position: 2, name: "Widgets" },
      { "@type": "ListItem", position: 3, name: "Gadgets" },
    ]);
    expect(result.proposal.properties[0]?.source).toBe(
      "extraction.category.path[0]",
    );
  });

  it("prefers an existing BreadcrumbList over the category path", () => {
    const result = generateSchema(
      categoryPage({
        structuredDataJson: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              position: 1,
              name: "Home",
              item: "https://shop.example.com/",
            },
          ],
        }),
      }),
      "BreadcrumbList",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd.itemListElement).toEqual([
      {
        "@type": "ListItem",
        position: 1,
        name: "Home",
        item: "https://shop.example.com/",
      },
    ]);
  });

  it("refuses a breadcrumb without any trail evidence", () => {
    const result = generateSchema(pageInput(), "BreadcrumbList");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain("No breadcrumb evidence");
  });

  it("builds a blog posting from blog extraction evidence", () => {
    const result = generateSchema(blogPage(), "BlogPosting");
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "BlogPosting",
      headline: "How widgets are made",
      datePublished: "2026-01-02",
      dateModified: "2026-02-03",
      author: { "@type": "Person", name: "Ada Lovelace" },
      image: ["https://cdn.example.com/og.jpg"],
      description: "A fine widget",
    });
  });

  it("refuses an article without an observed headline", () => {
    const result = generateSchema(
      pageInput({ title: "", pageType: "blog" }),
      "Article",
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toContain("headline");
  });

  it("builds a WebPage from stored page fields", () => {
    const result = generateSchema(
      pageInput({ canonicalUrl: "https://shop.example.com/canonical" }),
      "WebPage",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "Widget",
      url: "https://shop.example.com/canonical",
      description: "A fine widget",
      primaryImageOfPage: {
        "@type": "ImageObject",
        url: "https://cdn.example.com/og.jpg",
      },
    });
  });

  it("derives the WebSite origin from the page URL", () => {
    const result = generateSchema(pageInput(), "WebSite");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.proposal.jsonLd.url).toBe("https://shop.example.com");
    expect(result.proposal.properties[0]?.source).toContain("derived");
  });

  it("refuses a WebSite when the page URL has no origin", () => {
    const result = generateSchema(pageInput({ url: "not-a-url" }), "WebSite");
    expect(result.ok).toBe(false);
  });

  it("copies only the observed Organization node", () => {
    const result = generateSchema(
      pageInput({
        structuredDataJson: JSON.stringify({
          "@context": "https://schema.org",
          "@type": "Organization",
          name: "Widget Co",
          url: "https://shop.example.com",
        }),
      }),
      "Organization",
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.proposal.jsonLd).toEqual({
      "@context": "https://schema.org",
      "@type": "Organization",
      name: "Widget Co",
      url: "https://shop.example.com",
    });
    expect(
      result.proposal.properties.map((property) => property.source),
    ).toEqual(["json-ld.Organization.name", "json-ld.Organization.url"]);
  });

  it("refuses types with no observed document", () => {
    const result = generateSchema(pageInput(), "FAQPage");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reasons[0]).toBe(
      "No observed FAQPage structured data on this page",
    );
  });

  it("reports availability for every supported type", () => {
    const verdicts = proposeSchemaTypes(productPage());
    expect(verdicts).toHaveLength(12);
    expect(verdicts.find((verdict) => verdict.type === "Product")?.ok).toBe(
      true,
    );
    expect(
      verdicts.find((verdict) => verdict.type === "BreadcrumbList")?.ok,
    ).toBe(false);
    expect(verdicts.find((verdict) => verdict.type === "WebPage")?.ok).toBe(
      true,
    );
  });
});
