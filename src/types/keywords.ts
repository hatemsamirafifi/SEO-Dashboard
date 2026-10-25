export type KeywordIntent =
  | "informational"
  | "commercial"
  | "transactional"
  | "navigational"
  | "unknown";

export type MonthlySearch = {
  year: number;
  month: number;
  searchVolume: number;
};

export type KeywordResearchRow = {
  keyword: string;
  searchVolume: number | null;
  trend: MonthlySearch[];
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: KeywordIntent;
};

export type SavedKeywordRow = {
  id: string;
  projectId: string;
  keyword: string;
  locationCode: number;
  languageCode: string;
  createdAt: string;
  searchVolume: number | null;
  cpc: number | null;
  competition: number | null;
  keywordDifficulty: number | null;
  intent: string | null;
  monthlySearches: MonthlySearch[];
  fetchedAt: string | null;
  tags: SavedKeywordTag[];
  /** Present when the project's Google Ads identity has a stored planner
   *  estimate covering this keyword; absent otherwise. */
  googleAdsPlanner?: SavedKeywordGoogleAdsPlanner;
};

export type SavedKeywordTag = {
  id: string;
  name: string;
  normalizedName: string;
  /** Palette key (e.g. "blue"). Null = derive a stable color from the id. */
  color: string | null;
};

/** First-party Google Ads Keyword Planner estimate attached to a saved
 *  keyword when the project's Ads identity has one in the normalized
 *  planner storage. Google-native honesty: absent planner metrics stay
 *  null (NOT organic difficulty or DFS competition), money fields are
 *  currency units (planner micros / 1e6) of `currencyCode`, and a variant
 *  keyword shares its canonical group's estimate (`sharedEstimate`) instead
 *  of getting a copied or summed estimate. `fetchedAt` is the serving
 *  planner fetch the numbers came from. */
export type SavedKeywordGoogleAdsPlanner = {
  /** The canonical keyword this estimate belongs to (normalized text). */
  canonicalKeyword: string;
  isCanonical: boolean;
  sharedEstimate: boolean;
  searchVolume: number | null;
  cpc: number | null;
  lowTopOfPageBid: number | null;
  highTopOfPageBid: number | null;
  competitionLevel: "LOW" | "MEDIUM" | "HIGH" | null;
  competitionIndex: number | null;
  currencyCode: string | null;
  fetchedAt: string;
  /** Months Google reported with a volume; a reported null volume is
   *  absent trend data and is omitted (never fabricated to zero). */
  monthlySearches: MonthlySearch[];
};

export type SavedKeywordTagSummary = SavedKeywordTag & {
  keywordCount: number;
};

export type SerpResultItem = {
  rank: number;
  title: string;
  url: string;
  domain: string;
  description: string;
  etv: number | null;
  estimatedPaidTrafficCost: number | null;
  referringDomains: number | null;
  backlinks: number | null;
  isNew: boolean;
  rankChange: number | null;
  // Competitive enrichment overlay (spec 007, additive): present only when
  // the analysis ran with enrichment. etv/referringDomains/backlinks above
  // keep their snapshot values unless enrichment returned better ones.
  domainRank?: number | null;
  pageRank?: number | null;
  spamScore?: number | null;
  stale?: boolean | null;
  provider?: string | null;
  fetchedAt?: string | null;
  // Row enrichment status — mirrors SerpEnrichmentStatus in
  // server/features/serp/types.ts (kept as literals to avoid a
  // shared→server import; the vocabulary is frozen by contract).
  metricStatus?: "available" | "partial" | "unavailable" | "failed";
};
