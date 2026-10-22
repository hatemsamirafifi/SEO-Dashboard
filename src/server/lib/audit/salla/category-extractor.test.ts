import { describe, expect, it } from "vitest";
import * as cheerio from "cheerio";
import type { CheerioAPI } from "cheerio";
import { extractCategory } from "./category-extractor";
import { parseSallaExtractionJson } from "./extraction";

function load(html: string): CheerioAPI {
  return cheerio.load(html);
}

function input(
  options: {
    structuredDataJson?: string | null;
    pageUrl?: string;
    h1s?: string[];
    internalLinks?: string[];
  } = {},
) {
  const pageUrl = options.pageUrl ?? "https://store.sa/c/rugs-c18";
  return {
    pageUrl,
    pageType: "category" as const,
    structuredDataJson: options.structuredDataJson ?? null,
    bodyText: "",
    h1s: options.h1s ?? [],
    title: "",
    internalLinks: options.internalLinks ?? [],
    $: load("<html><body></body></html>"),
  };
}

describe("extractCategory", () => {
  it("derives path and name from a breadcrumb that ends on home", () => {
    const category = extractCategory(
      input({
        structuredDataJson: JSON.stringify({
          "@type": "BreadcrumbList",
          itemListElement: [
            {
              "@type": "ListItem",
              name: "الرئيسية",
              item: "https://store.sa/",
            },
            {
              "@type": "ListItem",
              name: "الأغطية",
              item: "https://store.sa/c/rugs-c18",
            },
          ],
        }),
      }),
    );
    expect(category.path?.value).toEqual(["الرئيسية", "الأغطية"]);
    expect(category.name).toEqual({
      value: "الأغطية",
      from: "structured-data",
    });
  });

  it("harvests member products from ItemList structured data", () => {
    const category = extractCategory(
      input({
        structuredDataJson: JSON.stringify({
          "@type": "ItemList",
          name: "Rugs",
          itemListElement: [
            { "@type": "ListItem", item: "https://store.sa/product/rug-a-11" },
            { "@type": "ListItem", item: "https://store.sa/product/rug-b-12" },
            { "@type": "ListItem", item: "https://blog.sa/other" },
          ],
        }),
        internalLinks: [
          "https://store.sa/product/rug-c-13",
          "https://store.sa/c/rugs-c18?page=2",
          "https://evil.sa/product/rug-x",
        ],
      }),
    );
    expect(category.name?.value).toBe("Rugs");
    expect(category.memberProductUrls[0]).toEqual({
      url: "https://store.sa/product/rug-a-11",
      from: "structured-data",
    });
    // Only the 3 product-pattern internal links qualify (11..13 + none else).
    const urls = category.memberProductUrls.map((member) => member.url);
    expect(urls).toContain("https://store.sa/product/rug-b-12");
    expect(urls).toContain("https://store.sa/product/rug-c-13");
    expect(urls).not.toContain("https://store.sa/c/rugs-c18?page=2");
    expect(urls).not.toContain("https://evil.sa/product/rug-x");
    // The listing-page member association is crawl evidence per the plan.
    const persisted = parseSallaExtractionJson(JSON.stringify(category));
    expect(persisted?.kind).toBe("category");
    expect(
      persisted?.kind === "category" ? persisted.memberProductUrls.length : 0,
    ).toBeGreaterThanOrEqual(3);
  });

  it("falls back to the first visible h1 when structured data names nothing", () => {
    const category = extractCategory(
      input({
        h1s: ["سجاد كلاسيكي"],
        internalLinks: ["https://store.sa/product/rug-d-14"],
      }),
    );
    expect(category.name).toEqual({ value: "سجاد كلاسيكي", from: "html" });
    expect(category.path).toBeNull();
    expect(category.memberProductUrls).toHaveLength(1);
    expect(category.memberProductUrls[0].from).toBe("html");
  });

  it("caps member URL harvesting at 50", () => {
    const structured = {
      "@type": "ItemList",
      itemListElement: Array.from({ length: 80 }, (_, index) => ({
        "@type": "ListItem",
        item: `https://store.sa/product/p-${index}`,
      })),
    };
    const category = extractCategory(
      input({ structuredDataJson: JSON.stringify(structured) }),
    );
    expect(category.memberProductUrls).toHaveLength(50);
  });
});
