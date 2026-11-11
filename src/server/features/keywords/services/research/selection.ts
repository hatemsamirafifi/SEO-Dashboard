import { isExactKeywordMatch } from "@/shared/keyword-relevance";
import type { EnrichedKeyword } from "./helpers";

export type KeywordSource = "related" | "suggestions" | "ideas";
export type KeywordMode = "auto" | KeywordSource;
/**
 * Where research rows actually came from. "google_ads" is not requestable as
 * a mode; it's the automatic source for countries Labs doesn't support.
 */
export type ResearchSource = KeywordSource | "google_ads";

export const AUTO_KEYWORD_SOURCES: KeywordSource[] = [
  "suggestions",
  "ideas",
  "related",
];

export const MIN_NON_SEED_FOR_AUTO = 5;

export function countNonSeedKeywords(
  rows: EnrichedKeyword[],
  seedKeyword: string,
): number {
  return rows.filter((row) => !isExactKeywordMatch(row.keyword, seedKeyword))
    .length;
}

export function hasSufficientCoverage(
  rows: EnrichedKeyword[],
  seedKeyword: string,
  threshold: number = MIN_NON_SEED_FOR_AUTO,
): boolean {
  return countNonSeedKeywords(rows, seedKeyword) >= threshold;
}
