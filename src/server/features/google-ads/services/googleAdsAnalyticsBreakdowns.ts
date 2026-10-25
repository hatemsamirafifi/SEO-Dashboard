// Stored Google Ads breakdown reads: one published grain each. Reads ONLY
// already-published data via GoogleAdsAnalyticsRepository — no transport, no
// provider calls, no plaintext payloads. Re-exported from
// GoogleAdsAnalyticsService to keep the public surface stable.
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import type {
  GoogleAdsGrain,
  GoogleAdsUnitScope,
} from "../repositories/googleAdsAnalyticsModel";
import {
  assertGoogleAdsWindow,
  googleAdsCoverageFromUnits,
  kpisFromSums,
  type GoogleAdsCoverage,
  type GoogleAdsKpiTotals,
  type GoogleAdsWindow,
} from "./googleAdsAnalyticsMath";

export type GoogleAdsAnalyticsBreakdownMeta = {
  window: GoogleAdsWindow;
  coverage: GoogleAdsCoverage;
  /** Account currency observed with the published data; null = unknown. */
  currencyCode: string | null;
  /** The metricDateBasis recorded by every covering unit of this grain;
   *  null when units are absent or the basis disagrees between them (a
   *  mixed-basis window must not be presented with a single basis). */
  metricDateBasis: string | null;
};

const COVERING_STATUSES = new Set(["success_with_data", "success_zero_rows"]);

export type GoogleAdsAnalyticsBreakdownInput = {
  scope: GoogleAdsUnitScope;
  window: GoogleAdsWindow;
};

export type GoogleAdsCampaignRow = {
  campaignResourceId: string;
  campaignName: string | null;
  campaignStatus: string | null;
  campaignServingStatus: string | null;
  advertisingChannelType: string | null;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsAdGroupRow = {
  adGroupResourceId: string;
  campaignResourceId: string;
  adGroupName: string | null;
  adGroupStatus: string | null;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsKeywordRow = {
  keywordResourceId: string;
  campaignResourceId: string;
  adGroupResourceId: string;
  keywordText: string | null;
  keywordMatchType: string | null;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsSearchTermRow = {
  campaignResourceId: string;
  adGroupResourceId: string;
  searchText: string;
  keywordText: string | null;
  keywordMatchType: string | null;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsDeviceRow = {
  device: string;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsLandingPageRow = {
  landingPageUrl: string;
  rowCount: number;
  totals: GoogleAdsKpiTotals;
};

export type GoogleAdsCampaignBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  campaigns: GoogleAdsCampaignRow[];
};

export type GoogleAdsAdGroupBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  adGroups: GoogleAdsAdGroupRow[];
};

export type GoogleAdsKeywordBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  keywords: GoogleAdsKeywordRow[];
};

export type GoogleAdsSearchTermBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  searchTerms: GoogleAdsSearchTermRow[];
  /** Google applies privacy thresholds to search-term reporting above the
   *  aggregate level: terms can be withheld at the source with no local
   *  marker, so this flag is ALWAYS true for this breakdown and consumers
   *  must treat its totals as a floor, never a census. */
  isPrivacyThresholdFiltered: true;
};

export type GoogleAdsDeviceBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  devices: GoogleAdsDeviceRow[];
};

export type GoogleAdsLandingPageBreakdown = GoogleAdsAnalyticsBreakdownMeta & {
  landingPages: GoogleAdsLandingPageRow[];
  campaignLandingPages: Array<{
    campaignResourceId: string;
    rowCount: number;
    totals: GoogleAdsKpiTotals;
  }>;
};

export type GoogleAdsBreakdownFilterOptions = {
  /** Exact search-term text filter (totals for exactly one term). */
  searchText?: string;
  /** Case-insensitive LIKE %…% filter for search-term text. */
  searchTextLike?: string;
  /** Restrict device / landing-page grains to one campaign. */
  campaignResourceId?: string;
};

function coveringBasisOf(
  units: readonly {
    status: string;
    publishedGenerationId: string | null;
    metricDateBasis: string | null;
  }[],
): string | null {
  const bases = new Set<string | null>();
  for (const unit of units) {
    if (
      COVERING_STATUSES.has(unit.status) &&
      unit.publishedGenerationId !== null
    ) {
      bases.add(unit.metricDateBasis);
    }
  }
  return bases.size === 1 ? ([...bases][0] ?? null) : null;
}

async function breakdownContext(
  scope: GoogleAdsUnitScope,
  grain: GoogleAdsGrain,
  window: GoogleAdsWindow,
): Promise<GoogleAdsAnalyticsBreakdownMeta> {
  const units = await GoogleAdsAnalyticsRepository.listUnits(scope, {
    grains: [grain],
    startDate: window.startDate,
    endDate: window.endDate,
  });
  const unitsInWindow = units.filter(
    (unit) => unit.date >= window.startDate && unit.date <= window.endDate,
  );
  const snapshot = await GoogleAdsAnalyticsRepository.getAccountSnapshot(scope);
  return {
    window,
    coverage: googleAdsCoverageFromUnits(unitsInWindow, window),
    currencyCode: snapshot?.currencyCode ?? null,
    metricDateBasis: coveringBasisOf(unitsInWindow),
  };
}

export async function getCampaigns(
  input: GoogleAdsAnalyticsBreakdownInput,
): Promise<GoogleAdsCampaignBreakdown> {
  assertGoogleAdsWindow(input.window);
  const meta = await breakdownContext(input.scope, "campaign", input.window);
  const rows = await GoogleAdsAnalyticsRepository.sumCampaignWindow(
    input.scope,
    input.window,
  );
  return {
    ...meta,
    campaigns: rows.map((row) => ({
      campaignResourceId: row.campaignResourceId,
      campaignName: row.campaignName,
      campaignStatus: row.campaignStatus,
      campaignServingStatus: row.campaignServingStatus,
      advertisingChannelType: row.advertisingChannelType,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}

export async function getAdGroups(
  input: GoogleAdsAnalyticsBreakdownInput,
): Promise<GoogleAdsAdGroupBreakdown> {
  assertGoogleAdsWindow(input.window);
  const meta = await breakdownContext(input.scope, "ad_group", input.window);
  const rows = await GoogleAdsAnalyticsRepository.sumAdGroupWindow(
    input.scope,
    input.window,
  );
  return {
    ...meta,
    adGroups: rows.map((row) => ({
      adGroupResourceId: row.adGroupResourceId,
      campaignResourceId: row.campaignResourceId,
      adGroupName: row.adGroupName,
      adGroupStatus: row.adGroupStatus,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}

export async function getKeywords(
  input: GoogleAdsAnalyticsBreakdownInput,
): Promise<GoogleAdsKeywordBreakdown> {
  assertGoogleAdsWindow(input.window);
  const meta = await breakdownContext(input.scope, "keyword", input.window);
  const rows = await GoogleAdsAnalyticsRepository.sumKeywordWindow(
    input.scope,
    input.window,
  );
  return {
    ...meta,
    keywords: rows.map((row) => ({
      keywordResourceId: row.keywordResourceId,
      campaignResourceId: row.campaignResourceId,
      adGroupResourceId: row.adGroupResourceId,
      keywordText: row.keywordText,
      keywordMatchType: row.keywordMatchType,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}

export async function getSearchTerms(
  input: GoogleAdsAnalyticsBreakdownInput,
  options: GoogleAdsBreakdownFilterOptions = {},
): Promise<GoogleAdsSearchTermBreakdown> {
  assertGoogleAdsWindow(input.window);
  if (
    options.searchText !== undefined &&
    options.searchTextLike !== undefined
  ) {
    throw new Error(
      "Expected at most one of searchText or searchTextLike for the search-term breakdown",
    );
  }
  const meta = await breakdownContext(input.scope, "search_term", input.window);
  const rows = await GoogleAdsAnalyticsRepository.sumSearchTermWindow(
    input.scope,
    input.window,
    options,
  );
  return {
    ...meta,
    isPrivacyThresholdFiltered: true,
    searchTerms: rows.map((row) => ({
      campaignResourceId: row.campaignResourceId,
      adGroupResourceId: row.adGroupResourceId,
      searchText: row.searchText,
      keywordText: row.keywordText,
      keywordMatchType: row.keywordMatchType,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}

export async function getDevices(
  input: GoogleAdsAnalyticsBreakdownInput,
  options: GoogleAdsBreakdownFilterOptions = {},
): Promise<GoogleAdsDeviceBreakdown> {
  assertGoogleAdsWindow(input.window);
  const meta = await breakdownContext(input.scope, "device", input.window);
  const rows = await GoogleAdsAnalyticsRepository.sumDeviceWindow(
    input.scope,
    input.window,
    options,
  );
  return {
    ...meta,
    devices: rows.map((row) => ({
      device: row.device,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}

export async function getLandingPages(
  input: GoogleAdsAnalyticsBreakdownInput,
  options: GoogleAdsBreakdownFilterOptions = {},
): Promise<GoogleAdsLandingPageBreakdown> {
  assertGoogleAdsWindow(input.window);
  const meta = await breakdownContext(
    input.scope,
    "landing_page",
    input.window,
  );
  const [byUrl, byCampaign] = await Promise.all([
    GoogleAdsAnalyticsRepository.sumLandingPageByUrlWindow(
      input.scope,
      input.window,
      options,
    ),
    GoogleAdsAnalyticsRepository.sumLandingPageByResourceWindow(
      input.scope,
      input.window,
      options,
    ),
  ]);
  return {
    ...meta,
    landingPages: byUrl.map((row) => ({
      landingPageUrl: row.landingPageUrl,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
    campaignLandingPages: byCampaign.map((row) => ({
      campaignResourceId: row.campaignResourceId,
      rowCount: row.sums.rowCount,
      totals: kpisFromSums(row.sums),
    })),
  };
}
