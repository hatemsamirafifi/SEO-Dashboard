/**
 * GA4 Analytics E2E test fixtures.
 *
 * Deterministic responses for GA4 analytics browser E2E tests, mirroring
 * the structure of Domain and Keyword research E2E fixtures.
 */

import {
  DEFAULT_COVERAGE,
  DEFAULT_WINDOWS,
  FIXTURE_PROPERTY_ID,
} from "./ga4-analytics-fixtures.shared";

export function getFixtureGa4Connection() {
  return {
    connected: true,
    currentUserHasGrant: true,
    googleOAuthConfigured: true,
    propertyId: FIXTURE_PROPERTY_ID,
    propertyDisplayName: "OpenSEO Production Store",
    connectedAt: "2026-09-01 00:00:00",
  };
}

export function getFixtureGa4SyncStatus() {
  return {
    connected: true as const,
    latestSync: {
      id: "sync-1",
      propertyId: FIXTURE_PROPERTY_ID,
      syncType: "manual" as const,
      status: "completed" as const,
      startedAt: "2026-10-15T00:00:00Z",
      completedAt: "2026-10-15T00:05:00Z",
      error: null,
      recordsProcessed: 120,
    },
    activeSync: null,
    isRunning: false,
    lastFullyCoveredDate: "2026-10-15",
  };
}

export function getFixtureGa4Overview() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    totals: {
      sessions: {
        current: 14200,
        previous: 12500,
        change: 1700,
        pctChange: 13.6,
      },
      engagedSessions: {
        current: 9800,
        previous: 8400,
        change: 1400,
        pctChange: 16.7,
      },
      userEngagementDuration: {
        current: 147000,
        previous: 117600,
        change: 29400,
        pctChange: 25.0,
      },
      screenPageViews: {
        current: 35400,
        previous: 31000,
        change: 4400,
        pctChange: 14.2,
      },
      eventCount: {
        current: 52000,
        previous: 46000,
        change: 6000,
        pctChange: 13.0,
      },
      newUsers: { current: 8100, previous: 7200, change: 900, pctChange: 12.5 },
      totalRevenue: {
        current: 24500,
        previous: 21000,
        change: 3500,
        pctChange: 16.7,
      },
      purchaseRevenue: {
        current: 24500,
        previous: 21000,
        change: 3500,
        pctChange: 16.7,
      },
      transactions: {
        current: 320,
        previous: 280,
        change: 40,
        pctChange: 14.3,
      },
      addToCarts: {
        current: 1100,
        previous: 950,
        change: 150,
        pctChange: 15.8,
      },
      checkouts: { current: 480, previous: 420, change: 60, pctChange: 14.3 },
      engagementRate: {
        current: 0.69,
        previous: 0.67,
        change: 0.02,
        pctChange: 3.0,
      },
      avgEngagementTimePerSession: {
        current: 15.0,
        previous: 14.0,
        change: 1.0,
        pctChange: 7.1,
      },
    },
    trends: [
      {
        date: "2026-10-15",
        sessions: 520,
        engagementRate: 0.71,
        avgEngagementTimePerSession: 15.2,
        screenPageViews: 1300,
        eventCount: 1900,
        newUsers: 310,
      },
    ],
    currencyCode: "USD",
    currencyNote: "Currency is USD.",
    newUsersFootnote: "New users only.",
    reservedFilterNote: null,
  };
}

export function getFixtureGa4Acquisition() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    rows: [
      {
        channelGroup: "Organic Search",
        source: "google",
        medium: "organic",
        isOrganic: true,
        sessions: {
          current: 8200,
          previous: 7100,
          change: 1100,
          pctChange: 15.5,
        },
        engagedSessions: {
          current: 6100,
          previous: 5100,
          change: 1000,
          pctChange: 19.6,
        },
        screenPageViews: {
          current: 21000,
          previous: 18200,
          change: 2800,
          pctChange: 15.4,
        },
        eventCount: {
          current: 25000,
          previous: 22000,
          change: 3000,
          pctChange: 13.6,
        },
        engagementRate: {
          current: 0.74,
          previous: 0.71,
          change: 0.03,
          pctChange: 4.2,
        },
        avgEngagementTimePerSession: {
          current: 16.2,
          previous: 14.8,
          change: 1.4,
          pctChange: 9.5,
        },
      },
      {
        channelGroup: "Direct",
        source: "(direct)",
        medium: "(none)",
        isOrganic: false,
        sessions: {
          current: 3400,
          previous: 3100,
          change: 300,
          pctChange: 9.7,
        },
        engagedSessions: {
          current: 2200,
          previous: 1900,
          change: 300,
          pctChange: 15.8,
        },
        screenPageViews: {
          current: 7800,
          previous: 7100,
          change: 700,
          pctChange: 9.9,
        },
        eventCount: {
          current: 12000,
          previous: 11000,
          change: 1000,
          pctChange: 9.1,
        },
        engagementRate: {
          current: 0.65,
          previous: 0.61,
          change: 0.04,
          pctChange: 6.6,
        },
        avgEngagementTimePerSession: {
          current: 14.0,
          previous: 13.2,
          change: 0.8,
          pctChange: 6.1,
        },
      },
    ],
    newUsersFootnote: "New users only.",
    reservedFilterNote: null,
  };
}

export function getFixtureGa4LandingPages() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    rows: [
      {
        landingPage: "/products/widgets",
        sessions: {
          current: 4200,
          previous: 3600,
          change: 600,
          pctChange: 16.7,
        },
        engagedSessions: {
          current: 3100,
          previous: 2600,
          change: 500,
          pctChange: 19.2,
        },
        screenPageViews: {
          current: 9500,
          previous: 8100,
          change: 1400,
          pctChange: 17.3,
        },
        engagementRate: {
          current: 0.74,
          previous: 0.72,
          change: 0.02,
          pctChange: 2.8,
        },
        avgEngagementTimePerSession: {
          current: 16.5,
          previous: 15.2,
          change: 1.3,
          pctChange: 8.6,
        },
      },
      {
        landingPage: "/blog/seo-guide",
        sessions: {
          current: 3100,
          previous: 2500,
          change: 600,
          pctChange: 24.0,
        },
        engagedSessions: {
          current: 2400,
          previous: 1900,
          change: 500,
          pctChange: 26.3,
        },
        screenPageViews: {
          current: 6200,
          previous: 5000,
          change: 1200,
          pctChange: 24.0,
        },
        engagementRate: {
          current: 0.77,
          previous: 0.76,
          change: 0.01,
          pctChange: 1.3,
        },
        avgEngagementTimePerSession: {
          current: 17.0,
          previous: 16.0,
          change: 1.0,
          pctChange: 6.3,
        },
      },
    ],
    reservedFilterNote: null,
  };
}

export {
  getFixtureGa4Geo,
  getFixtureGa4Technology,
} from "./ga4-analytics-fixtures.technology";

export {
  getFixtureGa4Audience,
  getFixtureGa4Conversions,
  getFixtureGa4Ecommerce,
  getFixtureGa4Events,
} from "./ga4-analytics-fixtures.audience";
