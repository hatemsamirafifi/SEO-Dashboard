/** SERP feature blocks rendering (spec 011, US1 — T009/T010).
 *
 *  TDD: these tests FAIL until SerpFeatureBlocks exists (T012).
 *  - T009: labels once per family; zero-feature snapshots render no feature
 *    section; absent item fields render nothing (not dashes/zeros).
 *  - T010: organic positions keep stored numbering with PAA present; PAA
 *    placement renders as an observational annotation, never a position. */
import React from "react";
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { SerpFeatureBlocks } from "./SerpFeatureBlocks";
import type { SerpFeatureBlock } from "@/server/features/serp/featurePresentation";

const BLOCKS: SerpFeatureBlock[] = [
  {
    family: "featuredResult",
    label: "Featured snippet",
    order: 0,
    items: [
      {
        title: "Answer",
        url: "https://example.com/answer",
        domain: "example.com",
        snippet: "The answer is 42.",
      },
    ],
    placement: null,
  },
  {
    family: "peopleAlsoAsk",
    label: "People Also Ask",
    order: 2,
    items: [
      { question: "What is 42?", url: "https://example.com/q1", placement: 3 },
      { question: "Why 42?", url: null, placement: null },
    ],
    placement: 3,
  },
  {
    family: "localPack",
    label: "Local pack",
    order: 1,
    items: [
      {
        title: "Shop",
        url: "https://shop.example",
        domain: "shop.example",
        address: null,
        rating: null,
        reviewCount: null,
      },
    ],
    placement: null,
  },
];

function render(blocks: SerpFeatureBlock[]) {
  return renderToStaticMarkup(
    React.createElement(SerpFeatureBlocks, { blocks }),
  );
}

describe("SerpFeatureBlocks (spec 011, T009)", () => {
  it("renders each observed family label exactly once", () => {
    const html = render(BLOCKS);
    for (const label of ["Featured snippet", "People Also Ask", "Local pack"]) {
      expect(html.match(new RegExp(label, "g"))?.length ?? 0).toBe(1);
    }
    expect(html).toContain("What is 42?");
    expect(html).toContain("Shop");
  });

  it("renders no feature section at all for a zero-feature snapshot", () => {
    expect(render([])).toBe("");
  });

  it("renders absent item fields as nothing — never dashes or zeros", () => {
    const html = render(BLOCKS);
    // The null address/rating/reviewCount of the local-pack item must not
    // surface as placeholder text anywhere in the feature section.
    expect(html).not.toContain("—");
    expect(html).not.toContain("N/A");
    expect(html).not.toMatch(/rating[^<]*0/i);
  });
});

describe("PAA placement honesty (spec 011, T010)", () => {
  it("annotates PAA placement observationally without claiming a position", () => {
    const html = render(BLOCKS);
    // Placement 3 is observed metadata, not an organic rank: the wording
    // must be correlational ("alongside"/"around"), never positional.
    expect(html).toMatch(/alongside|around/i);
    expect(html).not.toMatch(/position 3/i);
  });

  it("never emits numbered positions that could read as organic ranks", () => {
    const html = render(BLOCKS);
    // Organic numbering lives exclusively in the results table (T013 pins
    // stored positions there); feature blocks must not render rank-like
    // "#3"/"No. 3" markers even when placement metadata exists.
    expect(html).not.toMatch(/#\d|No\.\s*\d|rank\s*\d/i);
  });

  it("renders placement-less PAA without any placement claim", () => {
    const html = render([
      {
        family: "peopleAlsoAsk",
        label: "People Also Ask",
        order: 2,
        items: [{ question: "Q?", url: null, placement: null }],
        placement: null,
      },
    ]);
    expect(html).toContain("People Also Ask");
    expect(html).toContain("Q?");
    expect(html).not.toMatch(/alongside|around|position/i);
  });
});
