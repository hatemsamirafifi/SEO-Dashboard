import { useMemo } from "react";
import type { KeywordMode } from "@/client/features/keywords/keywordResearchTypes";
import type { KeywordResearchRow } from "@/types/keywords";

export function computeKeywordOverviewState({
  rows,
  searchedKeyword,
  selectedKeyword,
  hasSearched,
  isLoading,
  lastSearchError,
}: {
  rows: KeywordResearchRow[];
  searchedKeyword: string;
  selectedKeyword: KeywordResearchRow | null;
  hasSearched: boolean;
  isLoading: boolean;
  lastSearchError: boolean;
  keywordMode?: KeywordMode;
}) {
  const normalizedSeed = searchedKeyword.trim().toLowerCase();
  const hasExactMatchInResults =
    Boolean(normalizedSeed) &&
    rows.some((row) => row.keyword.trim().toLowerCase() === normalizedSeed);

  const showApproximateMatchNotice =
    hasSearched &&
    !isLoading &&
    !lastSearchError &&
    rows.length > 0 &&
    searchedKeyword.trim() !== "" &&
    !hasExactMatchInResults;

  let overviewKeyword: KeywordResearchRow | null = null;
  if (selectedKeyword) {
    overviewKeyword = selectedKeyword;
  } else if (searchedKeyword && rows.length > 0) {
    const seed = rows.find(
      (row) => row.keyword.toLowerCase() === searchedKeyword.toLowerCase(),
    );
    overviewKeyword = seed ?? rows[0];
  } else if (rows.length > 0) {
    overviewKeyword = rows[0];
  }

  return { showApproximateMatchNotice, overviewKeyword };
}

export function useKeywordOverviewState({
  rows,
  searchedKeyword,
  selectedKeyword,
  hasSearched,
  isLoading,
  lastSearchError,
  keywordMode,
}: {
  rows: KeywordResearchRow[];
  searchedKeyword: string;
  selectedKeyword: KeywordResearchRow | null;
  hasSearched: boolean;
  isLoading: boolean;
  lastSearchError: boolean;
  keywordMode?: KeywordMode;
}) {
  return useMemo(
    () =>
      computeKeywordOverviewState({
        rows,
        searchedKeyword,
        selectedKeyword,
        hasSearched,
        isLoading,
        lastSearchError,
        keywordMode,
      }),
    [
      rows,
      searchedKeyword,
      selectedKeyword,
      hasSearched,
      isLoading,
      lastSearchError,
      keywordMode,
    ],
  );
}
