import {
  DEFAULT_COVERAGE,
  DEFAULT_WINDOWS,
  FIXTURE_PROPERTY_ID,
} from "./ga4-analytics-fixtures.shared";

export function getFixtureGa4Events() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    rows: [
      {
        eventName: "page_view",
        isKeyEvent: false,
        eventCount: {
          current: 35400,
          previous: 31000,
          change: 4400,
          pctChange: 14.2,
        },
      },
      {
        eventName: "session_start",
        isKeyEvent: false,
        eventCount: {
          current: 14200,
          previous: 12500,
          change: 1700,
          pctChange: 13.6,
        },
      },
    ],
    currencyCode: "USD",
    currencyNote: "Currency is USD.",
    reservedFilterNote: null,
  };
}

export function getFixtureGa4Conversions() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    rows: [
      {
        eventName: "purchase",
        isKeyEvent: true,
        eventCount: {
          current: 320,
          previous: 280,
          change: 40,
          pctChange: 14.3,
        },
      },
    ],
    currencyCode: "USD",
    currencyNote: "Currency is USD.",
    goalSelectionDeferredNote: null,
    reservedFilterNote: null,
  };
}

export function getFixtureGa4Ecommerce() {
  return {
    connected: true as const,
    available: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    totals: {
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
    },
    currencyCode: "USD",
    currencyNote: "Currency is USD.",
    reservedFilterNote: null,
  };
}

export function getFixtureGa4Audience() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    filters: { range: "last_28_days" as const },
    windows: DEFAULT_WINDOWS,
    coverage: DEFAULT_COVERAGE,
    totals: {
      newUsers: { current: 8100, previous: 7200, change: 900, pctChange: 12.5 },
    },
    newUsersFootnote: "New users only.",
    geoTechDeferredNote: "Breakdowns served by geo/tech.",
    distinctUsersNote: "Total users distinct.",
    reservedFilterNote: null,
  };
}
