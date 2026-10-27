import type {
  GoogleAdsAdGroupBreakdown,
  GoogleAdsCampaignBreakdown,
  GoogleAdsDeviceBreakdown,
  GoogleAdsKeywordBreakdown,
  GoogleAdsLandingPageBreakdown,
  GoogleAdsSearchTermBreakdown,
} from "@/server/features/google-ads/services/googleAdsAnalyticsBreakdowns";
import type { GoogleAdsAnalyticsOverview } from "@/server/features/google-ads/services/GoogleAdsAnalyticsService";
import type {
  GoogleAdsKpiMetric,
  GoogleAdsKpiTotals,
} from "@/server/features/google-ads/services/googleAdsAnalyticsMath";
import type { GoogleAdsDiscoveredCustomer } from "@/server/features/google-ads/services/googleAdsDiscovery";
import type { GoogleAdsSyncState } from "@/server/features/google-ads/services/GoogleAdsAnalyticsService";

/** Client-side structural types for the Google Ads server-function envelopes
 *  and the shared discovery shapes (types only: the server modules themselves
 *  are never imported at runtime here). */

export type {
  GoogleAdsAdGroupBreakdown,
  GoogleAdsCampaignBreakdown,
  GoogleAdsDeviceBreakdown,
  GoogleAdsKeywordBreakdown,
  GoogleAdsLandingPageBreakdown,
  GoogleAdsSearchTermBreakdown,
  GoogleAdsAnalyticsOverview,
  GoogleAdsKpiMetric,
  GoogleAdsKpiTotals,
  GoogleAdsDiscoveredCustomer,
  GoogleAdsSyncState,
};

/** Structural view of the stored coverage envelope (status union matches
 *  GoogleAdsCoverageStatus from the analytics math). */
export type GoogleAdsCoverageLike = {
  status: "uncovered" | "covered-empty" | "covered" | "partial";
  coveredDates: number;
  totalDates: number;
  firstCoveredDate: string | null;
  lastCoveredDate: string | null;
};

/** Structural view of a discovery failure classification. */
export type GoogleAdsFailureLike = {
  errorClass: string;
  message: string;
  retryable: boolean;
};

export type GoogleAdsDiscoveredCustomerLike = {
  customerId: string;
  formattedId: string;
  displayName: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  manager: boolean;
  isTestAccount: boolean;
  level: number | null;
};

export type GoogleAdsDiscoveryResponse = {
  grants: Array<{
    grantAccountId: string;
    customers: GoogleAdsDiscoveredCustomerLike[];
    failure: GoogleAdsFailureLike | null;
  }>;
  partial: boolean;
  skippedGrants: number;
  skippedCustomers: number;
};

/** getGoogleAdsConnectionStatus envelope (database-only projection). */
export type GoogleAdsConnectionStatus = {
  connected: boolean;
  currentUserHasGrant: boolean;
  googleOAuthConfigured: boolean;
  customerId: string | null;
  customerDisplayName: string | null;
  loginCustomerId: string | null;
  currencyCode: string | null;
  timeZone: string | null;
  isTestAccount: boolean;
  grantAccountId: string | null;
  connectedAt: string | null;
  connectedByEmail: string | null;
};

export type GoogleAdsSyncStatusResult =
  | { connected: true; syncState: GoogleAdsSyncState }
  | { connected: false; syncState: null };

/** Structural view of a compare delta row: one per base metric. */
export type GoogleAdsMetricDeltaLike = {
  metric: GoogleAdsKpiMetric;
  current: number | null;
  previous: number | null;
  absoluteChange: number | null;
  pctChange: number | null;
};

export type GoogleAdsOverviewResult =
  | { connected: true; overview: GoogleAdsAnalyticsOverview }
  | { connected: false; overview: null };

export type GoogleAdsBreakdownResult<T> =
  | { connected: true; breakdown: T }
  | { connected: false; breakdown: null };
