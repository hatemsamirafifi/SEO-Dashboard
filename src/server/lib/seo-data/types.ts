import type { BillingCustomerContext } from "@/server/billing/subscription";

export type SEODataType =
  | "keyword_ideas"
  | "keyword_metrics"
  | "serp"
  | "domain_keywords"
  | "domain_overview"
  | "domain_pages"
  | "competitors"
  | "backlinks"
  | "competitive_metrics"
  | "site_audit"
  | "search_console"
  | "bing_search_performance";

export type SEODataRequest = {
  dataType: SEODataType;
  keyword?: string;
  keywords?: string[];
  domain?: string;
  url?: string;
  urls?: string[];
  locationCode?: number;
  languageCode?: string;
  device?: "desktop" | "mobile";
  dateFrom?: string;
  dateTo?: string;
  /** Maximum age of cached data in seconds; 0 = always fresh. */
  maxAgeSeconds?: number;
  /** Caller-attributed billing context. */
  billingCustomer: BillingCustomerContext;
  /** Optional credit feature attribution (e.g. "onboarding"). */
  creditFeature?: string;
  /** Provider-specific constraints passed through. */
  constraints?: Record<string, unknown>;
};

export type SEODataResponse<T = unknown> = {
  dataType: SEODataType;
  provider: string;
  data: T;
  fromCache: boolean;
  fallbackReason?: string;
  durationMs: number;
  /** ISO timestamp of the payload as fetched by the serving provider
   *  (first-party keyword flows only). */
  fetchedAt?: string;
  /** A first-party provider's sanitized failure, attached when a DataForSEO
   *  fallback succeeded after that provider already failed in the walk. */
  firstPartyError?: SEOFirstPartyError;
};

/** Sanitized first-party failure provenance. The classification is built from
 *  the provider's own error taxonomy — upstream response text never leaks
 *  into these fields. */
export type SEOFirstPartyError = {
  provider: string;
  errorClass: string;
  message: string;
  /** Whether a retry later may plausibly succeed. */
  retryable: boolean;
};

export interface SEODataProvider {
  readonly name: string;
  supports(request: SEODataRequest): boolean;
  get(request: SEODataRequest): Promise<unknown>;
}

export type ProviderOutcome =
  | { status: "success"; data: unknown; provider: string }
  | { status: "unsupported" }
  | { status: "unavailable"; reason: string }
  | { status: "budget_exceeded" };
