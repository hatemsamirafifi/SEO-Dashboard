import {
  DEFAULT_COVERAGE,
  FIXTURE_PROPERTY_ID,
} from "./ga4-analytics-fixtures.shared";

export function getFixtureGa4Technology(
  dimension: "device" | "browser" | "os" = "device",
) {
  let rows: Array<{
    dimension: "device" | "browser" | "os";
    value: string;
    sessions: number;
    engagedSessions: number;
    userEngagementDuration: number;
    screenPageViews: number;
    eventCount: number;
    newUsers: number;
    isOtherRow: boolean;
  }> = [];

  if (dimension === "browser") {
    rows = [
      {
        dimension: "browser",
        value: "Chrome",
        sessions: 9100,
        engagedSessions: 6500,
        userEngagementDuration: 228000,
        screenPageViews: 22800,
        eventCount: 33000,
        newUsers: 5100,
        isOtherRow: false,
      },
      {
        dimension: "browser",
        value: "Safari",
        sessions: 3800,
        engagedSessions: 2600,
        userEngagementDuration: 95000,
        screenPageViews: 9500,
        eventCount: 14000,
        newUsers: 2100,
        isOtherRow: false,
      },
    ];
  } else if (dimension === "os") {
    rows = [
      {
        dimension: "os",
        value: "Windows",
        sessions: 7200,
        engagedSessions: 5100,
        userEngagementDuration: 180000,
        screenPageViews: 18000,
        eventCount: 26000,
        newUsers: 4000,
        isOtherRow: false,
      },
      {
        dimension: "os",
        value: "Android",
        sessions: 2400,
        engagedSessions: 1600,
        userEngagementDuration: 59000,
        screenPageViews: 5900,
        eventCount: 9000,
        newUsers: 1400,
        isOtherRow: false,
      },
    ];
  } else {
    rows = [
      {
        dimension: "device",
        value: "desktop",
        sessions: 8500,
        engagedSessions: 6100,
        userEngagementDuration: 215000,
        screenPageViews: 21500,
        eventCount: 31000,
        newUsers: 4800,
        isOtherRow: false,
      },
      {
        dimension: "device",
        value: "mobile",
        sessions: 5200,
        engagedSessions: 3400,
        userEngagementDuration: 126000,
        screenPageViews: 12600,
        eventCount: 19000,
        newUsers: 2900,
        isOtherRow: false,
      },
    ];
  }

  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    dimension,
    from: "2026-09-18",
    to: "2026-10-15",
    coverage: DEFAULT_COVERAGE,
    rows,
    emptyNote: null,
  };
}

export function getFixtureGa4Geo() {
  return {
    connected: true as const,
    propertyId: FIXTURE_PROPERTY_ID,
    from: "2026-09-18",
    to: "2026-10-15",
    coverage: DEFAULT_COVERAGE,
    rows: [
      {
        country: "Egypt",
        sessions: 6200,
        engagedSessions: 4400,
        userEngagementDuration: 156000,
        screenPageViews: 15600,
        eventCount: 22000,
        newUsers: 3500,
        isOtherRow: false,
      },
      {
        country: "United States",
        sessions: 4100,
        engagedSessions: 2900,
        userEngagementDuration: 102000,
        screenPageViews: 10200,
        eventCount: 15000,
        newUsers: 2300,
        isOtherRow: false,
      },
    ],
    emptyNote: null,
  };
}
