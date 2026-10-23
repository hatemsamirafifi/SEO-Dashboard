import type { InboundStats, LinkingPage } from "./types";

export function makeLinkingPage(
  overrides: Partial<LinkingPage> = {},
): LinkingPage {
  return {
    id: overrides.url ?? "page-1",
    url: "https://example.com/page",
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    title: null,
    h1Text: null,
    metaDescription: null,
    contentHash: null,
    redirectUrl: null,
    wordCount: 500,
    isIndexable: true,
    canonicalUrl: null,
    headerCanonicalUrl: null,
    pageType: null,
    crawlDepth: 2,
    inSitemap: true,
    ...overrides,
  };
}

export function withStructurePages(
  pages: LinkingPage[],
  minimum = 10,
): LinkingPage[] {
  const fillers = Array.from(
    { length: Math.max(0, minimum - pages.length) },
    (_, index) =>
      makeLinkingPage({
        url: `https://example.com/filler-${index}`,
        crawlDepth: 1,
        inSitemap: false,
      }),
  );
  return [...pages, ...fillers];
}

export function emptyStats(url: string): InboundStats {
  return {
    targetUrl: url,
    inboundLinks: 0,
    inboundSources: 0,
    allInboundLinks: 0,
    allInboundSources: 0,
    distinctAnchors: 0,
    emptyAnchors: 0,
    sampleAnchor: null,
  };
}
