/** SERP feature presentation derivation (spec 011, PR7 / S4–S5, S9).
 *
 *  TDD: these tests FAIL until toSerpFeatureBlocks is implemented (T011).
 *  Guarantees under test: observed-only output (no fabrication),
 *  pass-through fidelity, defensive unknown-key sweep, PAA placement. */
import { describe, expect, it, vi } from "vitest";
import {
  SERP_FAMILY_LABELS,
  SERP_FAMILY_ORDER,
  toSerpFeatureBlocks,
} from "./featurePresentation";
import type { SerpFeatureSet } from "./types";

const FULL_FEATURES: SerpFeatureSet = {
  featuredResult: {
    title: "Answer",
    url: "https://example.com/answer",
    domain: "example.com",
    snippet: "The answer is 42.",
  },
  peopleAlsoAsk: {
    items: [
      { question: "What is 42?", url: "https://example.com/q1", placement: 3 },
      { question: "Why 42?", url: null, placement: null },
    ],
  },
  relatedSearches: { items: ["meaning of 42", "42 lore"] },
  localPack: {
    items: [
      {
        title: "Shop",
        url: "https://shop.example",
        domain: "shop.example",
        address: "1 Main St",
        rating: 4.5,
        reviewCount: 120,
      },
    ],
  },
  images: {
    items: [{ url: "https://img.example/a.jpg", title: "A", domain: null }],
  },
  videos: {
    items: [{ url: "https://vid.example/v", title: "V", domain: null }],
  },
  shopping: {
    items: [{ title: "Widget", url: null, domain: null, price: "$9.99" }],
  },
  news: {
    items: [
      {
        title: "N",
        url: null,
        domain: null,
        sourceName: "Wire",
        publishedAt: "2026-09-01T10:00:00Z",
      },
    ],
  },
  knowledgeGraph: {
    title: "Entity",
    url: null,
    domain: null,
    description: "A thing.",
  },
  sitelinks: {
    items: [
      { url: "https://example.com/sub", domain: "example.com", title: "Sub" },
    ],
  },
};

describe("toSerpFeatureBlocks (spec 011)", () => {
  it("renders all ten families in contract order for a full fixture", () => {
    const blocks = toSerpFeatureBlocks(FULL_FEATURES);
    expect(blocks.map((b) => b.family)).toEqual([...SERP_FAMILY_ORDER]);
    expect(blocks.map((b) => b.label)).toEqual(
      [...SERP_FAMILY_ORDER].map((f) => SERP_FAMILY_LABELS[f]),
    );
    expect(blocks.map((b) => b.order)).toEqual(
      [...SERP_FAMILY_ORDER].map((_, i) => i),
    );
  });

  it("emits exactly the observed families — absent families produce nothing", () => {
    const blocks = toSerpFeatureBlocks({
      peopleAlsoAsk: FULL_FEATURES.peopleAlsoAsk,
      localPack: FULL_FEATURES.localPack,
    });
    expect(blocks.map((b) => b.family).toSorted()).toEqual([
      "localPack",
      "peopleAlsoAsk",
    ]);
    // A zero-feature snapshot renders zero blocks (no placeholders).
    expect(toSerpFeatureBlocks({})).toEqual([]);
  });

  it("passes stored items through unchanged (fidelity V2)", () => {
    const blocks = toSerpFeatureBlocks(FULL_FEATURES);
    const byFamily = new Map(blocks.map((b) => [b.family, b]));
    expect(byFamily.get("peopleAlsoAsk")?.items).toEqual(
      FULL_FEATURES.peopleAlsoAsk?.items,
    );
    expect(byFamily.get("localPack")?.items).toEqual(
      FULL_FEATURES.localPack?.items,
    );
    expect(byFamily.get("news")?.items).toEqual(FULL_FEATURES.news?.items);
  });

  it("sweeps exact-duplicate items defensively with a logged note", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const dup = FULL_FEATURES.peopleAlsoAsk?.items[0];
      const blocks = toSerpFeatureBlocks({
        peopleAlsoAsk: { items: [dup!, dup!] },
      });
      expect(blocks).toHaveLength(1);
      expect(blocks[0]?.items).toHaveLength(1);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("drops unknown keys safely instead of throwing (FR-005 defense in depth)", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Object.assign keeps the rogue key without a type assertion: the
      // intersection stays assignable to SerpFeatureSet (all fields optional).
      const withRogue = Object.assign(
        { peopleAlsoAsk: FULL_FEATURES.peopleAlsoAsk },
        { rogueFamily: { items: [] } },
      );
      const blocks = toSerpFeatureBlocks(withRogue);
      expect(blocks.map((b) => b.family)).toEqual(["peopleAlsoAsk"]);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it("exposes stored PAA placement and null fallback when absent (V3)", () => {
    const blocks = toSerpFeatureBlocks({
      peopleAlsoAsk: FULL_FEATURES.peopleAlsoAsk,
    });
    expect(blocks).toHaveLength(1);
    // First item carries placement 3 → block placement honored.
    expect(blocks[0]?.placement).toBe(3);
    const noPlacement = toSerpFeatureBlocks({
      peopleAlsoAsk: {
        items: [{ question: "Q?", url: null, placement: null }],
      },
    });
    expect(noPlacement[0]?.placement).toBeNull();
  });
});
