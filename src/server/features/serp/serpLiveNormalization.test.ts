/** Live SERP → frozen feature-set normalization (spec 011, US1 wiring).
 *
 *  TDD: FAILS until serpLiveNormalization.ts exists. Every rendered block
 *  must come from a real provider item; unmapped types are ignored; organic
 *  and paid items never become features. */
import { describe, expect, it } from "vitest";
import type { SerpLiveItem } from "@/server/lib/dataforseo/serp";
import { mapLiveItemsToFeatureSet } from "./serpLiveNormalization";

function liveItem(overrides: Partial<SerpLiveItem>): SerpLiveItem {
  return { type: "organic", ...overrides };
}

describe("mapLiveItemsToFeatureSet (spec 011)", () => {
  it("maps observed DataForSEO feature items into frozen families", () => {
    const features = mapLiveItemsToFeatureSet([
      liveItem({
        type: "organic",
        rank_absolute: 1,
        title: "T",
        url: "https://e.com",
        domain: "e.com",
      }),
      liveItem({
        type: "featured_snippet",
        rank_absolute: 0,
        title: "Answer",
        url: "https://e.com/a",
        domain: "e.com",
        description: "The answer.",
      }),
      liveItem({
        type: "people_also_ask",
        rank_absolute: 3,
        title: "What is it?",
        url: "https://e.com/q",
      }),
      liveItem({
        type: "local_pack",
        title: "Shop",
        url: "https://shop.example",
        domain: "shop.example",
      }),
      liveItem({ type: "related_searches", title: "it lore" }),
      liveItem({ type: "paid", title: "Ad", url: "https://ad.example" }),
    ]);
    expect(features.featuredResult).toEqual({
      title: "Answer",
      url: "https://e.com/a",
      domain: "e.com",
      snippet: "The answer.",
    });
    expect(features.peopleAlsoAsk?.items).toEqual([
      { question: "What is it?", url: "https://e.com/q", placement: 3 },
    ]);
    expect(features.localPack?.items[0]).toMatchObject({ title: "Shop" });
    expect(features.relatedSearches?.items).toEqual(["it lore"]);
    // Paid and organic items never become features; unmapped families absent.
    expect(features.shopping).toBeUndefined();
    expect(features.knowledgeGraph).toBeUndefined();
    expect(features.sitelinks).toBeUndefined();
    expect(features.news).toBeUndefined();
  });

  it("returns an empty feature set when no feature items are observed", () => {
    expect(
      mapLiveItemsToFeatureSet([
        liveItem({ type: "organic", title: "T", url: "https://e.com" }),
        liveItem({ type: "paid", title: "Ad" }),
      ]),
    ).toEqual({});
  });

  it("keeps explicit provider zeros/values and never invents missing fields", () => {
    const features = mapLiveItemsToFeatureSet([
      liveItem({
        type: "shopping",
        title: "Widget",
        url: null,
        domain: null,
      }),
    ]);
    expect(features.shopping?.items[0]).toEqual({
      title: "Widget",
      url: null,
      domain: null,
      price: null,
    });
  });
});
