/* eslint-disable max-lines */
/**
 * Google Ads stored-analytics E2E test fixtures.
 *
 * Deterministic server-function envelopes for browser E2E tests, mirroring
 * the shapes returned by GoogleAdsService / GoogleAdsAnalyticsService.
 * All values are stored-data style: derived ratios are computed from the
 * base totals, never invented at render time.
 */

import type {
  GoogleAdsAnalyticsDailyPoint,
  GoogleAdsAnalyticsOverview,
  GoogleAdsSyncState,
  GoogleAdsUnitLedgerCounts,
} from "@/server/features/google-ads/services/GoogleAdsAnalyticsService";
import type {
  GoogleAdsAdGroupBreakdown,
  GoogleAdsCampaignBreakdown,
  GoogleAdsDeviceBreakdown,
  GoogleAdsKeywordBreakdown,
  GoogleAdsLandingPageBreakdown,
  GoogleAdsSearchTermBreakdown,
  GoogleAdsAdGroupRow,
  GoogleAdsCampaignRow,
  GoogleAdsDeviceRow,
  GoogleAdsKeywordRow,
  GoogleAdsLandingPageRow,
  GoogleAdsSearchTermRow,
} from "@/server/features/google-ads/services/googleAdsAnalyticsBreakdowns";
import type {
  GoogleAdsKpiMetric,
  GoogleAdsKpiTotals,
} from "@/server/features/google-ads/services/googleAdsAnalyticsMath";

const FIXTURE_CUSTOMER_ID = "1234567890";
const FIXTURE_GRANT_ACCOUNT_ID = "fixture-google-sub-1";

const CURRENT_WINDOW = { startDate: "2026-09-18", endDate: "2026-10-15" };
const PREVIOUS_WINDOW = { startDate: "2026-08-21", endDate: "2026-09-17" };

/** Derives the ratio KPIs exactly like the server-side kpisFromSums: a ratio
 *  only exists when both components are present and the denominator > 0. */
function kpiTotals(input: {
  impressions: number | null;
  clicks: number | null;
  cost: number | null;
  conversions: number | null;
  conversionsValue: number | null;
}): GoogleAdsKpiTotals {
  const ctr =
    input.impressions !== null && input.clicks !== null && input.impressions > 0
      ? input.clicks / input.impressions
      : null;
  const cpc =
    input.cost !== null && input.clicks !== null && input.clicks > 0
      ? input.cost / input.clicks
      : null;
  const cpa =
    input.cost !== null && input.conversions !== null && input.conversions > 0
      ? input.cost / input.conversions
      : null;
  const roas =
    input.cost !== null && input.conversionsValue !== null && input.cost > 0
      ? input.conversionsValue / input.cost
      : null;
  return { ...input, ctr, cpc, cpa, roas };
}

function delta(
  metric: GoogleAdsKpiMetric,
  current: number | null,
  previous: number | null,
) {
  const absoluteChange =
    current === null || previous === null ? null : current - previous;
  const pctChange =
    absoluteChange === null || previous === null || previous === 0
      ? null
      : (absoluteChange / previous) * 100;
  return { metric, current, previous, absoluteChange, pctChange };
}

const ACCOUNT_PREVIOUS: GoogleAdsKpiTotals = kpiTotals({
  impressions: 171_900,
  clicks: 11_800,
  cost: 5_810.6,
  conversions: 430,
  conversionsValue: 21_612.5,
});

function dailyPoint(i: number): GoogleAdsAnalyticsDailyPoint {
  const date = new Date(
    Date.parse(`${CURRENT_WINDOW.startDate}T00:00:00.000Z`) + i * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  const impressions = 5_400 + ((i * 37) % 19) * 80;
  const clicks = Math.round(impressions * 0.066) + (i % 3);
  const cost = 120 + ((i * 11) % 23) * 3.5;
  const conversions = 12 + (i % 5);
  return {
    date,
    totals: kpiTotals({
      impressions,
      clicks,
      cost,
      conversions,
      conversionsValue: Math.round(cost * 3.4 * 100) / 100,
    }),
  };
}

const DAILY: GoogleAdsAnalyticsDailyPoint[] = Array.from(
  { length: 28 },
  (_, i) => dailyPoint(i),
);

export function getFixtureGoogleAdsConnectionStatus() {
  return {
    connected: true,
    currentUserHasGrant: true,
    googleOAuthConfigured: true,
    customerId: FIXTURE_CUSTOMER_ID,
    customerDisplayName: "OpenSEO Paid Search",
    loginCustomerId: null,
    currencyCode: "USD",
    timeZone: "America/New_York",
    isTestAccount: false,
    grantAccountId: FIXTURE_GRANT_ACCOUNT_ID,
    connectedAt: "2026-09-01 00:00:00",
    connectedByEmail: "fixture-user@example.com",
  };
}

const FIXTURE_UNITS: GoogleAdsUnitLedgerCounts = {
  total: 33,
  pending: 0,
  successWithData: 28,
  successZeroRows: 2,
  partial: 2,
  failed: 1,
};

export function getFixtureGoogleAdsSyncStatus(): {
  connected: true;
  syncState: GoogleAdsSyncState;
} {
  const runs = [
    {
      id: "sync-run-1",
      projectId: "fixture-project",
      customerId: FIXTURE_CUSTOMER_ID,
      runKey: "fixture-run-key-1",
      mode: "manual",
      windowStartDate: CURRENT_WINDOW.startDate,
      windowEndDate: CURRENT_WINDOW.endDate,
      scheduledSlot: null,
      attempt: 1,
      status: "completed",
      startedAt: "2026-10-15T00:00:00Z",
      completedAt: "2026-10-15T00:05:00Z",
      unitsTotal: 33,
      unitsSucceeded: 30,
      unitsFailed: 1,
      errorClass: null,
      errorMessage: null,
      createdAt: "2026-10-15T00:00:00Z",
      updatedAt: "2026-10-15T00:05:00Z",
    },
  ];
  return {
    connected: true,
    syncState: { runs, activeRun: null, units: FIXTURE_UNITS },
  };
}

export function getFixtureGoogleAdsOverview(): {
  connected: true;
  overview: GoogleAdsAnalyticsOverview;
} {
  const totals = kpiTotals({
    impressions: 184_200,
    clicks: 12_340,
    cost: 6_120.45,
    conversions: 486,
    conversionsValue: 24_315.7,
  });
  return {
    connected: true,
    overview: {
      window: CURRENT_WINDOW,
      coverage: {
        status: "covered",
        coveredDates: 28,
        totalDates: 28,
        firstCoveredDate: CURRENT_WINDOW.startDate,
        lastCoveredDate: CURRENT_WINDOW.endDate,
      },
      totals,
      rowCount: 28,
      daily: DAILY,
      compare: {
        window: PREVIOUS_WINDOW,
        gate: "ready",
        deltas: [
          delta(
            "impressions",
            totals.impressions,
            ACCOUNT_PREVIOUS.impressions,
          ),
          delta("clicks", totals.clicks, ACCOUNT_PREVIOUS.clicks),
          delta("cost", totals.cost, ACCOUNT_PREVIOUS.cost),
          delta(
            "conversions",
            totals.conversions,
            ACCOUNT_PREVIOUS.conversions,
          ),
          delta(
            "conversionsValue",
            totals.conversionsValue,
            ACCOUNT_PREVIOUS.conversionsValue,
          ),
        ],
      },
    },
  };
}

const fixtureBreakdownMeta = () => ({
  window: CURRENT_WINDOW,
  coverage: {
    status: "covered" as const,
    coveredDates: 28,
    totalDates: 28,
    firstCoveredDate: CURRENT_WINDOW.startDate,
    lastCoveredDate: CURRENT_WINDOW.endDate,
  },
  currencyCode: "USD" as string | null,
  metricDateBasis: "google_ads" as string | null,
});

export function getFixtureGoogleAdsCampaigns(): {
  connected: true;
  breakdown: GoogleAdsCampaignBreakdown;
} {
  const campaigns: GoogleAdsCampaignRow[] = [
    {
      campaignResourceId: "campaigns/111",
      campaignName: "Brand Search — US",
      campaignStatus: "ENABLED",
      campaignServingStatus: "SERVING",
      advertisingChannelType: "SEARCH",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 96_200,
        clicks: 7_260,
        cost: 4_020.3,
        conversions: 332,
        conversionsValue: 17_800.4,
      }),
    },
    {
      campaignResourceId: "campaigns/222",
      campaignName: "Shopping Feed",
      campaignStatus: "ENABLED",
      campaignServingStatus: "SERVING",
      advertisingChannelType: "SHOPPING",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 64_500,
        clicks: 3_900,
        cost: 1_450.15,
        conversions: 104,
        conversionsValue: 4_820.3,
      }),
    },
    {
      campaignResourceId: "campaigns/333",
      campaignName: "Performance Max — All",
      campaignStatus: "PAUSED",
      campaignServingStatus: "NOT_SERVING",
      advertisingChannelType: "PERFORMANCE_MAX",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 23_500,
        clicks: 1_180,
        cost: 650.0,
        conversions: 50,
        conversionsValue: 1_695.0,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: { ...fixtureBreakdownMeta(), campaigns },
  };
}

export function getFixtureGoogleAdsAdGroups(): {
  connected: true;
  breakdown: GoogleAdsAdGroupBreakdown;
} {
  const adGroups: GoogleAdsAdGroupRow[] = [
    {
      adGroupResourceId: "adGroups/11",
      campaignResourceId: "campaigns/111",
      adGroupName: "Core Terms",
      adGroupStatus: "ENABLED",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 51_800,
        clicks: 4_020,
        cost: 2_150.4,
        conversions: 188,
        conversionsValue: 9_840.2,
      }),
    },
    {
      adGroupResourceId: "adGroups/12",
      campaignResourceId: "campaigns/111",
      adGroupName: "Brand",
      adGroupStatus: "ENABLED",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 32_600,
        clicks: 2_180,
        cost: 780.25,
        conversions: 96,
        conversionsValue: 6_200.0,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: { ...fixtureBreakdownMeta(), adGroups },
  };
}

export function getFixtureGoogleAdsKeywords(): {
  connected: true;
  breakdown: GoogleAdsKeywordBreakdown;
} {
  const keywords: GoogleAdsKeywordRow[] = [
    {
      keywordResourceId: "keywords/1",
      campaignResourceId: "campaigns/111",
      adGroupResourceId: "adGroups/11",
      keywordText: "buy running shoes online",
      keywordMatchType: "PHRASE",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 18_400,
        clicks: 1_420,
        cost: 812.6,
        conversions: 58,
        conversionsValue: 3_120.5,
      }),
    },
    {
      keywordResourceId: "keywords/2",
      campaignResourceId: "campaigns/111",
      adGroupResourceId: "adGroups/11",
      keywordText: "best trail running shoes",
      keywordMatchType: "EXACT",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 9_800,
        clicks: 860,
        cost: 540.2,
        conversions: 34,
        conversionsValue: 2_140.0,
      }),
    },
    {
      keywordResourceId: "keywords/3",
      campaignResourceId: "campaigns/111",
      adGroupResourceId: "adGroups/11",
      keywordText: "discount running sneakers",
      keywordMatchType: "BROAD",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 4_200,
        clicks: 310,
        cost: 208.75,
        conversions: 8,
        conversionsValue: 402.1,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: { ...fixtureBreakdownMeta(), keywords },
  };
}

export function getFixtureGoogleAdsSearchTerms(): {
  connected: true;
  breakdown: GoogleAdsSearchTermBreakdown;
} {
  const searchTerms: GoogleAdsSearchTermRow[] = [
    {
      campaignResourceId: "campaigns/111",
      adGroupResourceId: "adGroups/11",
      searchText: "running shoes for flat feet",
      keywordText: "buy running shoes online",
      keywordMatchType: "PHRASE",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 2_480,
        clicks: 212,
        cost: 118.3,
        conversions: 9,
        conversionsValue: 512.0,
      }),
    },
    {
      campaignResourceId: "campaigns/111",
      adGroupResourceId: "adGroups/11",
      searchText: "cheap running shoes online",
      keywordText: null,
      keywordMatchType: null,
      rowCount: 28,
      totals: kpiTotals({
        impressions: 1_620,
        clicks: 119,
        cost: 84.1,
        conversions: 5,
        conversionsValue: 230.4,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: {
      ...fixtureBreakdownMeta(),
      isPrivacyThresholdFiltered: true,
      searchTerms,
    },
  };
}

export function getFixtureGoogleAdsDevices(): {
  connected: true;
  breakdown: GoogleAdsDeviceBreakdown;
} {
  const devices: GoogleAdsDeviceRow[] = [
    {
      device: "DESKTOP",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 98_400,
        clicks: 6_620,
        cost: 3_210.55,
        conversions: 262,
        conversionsValue: 13_510.3,
      }),
    },
    {
      device: "MOBILE",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 73_600,
        clicks: 4_880,
        cost: 2_380.1,
        conversions: 186,
        conversionsValue: 9_120.8,
      }),
    },
    {
      device: "TABLET",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 12_200,
        clicks: 840,
        cost: 529.8,
        conversions: 38,
        conversionsValue: 1_684.6,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: { ...fixtureBreakdownMeta(), devices },
  };
}

export function getFixtureGoogleAdsLandingPages(): {
  connected: true;
  breakdown: GoogleAdsLandingPageBreakdown;
} {
  const landingPages: GoogleAdsLandingPageRow[] = [
    {
      landingPageUrl: "https://example.com/products/running-shoes",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 42_100,
        clicks: 3_120,
        cost: 1_580.2,
        conversions: 128,
        conversionsValue: 7_020.5,
      }),
    },
    {
      landingPageUrl: "https://example.com/blog/running-shoes-guide",
      rowCount: 28,
      totals: kpiTotals({
        impressions: 11_500,
        clicks: 830,
        cost: 402.3,
        conversions: 42,
        conversionsValue: 1_560.1,
      }),
    },
  ];
  return {
    connected: true,
    breakdown: {
      ...fixtureBreakdownMeta(),
      landingPages,
      campaignLandingPages: [
        {
          campaignResourceId: "campaigns/111",
          rowCount: 28,
          totals: kpiTotals({
            impressions: 38_900,
            clicks: 2_910,
            cost: 1_440.1,
            conversions: 120,
            conversionsValue: 6_880.0,
          }),
        },
        {
          campaignResourceId: "campaigns/222",
          rowCount: 28,
          totals: kpiTotals({
            impressions: 9_300,
            clicks: 610,
            cost: 210.4,
            conversions: 28,
            conversionsValue: 940.5,
          }),
        },
      ],
    },
  };
}

export { FIXTURE_CUSTOMER_ID, FIXTURE_GRANT_ACCOUNT_ID };
