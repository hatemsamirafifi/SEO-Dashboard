import type { KeywordIntent, MonthlySearch } from "@/types/keywords";

export type EnrichedKeyword = {
  keyword: string;
  searchVolume: number | null;
  trend: MonthlySearch[];
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: KeywordIntent;
  // First-party (Google Ads) additions, present only when the planner
  // supplied the metric — consumers detect availability with `in row`.
  lowTopOfPageBid?: number;
  highTopOfPageBid?: number;
  competitionLevel?: string;
};

export function normalizeKeyword(input: string): string {
  return input.trim().toLowerCase();
}

export function normalizeIntent(raw: string | null | undefined): KeywordIntent {
  if (!raw) return "unknown";
  const value = raw.toLowerCase().trim();
  if (value === "i" || value === "1" || value.includes("inform"))
    return "informational";
  if (value === "c" || value === "3" || value.includes("commerc"))
    return "commercial";
  if (value === "t" || value === "4" || value.includes("transact"))
    return "transactional";
  if (value === "n" || value === "2" || value.includes("navig"))
    return "navigational";
  return "unknown";
}
