import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type {
  AnalyticsGeoResult,
  AnalyticsLandingResult,
  AnalyticsTechnologyResult,
} from "@/server/features/ga4/services/AnalyticsService";
import {
  GeographySection,
  TechnologySection,
} from "./AnalyticsGeoTechSections";
import { LandingPagesTable } from "./AnalyticsLandingSections";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    to,
    ...props
  }: {
    children?: React.ReactNode;
    to: string;
    [key: string]: unknown;
  }) => createElement("a", { href: to, ...props }, children),
}));

describe("AnalyticsGeoTechSections", () => {
  const GEO_RESULT: AnalyticsGeoResult = {
    connected: true,
    propertyId: "prop-1",
    from: "2026-09-01",
    to: "2026-09-28",
    coverage: {
      status: "complete",
      coveredDates: 28,
      totalDates: 28,
      coveredThrough: "2026-09-28",
    },
    rows: [
      {
        country: "United States",
        sessions: 1000,
        engagedSessions: 600,
        userEngagementDuration: 45000,
        screenPageViews: 2500,
        eventCount: 4000,
        newUsers: 800,
        isOtherRow: false,
      },
      {
        country: "(other)",
        sessions: 150,
        engagedSessions: 75,
        userEngagementDuration: 3000,
        screenPageViews: 300,
        eventCount: 500,
        newUsers: 100,
        isOtherRow: true,
      },
    ],
    emptyNote: null,
  };

  const PREV_GEO_RESULT: AnalyticsGeoResult = {
    connected: true,
    propertyId: "prop-1",
    from: "2026-08-04",
    to: "2026-08-31",
    coverage: {
      status: "complete",
      coveredDates: 28,
      totalDates: 28,
      coveredThrough: "2026-08-31",
    },
    rows: [
      {
        country: "United States",
        sessions: 800,
        engagedSessions: 480,
        userEngagementDuration: 36000,
        screenPageViews: 2000,
        eventCount: 3200,
        newUsers: 640,
        isOtherRow: false,
      },
    ],
    emptyNote: null,
  };

  it("renders geography rows with metrics and marks aggregated other row", () => {
    const html = renderToStaticMarkup(
      createElement(GeographySection, {
        result: GEO_RESULT,
        pending: false,
        queryError: null,
      }),
    );

    expect(html).toContain("United States");
    expect(html).toContain("1,000"); // sessions
    expect(html).toContain("60.0%"); // engagement rate (600 / 1000)
    expect(html).toContain("45.0s"); // avg engagement time
    expect(html).toContain("2,500"); // screenPageViews
    expect(html).toContain("Aggregated"); // (other) badge
    expect(html).toContain("(other)");
  });

  it("renders geography delta when previous period is provided", () => {
    const html = renderToStaticMarkup(
      createElement(GeographySection, {
        result: GEO_RESULT,
        prevResult: PREV_GEO_RESULT,
        pending: false,
        queryError: null,
      }),
    );

    expect(html).toContain("+200"); // 1000 - 800
    expect(html).toContain("+25.0%");
  });

  it("renders explicit empty note when geo has zero rows", () => {
    const emptyResult: AnalyticsGeoResult = {
      connected: true,
      propertyId: "prop-1",
      from: "2026-09-01",
      to: "2026-09-28",
      coverage: GEO_RESULT.coverage,
      rows: [],
      emptyNote: "No countries recorded sessions in this covered period.",
    };
    const html = renderToStaticMarkup(
      createElement(GeographySection, {
        result: emptyResult,
        pending: false,
        queryError: null,
      }),
    );

    expect(html).toContain("No countries recorded sessions");
  });

  const TECH_RESULT: AnalyticsTechnologyResult = {
    connected: true,
    propertyId: "prop-1",
    dimension: "device",
    from: "2026-09-01",
    to: "2026-09-28",
    coverage: {
      status: "complete",
      coveredDates: 28,
      totalDates: 28,
      coveredThrough: "2026-09-28",
    },
    rows: [
      {
        dimension: "device",
        value: "desktop",
        sessions: 700,
        engagedSessions: 490,
        userEngagementDuration: 35000,
        screenPageViews: 1800,
        eventCount: 2800,
        newUsers: 500,
        isOtherRow: false,
      },
      {
        dimension: "device",
        value: "mobile",
        sessions: 300,
        engagedSessions: 150,
        userEngagementDuration: 9000,
        screenPageViews: 600,
        eventCount: 900,
        newUsers: 250,
        isOtherRow: false,
      },
    ],
    emptyNote: null,
  };

  it("renders technology breakdown with dimension tabs and metrics", () => {
    const html = renderToStaticMarkup(
      createElement(TechnologySection, {
        dimension: "device",
        onDimensionChange: () => {},
        result: TECH_RESULT,
        pending: false,
        queryError: null,
      }),
    );

    expect(html).toContain("Device");
    expect(html).toContain("Browser");
    expect(html).toContain("Operating system");
    expect(html).toContain("desktop");
    expect(html).toContain("mobile");
    expect(html).toContain("70.0%"); // desktop engagement rate (490 / 700)
    expect(html).toContain("50.0%"); // mobile engagement rate (150 / 300)
  });
});

describe("LandingPagesTable GSC Join & Engagement", () => {
  const LANDING_RESULT: Extract<AnalyticsLandingResult, { connected: true }> = {
    connected: true,
    propertyId: "prop-1",
    filters: {
      range: "last_28_days",
    },
    windows: {
      current: { from: "2026-09-01", to: "2026-09-28" },
      previous: { from: "2026-08-04", to: "2026-08-31" },
    },
    coverage: {
      status: "complete",
      coveredDates: 28,
      totalDates: 28,
      coveredThrough: "2026-09-28",
    },
    rows: [
      {
        landingPage: "/pricing",
        sessions: { current: 500, previous: 400, change: 100, pctChange: 0.25 },
        engagedSessions: {
          current: 350,
          previous: 260,
          change: 90,
          pctChange: 0.346,
        },
        engagementRate: {
          current: 0.7,
          previous: 0.65,
          change: 0.05,
          pctChange: 0.077,
        },
        avgEngagementTimePerSession: {
          current: 45,
          previous: 40,
          change: 5,
          pctChange: 0.125,
        },
        screenPageViews: {
          current: 1200,
          previous: 1000,
          change: 200,
          pctChange: 0.2,
        },
      },
      {
        landingPage: "https://example.com/blog/guide",
        sessions: {
          current: 300,
          previous: 350,
          change: -50,
          pctChange: -0.143,
        },
        engagedSessions: {
          current: 150,
          previous: 175,
          change: -25,
          pctChange: -0.143,
        },
        engagementRate: {
          current: 0.5,
          previous: 0.5,
          change: 0,
          pctChange: 0,
        },
        avgEngagementTimePerSession: {
          current: 30,
          previous: 30,
          change: 0,
          pctChange: 0,
        },
        screenPageViews: {
          current: 600,
          previous: 700,
          change: -100,
          pctChange: -0.143,
        },
      },
    ],
    reservedFilterNote: null,
  };

  const GSC_PAGES = [
    { key: "https://example.com/pricing/", clicks: 420, impressions: 8500 },
    { key: "https://example.com/other-page", clicks: 100, impressions: 2000 },
  ];

  it("correlates GA4 landing pages with GSC search data via canonical URL", () => {
    const html = renderToStaticMarkup(
      createElement(LandingPagesTable, {
        projectId: "proj-1",
        rows: LANDING_RESULT.rows,
        gscPages: GSC_PAGES,
      }),
    );

    // /pricing matches https://example.com/pricing/ via canonicalUrl (slash folded)
    expect(html).toContain("/pricing");
    expect(html).toContain("500"); // sessions
    expect(html).toContain("70.0%"); // engagement rate
    expect(html).toContain("420"); // matched GSC clicks
    expect(html).toContain("8,500"); // matched GSC impressions

    // /blog/guide has no GSC match -> renders em dash, NEVER zero
    expect(html).toContain("/blog/guide");
    expect(html).toContain("—");
    expect(html).toContain("canonical SEO URL identity");
  });
});
