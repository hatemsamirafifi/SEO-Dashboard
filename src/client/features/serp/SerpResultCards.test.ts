/** SERP mobile card view (spec 011, US2 — T016).
 *
 *  TDD: FAILS until SerpResultCards is implemented (T018). Contract:
 *  position/result/summary always visible; metrics behind expansion;
 *  truncation classes applied; feature chips from the same derivation;
 *  enrichment failure annotates without hiding rows. */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SerpResultCards } from "./SerpResultCards";
import type { SerpResultCardRow } from "./SerpResultCards";
import type { SerpFeatureBlock } from "@/server/features/serp/featurePresentation";

const ROWS: SerpResultCardRow[] = [
  {
    position: 1,
    title: "Top result with a fairly long title that must wrap at most twice",
    url: "https://example.com/very/long/path/that/should/ellipsis",
    domain: "example.com",
    summary: "One-line summary of the top result.",
    featureRefs: [],
    metrics: {
      status: "available",
      domainRank: 42,
      pageRank: 38,
      referringDomains: 1200,
      backlinks: 5400,
      etv: 900,
    },
  },
  {
    position: 2,
    title: "Second result",
    url: "https://second.example/page",
    domain: "second.example",
    summary: null,
    featureRefs: ["peopleAlsoAsk"],
    metrics: {
      status: "failed",
      domainRank: null,
      pageRank: null,
      referringDomains: null,
      backlinks: null,
      etv: null,
    },
  },
];

const BLOCKS: SerpFeatureBlock[] = [
  {
    family: "peopleAlsoAsk",
    label: "People Also Ask",
    order: 2,
    items: [{ question: "What is it?", url: null, placement: 2 }],
    placement: 2,
  },
];

function render(
  rows: SerpResultCardRow[] = ROWS,
  blocks: SerpFeatureBlock[] = BLOCKS,
  expandedPositions: number[] = [],
) {
  return renderToStaticMarkup(
    React.createElement(SerpResultCards, { rows, blocks, expandedPositions }),
  );
}

describe("SerpResultCards (spec 011, T016)", () => {
  it("shows position, result, and summary without expansion", () => {
    const html = render();
    expect(html).toContain('data-testid="serp-result-card"');
    expect(html).toContain("Top result with a fairly long title");
    expect(html).toContain("https://example.com/very/long/path");
    expect(html).toContain("One-line summary of the top result.");
  });

  it("keeps metrics behind expansion", () => {
    const collapsed = render();
    expect(collapsed).not.toContain("DR 42");
    expect(collapsed).not.toContain("Links 5400");
    const expanded = render(ROWS, BLOCKS, [1]);
    expect(expanded).toContain("DR 42");
    expect(expanded).toContain("Links 5400");
    // Position 2 stays collapsed: its (absent) metrics must not leak.
    expect(expanded).not.toContain("DR null");
  });

  it("applies truncation classes to title and URL", () => {
    const html = render();
    expect(html).toContain("line-clamp-2");
    expect(html).toContain("truncate");
  });

  it("renders feature chips from the same derivation", () => {
    const html = render();
    expect(html).toContain("People Also Ask");
  });

  it("annotates failed enrichment explicitly while keeping the row", () => {
    const html = render();
    expect(html).toContain("Second result");
    expect(html).toMatch(/unavailable|failed/i);
    expect(html).not.toContain("Links 0");
  });

  it("renders an empty state for zero rows", () => {
    expect(render([], [])).toContain("No SERP details");
  });
});
