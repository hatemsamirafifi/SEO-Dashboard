import { describe, expect, it } from "vitest";
import {
  findAnchorDiversityIssues,
  findBrokenLinkIssues,
  findDeepPages,
  findNonIndexableTargetIssues,
  findOrphanCandidates,
  findUnderlinkedCandidates,
  statsFor,
  type InboundStatsMap,
} from "./analyze";
import {
  emptyStats,
  makeLinkingPage,
  withStructurePages,
} from "./test-fixtures";

function statsMap(
  entries: Array<[string, Partial<ReturnType<typeof emptyStats>>]>,
): InboundStatsMap {
  return new Map(
    entries.map(([url, overrides]) => [
      url,
      { ...emptyStats(url), ...overrides },
    ]),
  );
}

describe("findOrphanCandidates", () => {
  const startUrl = "https://example.com/";

  it("flags a crawlable page with no inbound sources", () => {
    const target = makeLinkingPage({ url: "https://example.com/orphan" });
    const findings = findOrphanCandidates({
      pages: [target],
      stats: statsMap([]),
      startUrl,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueType: "orphan-page",
      pageId: target.id,
      pageUrl: target.url,
      targetUrl: null,
    });
  });

  it("excludes the start URL, redirect targets, and non-2xx pages", () => {
    const pages = [
      makeLinkingPage({ url: "https://example.com/" }),
      makeLinkingPage({
        url: "https://example.com/redirected",
        statusCode: 301,
        redirectUrl: "https://example.com/target",
      }),
      makeLinkingPage({
        url: "https://example.com/target",
        redirectUrl: null,
      }),
      makeLinkingPage({
        url: "https://example.com/blocked",
        fetchClass: "blocked",
      }),
      makeLinkingPage({
        url: "https://example.com/not-extracted",
        extractionState: "NOT_EXTRACTED",
      }),
    ];

    const findings = findOrphanCandidates({
      pages,
      stats: statsMap([]),
      startUrl,
    });

    expect(findings.map((finding) => finding.pageUrl)).toEqual([]);
  });

  it("excludes pages with any inbound source, including nofollow links", () => {
    const target = makeLinkingPage({ url: "https://example.com/linked" });
    const findings = findOrphanCandidates({
      pages: [target],
      stats: statsMap([
        ["https://example.com/linked", { allInboundSources: 1 }],
      ]),
      startUrl,
    });

    expect(findings).toEqual([]);
  });
});

describe("findUnderlinkedCandidates", () => {
  const startUrl = "https://example.com/";

  it("flags an indexable sitemap page at depth 2 with one source", () => {
    const target = makeLinkingPage({ url: "https://example.com/deep-guide" });
    const findings = findUnderlinkedCandidates({
      pages: withStructurePages([target]),
      stats: statsMap([
        ["https://example.com/deep-guide", { inboundSources: 1 }],
      ]),
      startUrl,
      crawlCompleted: true,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueType: "underlinked-page",
      details: {
        inboundSources: 1,
        inSitemap: true,
        crawlDepth: 2,
      },
    });
  });

  it("does not flag pages with two or more sources", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findUnderlinkedCandidates({
      pages: withStructurePages([target]),
      stats: statsMap([["https://example.com/guide", { inboundSources: 2 }]]),
      startUrl,
      crawlCompleted: true,
    });

    expect(findings).toEqual([]);
  });

  it("excludes shallow, non-sitemap, non-indexable, utility, and start pages", () => {
    const pages = [
      makeLinkingPage({
        url: "https://example.com/shallow",
        crawlDepth: 1,
      }),
      makeLinkingPage({
        url: "https://example.com/not-in-sitemap",
        inSitemap: false,
      }),
      makeLinkingPage({
        url: "https://example.com/noindex",
        isIndexable: false,
      }),
      makeLinkingPage({
        url: "https://example.com/canonicalized",
        canonicalUrl: "https://example.com/other",
      }),
      makeLinkingPage({ url: "https://example.com/cart" }),
      makeLinkingPage({ url: "https://example.com/" }),
    ];

    const findings = findUnderlinkedCandidates({
      pages: withStructurePages(pages),
      stats: statsMap([]),
      startUrl,
      crawlCompleted: true,
    });

    expect(findings).toEqual([]);
  });

  it("does not run on small audits", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findUnderlinkedCandidates({
      pages: withStructurePages([target], 9),
      stats: statsMap([]),
      startUrl,
      crawlCompleted: true,
    });

    expect(findings).toEqual([]);
  });

  it("returns nothing when the crawl did not complete", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findUnderlinkedCandidates({
      pages: withStructurePages([target]),
      stats: statsMap([]),
      startUrl,
      crawlCompleted: false,
    });

    expect(findings).toEqual([]);
  });
});

describe("findAnchorDiversityIssues", () => {
  it("flags three inbound links with one distinct anchor", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findAnchorDiversityIssues({
      pages: withStructurePages([target]),
      stats: statsMap([
        [
          "https://example.com/guide",
          { inboundLinks: 3, distinctAnchors: 1, sampleAnchor: "Guide" },
        ],
      ]),
      crawlCompleted: true,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({
      issueType: "anchor-text-diversity",
      details: { inboundLinks: 3, distinctAnchors: 1, sampleAnchor: "Guide" },
    });
  });

  it("does not flag diverse anchors or fewer than three links", () => {
    const pages = [
      makeLinkingPage({ url: "https://example.com/diverse" }),
      makeLinkingPage({ url: "https://example.com/sparse" }),
    ];
    const findings = findAnchorDiversityIssues({
      pages: withStructurePages(pages),
      stats: statsMap([
        [
          "https://example.com/diverse",
          { inboundLinks: 3, distinctAnchors: 2 },
        ],
        ["https://example.com/sparse", { inboundLinks: 2, distinctAnchors: 1 }],
      ]),
      crawlCompleted: true,
    });

    expect(findings).toEqual([]);
  });

  it("does not run on small audits", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findAnchorDiversityIssues({
      pages: withStructurePages([target], 9),
      stats: statsMap([
        ["https://example.com/guide", { inboundLinks: 3, distinctAnchors: 1 }],
      ]),
      crawlCompleted: true,
    });

    expect(findings).toEqual([]);
  });

  it("returns nothing when the crawl did not complete", () => {
    const target = makeLinkingPage({ url: "https://example.com/guide" });
    const findings = findAnchorDiversityIssues({
      pages: withStructurePages([target]),
      stats: statsMap([
        ["https://example.com/guide", { inboundLinks: 3, distinctAnchors: 1 }],
      ]),
      crawlCompleted: false,
    });

    expect(findings).toEqual([]);
  });
});

describe("findDeepPages", () => {
  it("flags pages at the deep-page threshold and ignores shallower pages", () => {
    const findings = findDeepPages([
      makeLinkingPage({ url: "https://example.com/deep", crawlDepth: 5 }),
      makeLinkingPage({ url: "https://example.com/shallow", crawlDepth: 4 }),
      makeLinkingPage({ url: "https://example.com/unknown", crawlDepth: null }),
    ]);

    expect(findings.map((finding) => finding.pageUrl)).toEqual([
      "https://example.com/deep",
    ]);
  });
});

describe("link edge findings", () => {
  it("maps broken edges with the target URL as the dedupe key", () => {
    const findings = findBrokenLinkIssues([
      {
        sourcePageId: "source",
        sourceUrl: "https://example.com/source",
        targetUrl: "https://example.com/missing",
        targetStatus: 404,
      },
    ]);

    expect(findings[0]).toMatchObject({
      issueType: "broken-internal-link",
      dedupeKey: "https://example.com/missing",
      details: {
        targetUrl: "https://example.com/missing",
        targetStatus: 404,
      },
    });
  });

  it("maps non-indexable target edges", () => {
    const findings = findNonIndexableTargetIssues([
      {
        sourcePageId: "source",
        sourceUrl: "https://example.com/source",
        targetUrl: "https://example.com/account",
        reason: "noindex",
        canonicalUrl: null,
      },
    ]);

    expect(findings[0]).toMatchObject({
      issueType: "link-to-noindex-page",
      dedupeKey: "https://example.com/account",
      details: {
        targetUrl: "https://example.com/account",
        reason: "noindex",
      },
    });
  });
});

describe("statsFor", () => {
  it("returns zeroed stats for unknown URLs", () => {
    expect(statsFor(new Map(), "https://example.com/missing")).toEqual(
      emptyStats("https://example.com/missing"),
    );
  });
});
