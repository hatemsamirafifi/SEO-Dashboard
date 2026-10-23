import { describe, expect, it } from "vitest";
import { validateSchema } from "./validate";

describe("validateSchema", () => {
  it("accepts a complete product as valid and rich-result eligible", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
      image: ["https://cdn.example.com/p1.jpg"],
      description: "A fine widget",
      offers: {
        "@type": "Offer",
        price: 49.5,
        priceCurrency: "SAR",
        availability: "InStock",
      },
    });
    expect(report).toEqual({
      valid: true,
      errors: [],
      richResultEligible: true,
      missingRichResultRequired: [],
      missingRichResultRecommended: ["brand", "sku"],
    });
  });

  it("keeps structural validity separate from rich-result eligibility", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "Product",
      name: "Widget",
    });
    expect(report.valid).toBe(true);
    expect(report.errors).toEqual([]);
    expect(report.richResultEligible).toBe(false);
    expect(report.missingRichResultRequired).toEqual(["image", "offers.price"]);
  });

  it("marks an article valid but ineligible without Google's required set", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "Article",
      headline: "How widgets are made",
    });
    expect(report.valid).toBe(true);
    expect(report.richResultEligible).toBe(false);
    expect(report.missingRichResultRequired).toEqual([
      "image",
      "datePublished",
      "author",
    ]);
  });

  it("returns a null eligibility for types without a Google rich result", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "Service",
      name: "Widget installation",
    });
    expect(report.valid).toBe(true);
    expect(report.richResultEligible).toBeNull();
    expect(report.missingRichResultRequired).toEqual([]);
  });

  it("rejects an unsupported @type", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "Unicorn",
      name: "Nope",
    });
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(["No supported @type on document"]);
  });

  it("reports missing structural properties per type", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "LocalBusiness",
      name: "Widget Co",
    });
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(["Missing required property: address"]);
  });

  it("checks array elements for breadcrumb item URLs", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "BreadcrumbList",
      itemListElement: [
        { "@type": "ListItem", position: 1, name: "Home" },
        { "@type": "ListItem", position: 2, name: "Widgets" },
      ],
    });
    expect(report.valid).toBe(true);
    expect(report.richResultEligible).toBe(true);
    expect(report.missingRichResultRecommended).toEqual([
      "itemListElement.item",
    ]);
  });

  it("treats blank strings as missing values", () => {
    const report = validateSchema({
      "@context": "https://schema.org",
      "@type": "WebPage",
      name: "   ",
      url: "https://shop.example.com",
    });
    expect(report.valid).toBe(false);
    expect(report.errors).toEqual(["Missing required property: name"]);
  });
});
