import { describe, expect, it } from "vitest";
import {
  findCanonicalIssues,
  findDuplicates,
  findRedirectChainsAndLoops,
  type SlimPage,
} from "@/server/lib/audit/issues/multipage-checks";

describe("findDuplicates", () => {
  it("flags duplicate titles across pages and includes the other URLs", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({ url: "https://example.com/b", title: "Same" }),
      makeSlimPage({ url: "https://example.com/c", title: "Different" }),
    ]);
    const duplicateTitles = issues.filter(
      (issue) => issue.issueType === "duplicate-title",
    );
    expect(duplicateTitles).toHaveLength(2);
    expect(duplicateTitles[0].details?.otherUrls).toEqual([
      "https://example.com/b",
    ]);
  });

  it("excludes noindexed and canonicalized pages from duplicate groups", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({
        url: "https://example.com/b",
        title: "Same",
        canonicalUrl: "https://example.com/a",
      }),
      makeSlimPage({
        url: "https://example.com/c",
        title: "Same",
        isIndexable: false,
      }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("ignores non-2xx and blocked pages", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Same" }),
      makeSlimPage({
        url: "https://example.com/b",
        title: "Same",
        fetchClass: "blocked",
        statusCode: 403,
      }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("groups duplicate content by hash only when there is text", () => {
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", contentHash: "h1" }),
      makeSlimPage({ url: "https://example.com/b", contentHash: "h1" }),
      makeSlimPage({
        url: "https://example.com/empty-1",
        contentHash: "h2",
        wordCount: 0,
      }),
      makeSlimPage({
        url: "https://example.com/empty-2",
        contentHash: "h2",
        wordCount: 0,
      }),
    ]);
    expect(
      issues.filter((issue) => issue.issueType === "duplicate-content"),
    ).toHaveLength(2);
  });

  it("excludes app shells (RENDERING_REQUIRED) from duplicate groups", () => {
    // N client-rendered pages sharing a placeholder "Loading…" title are
    // not a confirmed duplicate-title verdict — the audit never read their
    // real content.
    const issues = findDuplicates([
      makeSlimPage({ url: "https://example.com/a", title: "Loading…" }),
      makeSlimPage({
        url: "https://example.com/b",
        title: "Loading…",
        extractionState: "RENDERING_REQUIRED",
      }),
      makeSlimPage({
        url: "https://example.com/c",
        title: "Loading…",
        extractionState: "RENDERING_REQUIRED",
      }),
    ]);
    expect(issues).toHaveLength(0);
  });

  it("excludes truncated (STATIC_PARTIAL) bodies from duplicate-content", () => {
    const issues = findDuplicates([
      makeSlimPage({
        url: "https://example.com/a",
        contentHash: "h1",
        extractionState: "STATIC_PARTIAL",
      }),
      makeSlimPage({
        url: "https://example.com/b",
        contentHash: "h1",
        extractionState: "STATIC_PARTIAL",
      }),
    ]);
    expect(issues).toHaveLength(0);
  });
});

describe("findRedirectChainsAndLoops", () => {
  const redirect = (url: string, target: string) =>
    makeSlimPage({ url, statusCode: 301, redirectUrl: target });

  it("ignores single redirects", () => {
    expect(
      findRedirectChainsAndLoops([
        redirect("https://example.com/a", "https://example.com/b"),
        makeSlimPage({ url: "https://example.com/b" }),
      ]),
    ).toHaveLength(0);
  });

  it("flags a chain once, on its head", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/b"),
      redirect("https://example.com/b", "https://example.com/c"),
      makeSlimPage({ url: "https://example.com/c" }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe("redirect-chain");
    expect(issues[0].pageUrl).toBe("https://example.com/a");
    expect(issues[0].details?.hops).toEqual([
      "https://example.com/a",
      "https://example.com/b",
      "https://example.com/c",
    ]);
  });

  it("flags loops", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/b"),
      redirect("https://example.com/b", "https://example.com/a"),
    ]);
    expect(
      issues.filter((issue) => issue.issueType === "redirect-loop").length,
    ).toBeGreaterThan(0);
  });

  it("flags self-loops", () => {
    const issues = findRedirectChainsAndLoops([
      redirect("https://example.com/a", "https://example.com/a"),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0].issueType).toBe("redirect-loop");
  });
});

describe("findCanonicalIssues", () => {
  const loop = (url: string) =>
    makeSlimPage({ url, statusCode: 301, redirectUrl: url });

  it("flags catalog pages whose canonical lands inside a loop", () => {
    const issues = findCanonicalIssues([
      loop("https://example.com/loop"),
      makeSlimPage({
        url: "https://example.com/product/rug",
        pageType: "product",
        canonicalUrl: "https://example.com/loop",
      }),
    ]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      issueType: "canonical-redirect-loop",
      pageUrl: "https://example.com/product/rug",
      details: { canonicalUrl: "https://example.com/loop" },
    });
  });

  it("flags categories with a looping canonical", () => {
    expect(
      findCanonicalIssues([
        loop("https://example.com/loop"),
        makeSlimPage({
          url: "https://example.com/category/shoes",
          pageType: "category",
          canonicalUrl: "https://example.com/loop",
        }),
      ]),
    ).toHaveLength(1);
  });

  it("skips a chain head that is not a loop member", () => {
    // A -> B terminates at B, so A is a chain member but not in a cycle.
    const chainHead = makeSlimPage({
      url: "https://example.com/a",
      statusCode: 301,
      redirectUrl: "https://example.com/b",
    });
    expect(
      findCanonicalIssues([
        chainHead,
        makeSlimPage({ url: "https://example.com/b" }),
        makeSlimPage({
          url: "https://example.com/product/rug",
          pageType: "product",
          canonicalUrl: "https://example.com/a",
        }),
      ]),
    ).toHaveLength(0);
  });

  it("only judges complete product or category extractions", () => {
    const loopPage = loop("https://example.com/loop");
    expect(
      findCanonicalIssues([
        loopPage,
        // Generic page: no pageType verdict, no catalog check.
        makeSlimPage({
          url: "https://example.com/generic",
          canonicalUrl: "https://example.com/loop",
        }),
        // Partial extraction: not a completed static crawl.
        makeSlimPage({
          url: "https://example.com/product/partial-rug",
          pageType: "product",
          extractionState: "STATIC_PARTIAL",
          canonicalUrl: "https://example.com/loop",
        }),
        // Same-url canonical (self canonical) can never "land in" the loop.
        makeSlimPage({
          url: "https://example.com/product/self-canonical",
          pageType: "product",
          canonicalUrl: "https://example.com/product/self-canonical",
        }),
      ]),
    ).toHaveLength(0);
  });
});

function makeSlimPage(overrides: Partial<SlimPage>): SlimPage {
  return {
    id: overrides.url ?? "page",
    url: "https://example.com/a",
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    title: null,
    metaDescription: null,
    contentHash: null,
    redirectUrl: null,
    wordCount: 100,
    isIndexable: true,
    canonicalUrl: null,
    headerCanonicalUrl: null,
    pageType: null,
    ...overrides,
  };
}
