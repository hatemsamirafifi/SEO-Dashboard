import type {
  KeywordOpportunitySource,
  KeywordResearchSourceStatus,
} from "@/types/keywords";

const SEARCH_CONSOLE_COUNTRIES = new Map([
  [2818, "egy"],
  [2682, "sau"],
]);

export function getKeywordResearchCountry(
  locationCode: number,
  languageCode: string,
) {
  return languageCode === "ar"
    ? SEARCH_CONSOLE_COUNTRIES.get(locationCode)
    : undefined;
}

export const KEYWORD_SOURCE_LABELS: Record<KeywordOpportunitySource, string> = {
  seranking: "SE Ranking",
  google_ads: "Google Ads Keyword Planner",
  gsc: "Search Console",
  internal: "Project keywords",
};

export const KEYWORD_SOURCE_STATUS_LABELS: Record<
  KeywordResearchSourceStatus,
  string
> = {
  available: "Opportunities found",
  no_coverage: "No matching opportunities",
  unavailable: "Unavailable",
  permission_denied: "Permission denied",
  rate_limited: "Rate limited",
  credit_limit: "Credit or budget limit reached",
  invalid_response: "Invalid provider response",
  skipped: "Skipped",
};
