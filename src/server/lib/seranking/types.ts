import type { RateLimiterCoordinator } from "./rateLimiter";

export type SeRankingConfig = {
  apiKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  rps?: number;
  rateLimiter?: RateLimiterCoordinator;
};

export type SeRankingSubscription = {
  status: "active" | "inactive" | "expired" | "disabled" | string;
  start_date?: string;
  expiration_date?: string;
  units_limit: number;
  units_left: number;
};

export type SeRankingHistoryTrendItem = {
  date: string;
  volume: number;
};

export type SeRankingKeywordExportItem = {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
  difficulty: number | null;
  intent: string | null;
  history_trend?: SeRankingHistoryTrendItem[];
};

export type SeRankingKeywordSuggestionItem = {
  keyword: string;
  volume: number | null;
  cpc: number | null;
  competition: number | null;
  difficulty: number | null;
  intent?: string | null;
  history_trend?: SeRankingHistoryTrendItem[];
};

export type SeRankingDomainOverview = {
  organic?: {
    base_domain?: string;
    target?: string;
    keywords_count?: number | null;
    traffic_sum?: number | null;
    price_sum?: number | null;
  };
  adv?: {
    base_domain?: string;
    target?: string;
    keywords_count?: number | null;
    traffic_sum?: number | null;
    price_sum?: number | null;
  };
};

export type SeRankingDomainKeywordItem = {
  keyword: string;
  position: number;
  prev_position?: number | null;
  volume?: number | null;
  cpc?: number | null;
  url?: string | null;
  traffic?: number | null;
  difficulty?: number | null;
  intent?: string | null;
};

export type SeRankingDomainPageItem = {
  url: string;
  traffic?: number | null;
  keywords_count?: number | null;
};

export type SeRankingDomainCompetitorItem = {
  domain: string;
  keywords_count?: number | null;
  common_keywords?: number | null;
  traffic?: number | null;
  total_keywords?: number | null;
  avg_position?: number | null;
  visibility?: number | null;
};

export type SeRankingBacklinksSummary = {
  target: string;
  mode?: string;
  total_backlinks: number;
  referring_domains: number;
  referring_ips?: number | null;
  referring_subnets?: number | null;
  dofollow?: number | null;
  nofollow?: number | null;
  domain_inlink_rank?: number | null;
  new_backlinks?: number | null;
  lost_backlinks?: number | null;
  text_links?: number | null;
  image_links?: number | null;
  redirect_links?: number | null;
};

export type SeRankingReferringDomainItem = {
  domain: string;
  backlinks: number;
  inlink_rank?: number | null;
  dofollow?: number | null;
  nofollow?: number | null;
  first_seen?: string | null;
  last_seen?: string | null;
};

export type SeRankingBacklinkItem = {
  source_url: string;
  target_url: string;
  anchor?: string | null;
  inlink_rank?: number | null;
  dofollow?: boolean | null;
  first_seen?: string | null;
  last_seen?: string | null;
};

export type SeRankingBacklinkPageItem = {
  url: string;
  backlinks: number;
  referring_domains?: number | null;
  inlink_rank?: number | null;
};

export type SeRankingBacklinksHistoryItem = {
  date: string;
  count?: number | null;
  backlinks?: number | null;
  referring_domains?: number | null;
  new?: number | null;
  lost?: number | null;
  new_backlinks?: number | null;
  lost_backlinks?: number | null;
  new_referring_domains?: number | null;
  lost_referring_domains?: number | null;
  inlink_rank?: number | null;
};

export type SeRankingAuthorityHistoryItem = {
  date: string;
  inlink_rank?: number | null;
  trust_score?: number | null;
};
