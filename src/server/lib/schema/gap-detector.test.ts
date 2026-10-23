import { describe, expect, it } from "vitest";
import { detectSchemaGap } from "@/server/lib/schema/gap-detector";
import { runPageReporters } from "@/server/lib/audit/issues/page-reporters";
import { makePage } from "@/server/lib/audit/issues/page-fixtures";
import { sparseProductJson } from "@/server/lib/audit/issues/page-fixtures";

const COMPLETE_ARTICLE = JSON.stringify({
  "@type": "Article",
  headline: "A useful article",
  image: "https://example.com/a.jpg",
  datePublished: "2026-01-01",
  author: "Someone",
});

const COMPLETE_BREADCRUMB = JSON.stringify({
  "@type": "BreadcrumbList",
  itemListElement: [
    {
      "@type": "ListItem",
      position: 1,
      name: "Home",
      item: "https://example.com/",
    },
  ],
});

describe("detectSchemaGap", () => {
  it("reports a missing Product document on a product page", () => {
    const gap = detectSchemaGap(makePage({ pageType: "product" }));
    expect(gap?.issueType).toBe("schema-gap");
    expect(gap?.details).toEqual({
      gap: "missing",
      schemaType: "Product",
      candidates: ["Product"],
    });
  });

  it("leaves product pages with Salla extraction to the product reporters", () => {
    const page = makePage({
      pageType: "product",
      sallaExtractionJson: sparseProductJson(),
    });
    expect(detectSchemaGap(page)).toBeNull();
    expect(runPageReporters(page).map((issue) => issue.issueType)).toContain(
      "product-schema-missing-required",
    );
    expect(
      runPageReporters(page).map((issue) => issue.issueType),
    ).not.toContain("schema-gap");
  });

  it("reports a missing post document on a blog page", () => {
    const gap = detectSchemaGap(makePage({ pageType: "blog" }));
    expect(gap?.details).toEqual({
      gap: "missing",
      schemaType: "Article",
      candidates: ["Article", "BlogPosting"],
    });
  });

  it("passes a rich-result-eligible Article", () => {
    const page = makePage({
      pageType: "blog",
      structuredDataJson: COMPLETE_ARTICLE,
    });
    expect(detectSchemaGap(page)).toBeNull();
  });

  it("reports an existing Article that is not rich-result eligible", () => {
    const page = makePage({
      pageType: "blog",
      structuredDataJson: JSON.stringify({
        "@type": "Article",
        headline: "Only a headline",
      }),
    });
    const gap = detectSchemaGap(page);
    expect(gap?.details).toMatchObject({
      gap: "incomplete",
      schemaType: "Article",
      missing: ["image", "datePublished", "author"],
    });
  });

  it("does not judge a truncated JSON-LD block", () => {
    const page = makePage({
      pageType: "blog",
      structuredDataJson: JSON.stringify({
        "@type": "Article",
        truncated: true,
      }),
    });
    expect(detectSchemaGap(page)).toBeNull();
  });

  it("reports a missing BreadcrumbList on a category page", () => {
    const gap = detectSchemaGap(makePage({ pageType: "category" }));
    expect(gap?.details).toEqual({
      gap: "missing",
      schemaType: "BreadcrumbList",
      candidates: ["BreadcrumbList"],
    });
  });

  it("passes a complete BreadcrumbList", () => {
    const page = makePage({
      pageType: "category",
      structuredDataJson: COMPLETE_BREADCRUMB,
    });
    expect(detectSchemaGap(page)).toBeNull();
  });

  it("skips unindexable pages", () => {
    expect(
      detectSchemaGap(makePage({ pageType: "category", isIndexable: false })),
    ).toBeNull();
  });

  it("skips pages without a completed static extraction", () => {
    expect(
      detectSchemaGap(
        makePage({ pageType: "category", extractionState: "STATIC_PARTIAL" }),
      ),
    ).toBeNull();
  });

  it("skips page types without a rich-result feature", () => {
    expect(detectSchemaGap(makePage({ pageType: "other" }))).toBeNull();
    expect(detectSchemaGap(makePage({ pageType: null }))).toBeNull();
  });

  it("is emitted by the page reporter pass exactly once", () => {
    const issues = runPageReporters(makePage({ pageType: "category" }));
    expect(
      issues.filter((issue) => issue.issueType === "schema-gap"),
    ).toHaveLength(1);
  });
});
