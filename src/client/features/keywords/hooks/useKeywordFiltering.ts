import { useMemo } from "react";
import { sortBy } from "remeda";
import { parseTerms } from "@/client/features/keywords/utils";
import { normalizeArabicKeyword } from "@/shared/keyword-relevance";
import type { KeywordResearchRow } from "@/types/keywords";
import {
  parseIntentFilter,
  type KeywordFilterValues,
} from "@/client/features/keywords/keywordResearchTypes";
import type { SortDir, SortField } from "@/client/features/keywords/components";

export function applyKeywordFiltersAndSort(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}): KeywordResearchRow[] {
  const includeTerms = parseTerms(params.filters.include).map(
    normalizeArabicKeyword,
  );
  const excludeTerms = parseTerms(params.filters.exclude).map(
    normalizeArabicKeyword,
  );
  const selectedIntents = parseIntentFilter(params.filters.intents);

  const filtered = params.rows.filter((row) => {
    const haystack = normalizeArabicKeyword(row.keyword);
    if (
      includeTerms.length > 0 &&
      !includeTerms.every((term) => haystack.includes(term))
    ) {
      return false;
    }
    if (excludeTerms.some((term) => haystack.includes(term))) {
      return false;
    }

    if (selectedIntents.length > 0 && !selectedIntents.includes(row.intent)) {
      return false;
    }

    // Never treat null (missing/unavailable metric) as 0 when filtering by range
    if (params.filters.minVol.trim() !== "") {
      if (
        row.searchVolume == null ||
        row.searchVolume < Number(params.filters.minVol)
      )
        return false;
    }
    if (params.filters.maxVol.trim() !== "") {
      if (
        row.searchVolume == null ||
        row.searchVolume > Number(params.filters.maxVol)
      )
        return false;
    }
    if (params.filters.minCpc.trim() !== "") {
      if (row.cpc == null || row.cpc < Number(params.filters.minCpc))
        return false;
    }
    if (params.filters.maxCpc.trim() !== "") {
      if (row.cpc == null || row.cpc > Number(params.filters.maxCpc))
        return false;
    }
    if (params.filters.minKd.trim() !== "") {
      if (
        row.keywordDifficulty == null ||
        row.keywordDifficulty < Number(params.filters.minKd)
      )
        return false;
    }
    if (params.filters.maxKd.trim() !== "") {
      if (
        row.keywordDifficulty == null ||
        row.keywordDifficulty > Number(params.filters.maxKd)
      )
        return false;
    }
    return true;
  });

  if (params.sortField === "keyword") {
    return sortBy(filtered, [(row) => row.keyword, params.sortDir]);
  }
  if (params.sortField === "searchVolume") {
    const hasRelevanceMetadata = filtered.some(
      (row) =>
        row.matchType !== undefined ||
        row.isWeaklyRelated !== undefined ||
        row.relevanceTier !== undefined,
    );
    if (hasRelevanceMetadata && params.sortDir === "desc") {
      return sortBy(
        filtered,
        [(row) => (row.matchType === "exact" ? 1 : 0), "desc"],
        [(row) => (row.isWeaklyRelated ? 1 : 0), "asc"],
        [
          (row) =>
            row.relevanceTier === "high"
              ? 3
              : row.relevanceTier === "medium"
                ? 2
                : 1,
          "desc",
        ],
        [(row) => row.searchVolume ?? -1, "desc"],
      );
    }
    return sortBy(filtered, [(row) => row.searchVolume ?? -1, params.sortDir]);
  }
  if (params.sortField === "cpc") {
    return sortBy(filtered, [(row) => row.cpc ?? -1, params.sortDir]);
  }
  if (params.sortField === "competition") {
    return sortBy(filtered, [(row) => row.competition ?? -1, params.sortDir]);
  }

  return sortBy(filtered, [
    (row) => row.keywordDifficulty ?? -1,
    params.sortDir,
  ]);
}

export function useKeywordFiltering(params: {
  rows: KeywordResearchRow[];
  filters: KeywordFilterValues;
  sortField: SortField;
  sortDir: SortDir;
}) {
  const filteredRows = useMemo(
    () =>
      applyKeywordFiltersAndSort({
        rows: params.rows,
        filters: params.filters,
        sortField: params.sortField,
        sortDir: params.sortDir,
      }),
    [params.filters, params.rows, params.sortDir, params.sortField],
  );

  const activeFilterCount = useMemo(
    () =>
      Object.values(params.filters).filter((value) => value.trim() !== "")
        .length,
    [params.filters],
  );

  return {
    filteredRows,
    activeFilterCount,
  };
}
