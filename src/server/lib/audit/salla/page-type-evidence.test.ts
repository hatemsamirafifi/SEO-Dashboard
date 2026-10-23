import { describe, expect, it } from "vitest";
import {
  classifyPageType,
  collectJsonLdTypes,
  matchesProductUrlPattern,
  type PageTypeEvidence,
} from "@/server/lib/audit/salla/page-type-evidence";

const BASE: PageTypeEvidence = {
  structuredDataJson: null,
  ogType: null,
  pageUrl: "https://example.com/page",
  internalProductLinkCount: 0,
  hasAddToCart: false,
};

describe("matchesProductUrlPattern", () => {
  it("matches R3 product URL shapes", () => {
    expect(matchesProductUrlPattern("https://x.sa/product/abc")).toBe(true);
    expect(matchesProductUrlPattern("https://x.sa/items/123")).toBe(true);
  });

  it("matches Salla's trailing category suffix", () => {
    expect(matchesProductUrlPattern("https://x.sa/shoes-c18")).toBe(true);
    expect(matchesProductUrlPattern("https://x.sa/black-car-c80/")).toBe(true);
  });

  it("rejects non-product URLs", () => {
    expect(matchesProductUrlPattern("https://x.sa/blog/post")).toBe(false);
    expect(matchesProductUrlPattern("https://x.sa/")).toBe(false);
  });
});

describe("collectJsonLdTypes", () => {
  it("reads single nodes, @graph arrays, and truncation markers", () => {
    expect(collectJsonLdTypes('{"@type":"Product"}')).toEqual(["Product"]);
    expect(
      collectJsonLdTypes(
        '{"@graph":[{"@type":"Product"},{"@type":"WebSite"}]}',
      ),
    ).toEqual(["Product", "WebSite"]);
    expect(collectJsonLdTypes('{"@type":["Product","Offer"]}')).toEqual([
      "Product",
      "Offer",
    ]);
    expect(collectJsonLdTypes('{"@type":"Product","truncated":true}')).toEqual([
      "Product",
    ]);
  });

  it("tolerates unparseable payloads", () => {
    expect(collectJsonLdTypes('{"@type":')).toEqual([]);
  });
});

describe("classifyPageType", () => {
  it("returns null when no evidence fires at all", () => {
    expect(classifyPageType(BASE)).toBeNull();
  });

  it("never classifies from URL pattern alone (D11)", () => {
    expect(
      classifyPageType({
        ...BASE,
        pageUrl: "https://example.com/product/silk-pillow",
      }),
    ).toBeNull();
    expect(
      classifyPageType({ ...BASE, pageUrl: "https://example.com/shoes-c18" }),
    ).toBeNull();
  });

  it("classifies product from Product JSON-LD", () => {
    const verdict = classifyPageType({
      ...BASE,
      structuredDataJson: '{"@type":"Product"}',
    });
    expect(verdict).toEqual({ type: "product", confidence: 0.6 });
  });

  it("raises product confidence with URL + og:type corroboration", () => {
    const verdict = classifyPageType({
      ...BASE,
      structuredDataJson: '{"@type":"Product"}',
      ogType: "product",
      pageUrl: "https://example.com/product/silk-pillow",
    });
    // 0.6 + 0.3 + 0.3 = 1.2, capped below certainty.
    expect(verdict?.type).toBe("product");
    expect(verdict?.confidence).toBe(0.95);
  });

  it("classifies blog from BlogPosting JSON-LD and og:type article", () => {
    const verdict = classifyPageType({
      ...BASE,
      structuredDataJson: '{"@type":"BlogPosting"}',
      ogType: "article",
    });
    expect(verdict).toEqual({ type: "blog", confidence: 0.9 });
  });

  it("classifies category from repeated internal product links", () => {
    const verdict = classifyPageType({
      ...BASE,
      pageUrl: "https://example.com/category/shoes",
      internalProductLinkCount: 24,
    });
    expect(verdict?.type).toBe("category");
    expect(verdict?.confidence).toBe(0.7);
  });

  it("classifies other from og:type=website with no other evidence", () => {
    const verdict = classifyPageType({ ...BASE, ogType: "website" });
    expect(verdict).toEqual({ type: "other", confidence: 0.3 });
  });

  it("caps the combined confidence below certainty", () => {
    const verdict = classifyPageType({
      ...BASE,
      structuredDataJson: '{"@type":"Product"}',
      ogType: "product",
      pageUrl: "https://example.com/product/x",
      hasAddToCart: true,
    });
    // Four corroborating weights add to 1.6 but the cap holds above them.
    expect(verdict?.type).toBe("product");
    expect(verdict?.confidence).toBe(0.95);
  });

  it("prefers the strongest type when signals disagree", () => {
    // Product JSON-LD (0.6) vs category URL + breadcrumb JSON-LD (0.7):
    // breadcrumb evidence wins only when it has URL support — hmm, no:
    // collectJsonLdTypes reports both Product and BreadcrumbList; JSON-LD's
    // strongest type is Product (checked first), so category totals 0.4+0.3
    // vs product 0.6 → product wins.
    const verdict = classifyPageType({
      ...BASE,
      structuredDataJson:
        '{"@graph":[{"@type":"Product"},{"@type":"BreadcrumbList"}]}',
      pageUrl: "https://example.com/collections/shoes",
    });
    expect(verdict?.type).toBe("product");
  });
});
