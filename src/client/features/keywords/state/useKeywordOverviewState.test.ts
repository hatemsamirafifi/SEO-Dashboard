import { describe, expect, it } from "vitest";
import type { KeywordResearchRow } from "@/types/keywords";
import { computeKeywordOverviewState } from "./useKeywordOverviewState";

function makeRow(keyword: string, searchVolume: number = 100): KeywordResearchRow {
  return {
    keyword,
    searchVolume,
    trend: [],
    keywordDifficulty: 20,
    cpc: 1.5,
    competition: 0.3,
    intent: "commercial",
  };
}

describe("computeKeywordOverviewState", () => {
  it("hides approximate match notice and selects exact match when seed is in results", () => {
    const seedRow = makeRow("سكاي لايت بولي كربونات", 500);
    const otherRow = makeRow("سعر بولي كربونات", 300);
    const rows = [seedRow, otherRow];

    const result = computeKeywordOverviewState({
      rows,
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: null,
      hasSearched: true,
      isLoading: false,
      lastSearchError: false,
      keywordMode: "auto",
    });

    expect(result.showApproximateMatchNotice).toBe(false);
    expect(result.overviewKeyword).toEqual(seedRow);
  });

  it("shows approximate match notice in auto mode when exact seed is missing from results", () => {
    const row1 = makeRow("مواسير بولي بروبلين", 400);
    const row2 = makeRow("الواح بولي كربونات", 250);
    const rows = [row1, row2];

    const result = computeKeywordOverviewState({
      rows,
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: null,
      hasSearched: true,
      isLoading: false,
      lastSearchError: false,
      keywordMode: "auto",
    });

    expect(result.showApproximateMatchNotice).toBe(true);
    // Overview hero keyword falls back to the top result
    expect(result.overviewKeyword).toEqual(row1);
  });

  it("prioritizes selectedKeyword over seed or fallback row", () => {
    const row1 = makeRow("مواسير بولي بروبلين", 400);
    const row2 = makeRow("الواح بولي كربونات", 250);
    const rows = [row1, row2];

    const result = computeKeywordOverviewState({
      rows,
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: row2,
      hasSearched: true,
      isLoading: false,
      lastSearchError: false,
      keywordMode: "auto",
    });

    expect(result.overviewKeyword).toEqual(row2);
  });

  it("hides approximate match notice while loading or during search error", () => {
    const rows = [makeRow("مواسير بولي بروبلين", 400)];

    const loadingResult = computeKeywordOverviewState({
      rows,
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: null,
      hasSearched: true,
      isLoading: true,
      lastSearchError: false,
      keywordMode: "auto",
    });
    expect(loadingResult.showApproximateMatchNotice).toBe(false);

    const errorResult = computeKeywordOverviewState({
      rows,
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: null,
      hasSearched: true,
      isLoading: false,
      lastSearchError: true,
      keywordMode: "auto",
    });
    expect(errorResult.showApproximateMatchNotice).toBe(false);
  });

  it("returns null overviewKeyword when there are no rows", () => {
    const result = computeKeywordOverviewState({
      rows: [],
      searchedKeyword: "سكاي لايت بولي كربونات",
      selectedKeyword: null,
      hasSearched: true,
      isLoading: false,
      lastSearchError: false,
      keywordMode: "auto",
    });

    expect(result.showApproximateMatchNotice).toBe(false);
    expect(result.overviewKeyword).toBeNull();
  });
});
