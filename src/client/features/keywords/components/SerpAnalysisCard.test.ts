import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { SerpResultItem } from "@/types/keywords";

// Mock Workers environment for any imported server functions
vi.mock("cloudflare:workers", () => ({ env: {} }));

// oxlint-disable-next-line import/first -- mocks must load before the component under test
import { SerpAnalysisCard } from "./SerpAnalysisCard";

function baseItem(overrides: Partial<SerpResultItem> = {}): SerpResultItem {
  return {
    rank: 1,
    title: "Example",
    url: "https://example.com/page",
    domain: "example.com",
    description: "Description",
    etv: null,
    estimatedPaidTrafficCost: null,
    referringDomains: null,
    backlinks: null,
    isNew: false,
    rankChange: null,
    ...overrides,
  };
}

function renderCard(items: SerpResultItem[]): string {
  return renderToStaticMarkup(
    React.createElement(SerpAnalysisCard, {
      items,
      keyword: "seo tools",
      loading: false,
      page: 0,
      pageSize: 10,
      onPageChange: () => {},
    }),
  );
}

describe("SerpAnalysisCard competitive row (spec 007)", () => {
  it("renders enriched metrics with explicit 0 vs unavailable semantics", () => {
    const html = renderCard([
      baseItem({
        domainRank: 42,
        pageRank: 38,
        referringDomains: 1200,
        backlinks: 0,
        etv: null,
        metricStatus: "available",
      }),
    ]);
    // Explicit provider zero renders 0; missing renders —.
    expect(html).toContain("Links 0");
    expect(html).toContain("Est.traffic —");
    expect(html).toContain("DR 42");
    expect(html).toContain("PR 38");
    // Successful enrichment carries no status label.
    expect(html).not.toContain("partial");
    expect(html).not.toContain("failed");
  });

  it("renders an explicit failed state without hiding the base row", () => {
    const html = renderCard([
      baseItem({
        domainRank: null,
        pageRank: null,
        referringDomains: null,
        backlinks: null,
        metricStatus: "failed",
      }),
    ]);
    // Base row content always renders.
    expect(html).toContain("Example");
    expect(html).toContain("example.com");
    // Failure is explicit, never a zero.
    expect(html).toContain("failed");
    expect(html).not.toContain("Links 0");
  });

  it("renders no metrics line without enrichment", () => {
    const html = renderCard([baseItem()]);
    expect(html).toContain("Example");
    expect(html).not.toContain("DR ");
    expect(html).not.toContain("Est.traffic");
  });
});

describe("SerpAnalysisCard SERP features (spec 011, T010/T013)", () => {
  it("keeps stored organic positions verbatim when feature blocks render", () => {
    const html = renderToStaticMarkup(
      React.createElement(SerpAnalysisCard, {
        items: [
          baseItem({ rank: 1, title: "One" }),
          baseItem({ rank: 2, title: "Two" }),
          baseItem({ rank: 3, title: "Three" }),
        ],
        features: {
          peopleAlsoAsk: {
            items: [{ question: "Q?", url: null, placement: 2 }],
          },
        },
        keyword: "seo tools",
        loading: false,
        page: 0,
        pageSize: 10,
        onPageChange: () => {},
      }),
    );
    // Stored ranks render in order, unaltered by the PAA block.
    const positions = [...html.matchAll(/<td[^>]*>(\d+)<\/td>/g)].map((m) => m[1]);
    expect(positions).toEqual(["1", "2", "3"]);
    // The observed PAA block renders alongside — never as a numbered row.
    expect(html).toContain("People Also Ask");
    expect(html).toContain("Q?");
  });

  it("renders no feature section when no features were observed", () => {
    const html = renderCard([baseItem()]);
    expect(html).not.toContain("serp-feature-block-");
  });
});
