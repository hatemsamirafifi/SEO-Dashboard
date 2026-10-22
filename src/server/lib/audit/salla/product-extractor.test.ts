import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { extractProduct } from "./product-extractor";
import {
  parseSallaExtractionJson,
  type SallaProductExtraction,
} from "./extraction";

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
    internalLinks?: string[];
  } = {},
) {
  const pageUrl = options.pageUrl ?? "https://store.sa/product/rug-23815";
  return {
    pageUrl,
    pageType: "product" as const,
    structuredDataJson: options.structuredDataJson ?? null,
    bodyText: options.bodyText ?? "",
    h1s: options.h1s ?? [],
    title: "",
    internalLinks: options.internalLinks ?? [],
    $: load(options.html ?? "<html><body></body></html>"),
  };
}

function roundTrip(extracted: SallaProductExtraction): SallaProductExtraction {
  const serialized = JSON.stringify(extracted);
  // The persisted payload must re-read through the same zod contract.
  const parsed = parseSallaExtractionJson(serialized);
  expect(parsed?.kind).toBe("product");
  if (!parsed || parsed.kind !== "product") {
    throw new Error("product extraction did not round-trip");
  }
  return parsed;
}

describe("extractProduct", () => {
  it("extracts fields from a complete JSON-LD product", () => {
    const product = roundTrip(
      extractProduct(
        input({
          pageUrl: "https://store.sa/product/berber-rug-23815",
          structuredDataJson: JSON.stringify({
            "@type": "Product",
            name: "Berber Rug",
            sku: "SKU-1",
            mpn: "MPN-9",
            brand: { "@type": "Brand", name: "Atlas" },
            description: "Hand-woven rug.".repeat(10),
            offers: {
              "@type": "Offer",
              price: 149.99,
              priceCurrency: "SAR",
              availability: "https://schema.org/InStock",
            },
            image: "https://cdn.sa/img/rug.jpg",
          }),
        }),
      ),
    );

    expect(product.name).toEqual({
      value: "Berber Rug",
      from: "structured-data",
    });
    expect(product.sku?.value).toBe("SKU-1");
    expect(product.mpn?.value).toBe("MPN-9");
    expect(product.brand?.value).toBe("Atlas");
    expect(product.price).toEqual({ value: 149.99, from: "structured-data" });
    expect(product.priceRaw?.value).toBe("149.99");
    expect(product.currency).toEqual({ value: "SAR", from: "structured-data" });
    expect(product.availability).toEqual({
      value: "InStock",
      from: "structured-data",
    });
    expect(product.images).toHaveLength(1);
    expect(product.images[0].url).toBe("https://cdn.sa/img/rug.jpg");
    expect(product.images[0].from).toBe("structured-data");
    expect(product.externalId).toEqual({ value: "23815", weak: true });
  });

  it("returns UNKNOWN availability when the ladder finds nothing (D12)", () => {
    const product = extractProduct(
      input({ bodyText: "No stock language anywhere on this page." }),
    );
    expect(product.availability).toEqual({ value: "UNKNOWN", from: null });
  });

  it("climbs the R1 ladder: og meta beats keyword text", () => {
    const product = extractProduct(
      input({
        html: '<meta property="product:availability" content="https://schema.org/OutOfStock">',
        bodyText: "متوفر الآن في المخزون",
      }),
    );
    expect(product.availability).toEqual({
      value: "OutOfStock",
      from: "structured-data",
    });
  });

  it("maps Arabic stock keywords in visible text (html tier)", () => {
    const product = extractProduct(
      input({ bodyText: "هذا المنتج غير متوفر حاليًا" }),
    );
    expect(product.availability).toEqual({ value: "OutOfStock", from: "html" });
  });

  it("reports add-to-cart disabled as OutOfStock before keywords", () => {
    const product = extractProduct(
      input({
        html: "<button data-add-to-cart disabled>أضف إلى السلة</button>",
        bodyText: "in stock",
      }),
    );
    expect(product.availability).toEqual({ value: "OutOfStock", from: "html" });
  });

  it("reads data-stock attributes", () => {
    const product = extractProduct(
      input({ html: '<span data-stock="0">sold out</span>' }),
    );
    expect(product.availability).toEqual({ value: "OutOfStock", from: "html" });
  });

  it("prefers structured-data price over html price per field (R2)", () => {
    const product = extractProduct(
      input({
        structuredDataJson: JSON.stringify({
          "@type": "Product",
          offers: { "@type": "Offer", price: 199, priceCurrency: "SAR" },
        }),
        html: '<span data-price="250">250 SAR</span>',
      }),
    );
    expect(product.price).toEqual({ value: 199, from: "structured-data" });
    expect(product.priceRaw?.from).toBe("structured-data");
    expect(product.currency?.value).toBe("SAR");
  });

  it("falls back to html-tier price markup with locale separators", () => {
    const product = extractProduct(
      input({
        html: '<div class="product-price"><span class="price" data-price="1.234,56"></span></div>',
      }),
    );
    expect(product.price).toEqual({ value: 1234.56, from: "html" });
    expect(product.priceRaw?.value).toBe("1.234,56");
    expect(product.currency).toBeNull();
  });

  it("never defaults currency (D6)", () => {
    const product = extractProduct(
      input({
        structuredDataJson: JSON.stringify({
          "@type": "Product",
          offers: { "@type": "Offer", price: 99 },
        }),
      }),
    );
    expect(product.currency).toBeNull();
  });

  it("keeps compare-at price from html del markup", () => {
    const product = extractProduct(
      input({
        html: '<div class="product-price"><span class="price">99 SAR</span> <del class="old-price">129</del></div>',
      }),
    );
    expect(product.price?.value).toBe(99);
    expect(product.compareAtPrice).toEqual({ value: 129, from: "html" });
  });

  it("records only evidenced variant values; absent price stays null", () => {
    const product = extractProduct(
      input({
        structuredDataJson: JSON.stringify({
          "@type": "Product",
          offers: { "@type": "Offer", price: 200, priceCurrency: "SAR" },
          hasVariant: [
            {
              "@type": "Product",
              name: "Berber Rug - Red",
              sku: "RUG-RED",
              offers: {
                "@type": "Offer",
                price: 220,
                availability: "https://schema.org/OutOfStock",
              },
            },
            {
              "@type": "Product",
              name: "Berber Rug - Blue",
            },
          ],
        }),
      }),
    );
    expect(product.variants).toHaveLength(2);
    expect(product.variants[0].name?.value).toBe("Berber Rug - Red");
    expect(product.variants[0].price).toEqual({
      value: 220,
      from: "structured-data",
    });
    expect(product.variants[0].priceDelta).toEqual({
      value: 20,
      from: "structured-data",
    });
    expect(product.variants[0].availability?.value).toBe("OutOfStock");
    expect(product.variants[1].price).toBeNull();
    expect(product.variants[1].priceDelta).toBeNull();
    expect(product.variants[1].availability).toBeNull();
  });

  it("falls back to the first h1 for name when JSON-LD is absent", () => {
    const product = extractProduct(
      input({ h1s: ["بربري راح كبير  "], html: "<h1>بربري راح كبير</h1>" }),
    );
    expect(product.name?.value).toBe("بربري راح كبير");
    expect(product.name?.from).toBe("html");
  });

  it("deduplicates gallery images against JSON-LD images", () => {
    const product = extractProduct(
      input({
        pageUrl: "https://store.sa/product/a-1",
        structuredDataJson: JSON.stringify({
          "@type": "Product",
          image: "https://cdn.sa/img/a.jpg",
        }),
        html: '<div class="product-gallery"><img src="https://cdn.sa/img/a.jpg" alt="A"><img src="/img/b.jpg" alt="B"></div>',
      }),
    );
    expect(product.images).toHaveLength(2);
    expect(product.images.map((image) => image.url)).toEqual([
      "https://cdn.sa/img/a.jpg",
      "https://store.sa/img/b.jpg",
    ]);
    expect(product.images[0].from).toBe("structured-data");
    expect(product.images[1].from).toBe("html");
    expect(product.images[1].alt).toBe("B");
  });

  it("round-trips through the persisted reader", () => {
    const product = extractProduct(
      input({
        pageUrl: "https://store.sa/product/x-77",
        structuredDataJson: JSON.stringify({
          "@type": "Product",
          name: "X",
          offers: {
            "@type": "Offer",
            price: "12.500",
            priceCurrency: "SAR",
            availability: "OutOfStock",
          },
        }),
        bodyText: "متوفر",
      }),
    );
    const parsed = roundTrip(product);
    expect(parsed.price?.value).toBe(12.5);
    expect(parsed.availability.value).toBe("OutOfStock");
    expect(parsed.externalId).toEqual({ value: "77", weak: true });
  });
});
