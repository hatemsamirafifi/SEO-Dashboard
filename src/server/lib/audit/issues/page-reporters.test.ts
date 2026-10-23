import { describe, expect, it } from "vitest";
import { runPageReporters } from "@/server/lib/audit/issues/page-reporters";
import type { CrawledPageResult } from "@/server/lib/audit/types";
import { getIssueDescriptor } from "@/shared/audit-issues";
import {
  completeProductJson,
  HEALTHY_LINK,
  makePage,
  sparseProductJson,
} from "@/server/lib/audit/issues/page-fixtures";

function issueTypes(page: CrawledPageResult): string[] {
  return runPageReporters(page).map((issue) => issue.issueType);
}

describe("runPageReporters", () => {
  it("reports nothing for a healthy page", () => {
    expect(issueTypes(makePage({}))).toEqual([]);
  });

  it("reports only blocked-page for a blocked fetch", () => {
    expect(
      issueTypes(makePage({ fetchClass: "blocked", statusCode: 403 })),
    ).toEqual(["blocked-page"]);
  });

  it("reports only crawl-error for a failed fetch", () => {
    expect(
      issueTypes(
        makePage({
          fetchClass: "error",
          statusCode: 0,
          failureReason: "network_error",
        }),
      ),
    ).toEqual(["crawl-error"]);
  });

  it("classifies error statuses by range", () => {
    expect(issueTypes(makePage({ statusCode: 500 }))).toEqual(["server-error"]);
    expect(issueTypes(makePage({ statusCode: 404 }))).toEqual(["broken-page"]);
    expect(
      issueTypes(
        makePage({
          statusCode: 301,
          redirectUrl: "https://example.com/b",
        }),
      ),
    ).toEqual([]);
  });

  it("checks titles and meta descriptions", () => {
    expect(issueTypes(makePage({ title: "" }))).toContain("missing-title");
    expect(issueTypes(makePage({ title: "x".repeat(70) }))).toContain(
      "title-too-long",
    );
    expect(issueTypes(makePage({ title: "Tiny" }))).toContain(
      "title-too-short",
    );
    expect(issueTypes(makePage({ metaDescription: "" }))).toContain(
      "missing-meta-description",
    );
    expect(
      issueTypes(makePage({ metaDescription: "x".repeat(200) })),
    ).toContain("meta-description-too-long");
    expect(issueTypes(makePage({ metaDescription: "x".repeat(69) }))).toContain(
      "meta-description-too-short",
    );
    expect(
      issueTypes(makePage({ metaDescription: "x".repeat(70) })),
    ).not.toContain("meta-description-too-short");
    expect(
      runPageReporters(makePage({ metaDescription: "x".repeat(69) })).find(
        (issue) => issue.issueType === "meta-description-too-short",
      )?.details,
    ).toEqual({ length: 69 });
  });

  it("checks headings", () => {
    expect(issueTypes(makePage({ h1Count: 0 }))).toContain("missing-h1");
    expect(issueTypes(makePage({ h1Count: 3 }))).toContain("multiple-h1");
    expect(issueTypes(makePage({ headingOrder: [1, 2, 4] }))).toContain(
      "heading-order-skip",
    );
  });

  it("skips content checks for non-HTML responses", () => {
    const nonHtml = makePage({
      isHtml: false,
      title: "",
      metaDescription: "",
      h1Count: 0,
      headingOrder: [],
      wordCount: 0,
      contentHash: null,
    });
    expect(issueTypes(nonHtml)).toEqual([]);
  });

  it("still checks empty-shell HTML pages", () => {
    const shell = makePage({
      isHtml: true,
      title: "",
      metaDescription: "",
      h1Count: 0,
      headingOrder: [],
      wordCount: 0,
      contentHash: null,
    });
    const types = issueTypes(shell);
    expect(types).toContain("missing-title");
    expect(types).toContain("missing-h1");
    expect(types).toContain("thin-content");
  });

  it("flags indexability and canonical signals", () => {
    expect(
      issueTypes(makePage({ isIndexable: false, robotsMeta: "noindex" })),
    ).toContain("noindex-page");

    const conflicted = issueTypes(
      makePage({
        canonicalUrl: "https://example.com/canonical-a",
        headerCanonicalUrl: "https://example.com/canonical-b",
      }),
    );
    expect(conflicted).toContain("canonical-conflict");
    expect(conflicted).toContain("canonicalized-page");

    expect(
      issueTypes(makePage({ canonicalUrl: "https://example.com/a" })),
    ).not.toContain("canonicalized-page");
  });

  it("flags thin content only on indexable pages", () => {
    expect(issueTypes(makePage({ wordCount: 50 }))).toContain("thin-content");
    expect(
      issueTypes(
        makePage({ wordCount: 50, isIndexable: false, robotsMeta: "noindex" }),
      ),
    ).not.toContain("thin-content");
  });

  it("flags slow responses and deep pages", () => {
    expect(issueTypes(makePage({ responseTimeMs: 3000 }))).toContain(
      "slow-response",
    );
    expect(issueTypes(makePage({ crawlDepth: 6 }))).toContain("deep-page");
    expect(issueTypes(makePage({ crawlDepth: null }))).not.toContain(
      "deep-page",
    );
  });

  it("flags indexable pages with no outgoing links", () => {
    expect(issueTypes(makePage({ links: [] }))).toContain("no-outgoing-links");
    expect(
      issueTypes(makePage({ links: [], isIndexable: false })),
    ).not.toContain("no-outgoing-links");
    expect(issueTypes(makePage({ links: [HEALTHY_LINK] }))).not.toContain(
      "no-outgoing-links",
    );
  });
});

describe("canonical verdicts on catalog and generic pages", () => {
  it("replaces canonicalized-page with canonical-cross-domain on products", () => {
    const page = makePage({
      pageType: "product",
      canonicalUrl: "https://other-store.example/catalog/latest",
      sallaExtractionJson: completeProductJson(),
    });
    const types = issueTypes(page);
    expect(types).not.toContain("canonicalized-page");
    const crossDomain = runPageReporters(page).find(
      (reported) => reported.issueType === "canonical-cross-domain",
    );
    expect(crossDomain?.details).toEqual({
      canonicalUrl: "https://other-store.example/catalog/latest",
      pageOrigin: "https://example.com",
      canonicalOrigin: "https://other-store.example",
    });
  });

  it("replaces canonicalized-page with canonical-cross-domain on categories", () => {
    const types = issueTypes(
      makePage({
        pageType: "category",
        canonicalUrl: "https://mirror-store.example/sale",
      }),
    );
    expect(types).toContain("canonical-cross-domain");
    expect(types).not.toContain("canonicalized-page");
  });

  it("keeps same-origin canonicalization as canonicalized-page", () => {
    const types = issueTypes(
      makePage({
        pageType: "product",
        canonicalUrl: "https://example.com/products/fresh-look",
        sallaExtractionJson: completeProductJson(),
      }),
    );
    expect(types).toContain("canonicalized-page");
    expect(types).not.toContain("canonical-cross-domain");
  });

  it("leaves generic-page canonicalization untouched", () => {
    const types = issueTypes(
      makePage({
        canonicalUrl: "https://elsewhere.example/moved",
      }),
    );
    expect(types).toContain("canonicalized-page");
    expect(types).not.toContain("canonical-cross-domain");
  });
});

describe("product schema ghosts on completed extractions", () => {
  it("flags required and recommended gaps on a completed product", () => {
    const issues = runPageReporters(
      makePage({
        pageType: "product",
        sallaExtractionJson: sparseProductJson(),
        canonicalUrl: "https://example.com/a",
      }),
    );
    const required = issues.find(
      (issue) => issue.issueType === "product-schema-missing-required",
    );
    const recommended = issues.find(
      (issue) => issue.issueType === "product-schema-missing-recommended",
    );
    expect(required?.details?.fields).toEqual([
      "name",
      "image",
      "offers.price",
    ]);
    expect(getIssueDescriptor(required?.issueType ?? "")?.severity).toBe(
      "warning",
    );
    expect(recommended?.details?.fields).toEqual([
      "offers.priceCurrency",
      "offers.availability",
    ]);
    expect(getIssueDescriptor(recommended?.issueType ?? "")?.severity).toBe(
      "info",
    );
  });

  it("reports nothing extra for a complete structured product", () => {
    expect(
      issueTypes(
        makePage({
          pageType: "product",
          sallaExtractionJson: completeProductJson(),
        }),
      ),
    ).toEqual([]);
  });

  it("skips schema checks without a product verdict or a completed extraction", () => {
    // The sparse JSON would flag issues on a product page; these gates must
    // keep it silent.
    const sparse = sparseProductJson();
    expect(issueTypes(makePage({ sallaExtractionJson: sparse }))).toEqual([]);
    expect(
      issueTypes(
        makePage({
          pageType: "product",
          extractionState: "STATIC_PARTIAL",
          sallaExtractionJson: sparse,
        }),
      ),
    ).toEqual([]);
  });
});
