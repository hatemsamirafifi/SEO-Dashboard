/* eslint-disable max-lines */
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConnection: vi.fn(),
  getSummaryTotals: vi.fn(),
  getDailySummarySeries: vi.fn(),
  getAcquisitionGroups: vi.fn(),
  getLandingGroups: vi.fn(),
  getEventGroups: vi.fn(),
  getGeoGroups: vi.fn(),
  getTechnologyGroups: vi.fn(),
  getGrainCoverage: vi.fn(),
}));

vi.mock("@/server/features/ga4/repositories/Ga4ConnectionRepository", () => ({
  Ga4ConnectionRepository: { getByProjectId: mocks.getConnection },
}));

vi.mock("@/server/features/ga4/repositories/Ga4SyncRepository", () => ({
  Ga4SyncRepository: {
    getSummaryTotals: mocks.getSummaryTotals,
    getDailySummarySeries: mocks.getDailySummarySeries,
    getAcquisitionGroups: mocks.getAcquisitionGroups,
    getLandingGroups: mocks.getLandingGroups,
    getEventGroups: mocks.getEventGroups,
    getGeoGroups: mocks.getGeoGroups,
    getTechnologyGroups: mocks.getTechnologyGroups,
    getGrainCoverage: mocks.getGrainCoverage,
  },
  NEW_USERS_FOOTNOTE: "new_users footnote",
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { AnalyticsService, resolveAnalyticsWindows } from "./AnalyticsService";

const BASE = { projectId: "p1", organizationId: "o1" };
const CONNECTION = {
  propertyId: "properties/42",
  currencyCode: "USD",
  hasEcommerce: true,
};

function summaryTotals(overrides: Record<string, number> = {}) {
  return {
    sessions: 100,
    engagedSessions: 60,
    userEngagementDuration: 300,
    screenPageViews: 200,
    eventCount: 400,
    newUsers: 70,
    totalRevenue: 50,
    purchaseRevenue: 40,
    transactions: 5,
    addToCarts: 6,
    checkouts: 7,
    currencyCode: "USD",
    newUsersFootnote: "new_users footnote",
    ...overrides,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getConnection.mockResolvedValue(CONNECTION);
  mocks.getGrainCoverage.mockResolvedValue({
    coveredDates: Array.from({ length: 7 }, (_, i) => `2025-01-0${i + 1}`),
    coveredThrough: "2025-01-07",
  });
});

describe("resolveAnalyticsWindows", () => {
  it("builds the current window plus the equivalent previous period", () => {
    const windows = resolveAnalyticsWindows("last_7_days", "2025-02-10");
    expect(windows.current).toEqual({
      from: "2025-02-04",
      to: "2025-02-10",
    });
    expect(windows.previous).toEqual({
      from: "2025-01-28",
      to: "2025-02-03",
    });
  });

  it("sizes the 28/30/90d windows", () => {
    expect(
      resolveAnalyticsWindows("last_28_days", "2025-02-10").current,
    ).toEqual({ from: "2025-01-14", to: "2025-02-10" });
    expect(
      resolveAnalyticsWindows("last_30_days", "2025-02-10").current,
    ).toEqual({ from: "2025-01-12", to: "2025-02-10" });
    expect(
      resolveAnalyticsWindows("last_90_days", "2025-02-10").current,
    ).toEqual({ from: "2024-11-13", to: "2025-02-10" });
  });
});

describe("AnalyticsService.getOverview", () => {
  it("returns not-connected when no connection row exists", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    expect(result).toEqual({ connected: false as const });
    expect(mocks.getSummaryTotals).not.toHaveBeenCalled();
  });

  it("computes current-vs-previous deltas with % change", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(
        summaryTotals({
          sessions: 80,
          engagedSessions: 40,
          userEngagementDuration: 160,
          screenPageViews: 100,
          eventCount: 200,
          newUsers: 35,
        }),
      );
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.totals.sessions).toEqual({
      current: 100,
      previous: 80,
      change: 20,
      pctChange: 25,
    });
    expect(result.totals.newUsers).toMatchObject({
      current: 70,
      previous: 35,
      change: 35,
      pctChange: 100,
    });
    expect(result.newUsersFootnote).toBe("new_users footnote");
  });

  it("derives engagement ratios from summed components with exact labels", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(
        summaryTotals({
          sessions: 80,
          engagedSessions: 40,
          userEngagementDuration: 160,
        }),
      );
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    // engagementRate = Σengaged/Σsessions; never averaged from daily rates.
    expect(result.totals.engagementRate).toEqual({
      current: 0.6,
      previous: 0.5,
      change: expect.closeTo(0.1),
      pctChange: expect.closeTo(20),
    });
    expect(result.totals.avgEngagementTimePerSession).toEqual({
      current: 3,
      previous: 2,
      change: 1,
      pctChange: 50,
    });
    expect(result.totals).not.toHaveProperty("averageSessionDuration");
  });

  it("reports null % change when the previous period is zero but current is not", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals({ sessions: 10 }))
      .mockResolvedValueOnce(summaryTotals({ sessions: 0 }));
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.totals.sessions).toMatchObject({
      current: 10,
      previous: 0,
      change: 10,
      pctChange: null,
    });
  });

  it("passes currency through without conversion and labels it", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(summaryTotals());
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.currencyCode).toBe("USD");
    expect(result.currencyNote).toContain("USD");
    expect(result.currencyNote).toContain("never converted");
  });

  it("labels unreported currency instead of converting", async () => {
    mocks.getConnection.mockResolvedValue({
      ...CONNECTION,
      currencyCode: null,
    });
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(summaryTotals());
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.currencyCode).toBeNull();
    expect(result.currencyNote).toContain("unreported");
  });

  it("marks partial coverage with the covered-through date", async () => {
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: ["2025-01-01", "2025-01-02"],
      coveredThrough: "2025-01-02",
    });
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(summaryTotals());
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.coverage).toMatchObject({
      status: "partial",
      coveredDates: 2,
      totalDates: 7,
      coveredThrough: "2025-01-02",
    });
  });

  it("marks empty coverage as none", async () => {
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(summaryTotals());
    mocks.getDailySummarySeries.mockResolvedValue([]);

    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.coverage).toMatchObject({ status: "none" });
  });

  it("applies device/country filters to stored grains instead of noting them reserved", async () => {
    mocks.getGeoGroups.mockResolvedValue(geoGroups());
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: Array.from({ length: 7 }, (_, i) => `2025-01-0${i + 1}`),
      coveredThrough: "2025-01-07",
    });

    const withReserved = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
      device: "mobile",
      country: "United States",
    });
    if (!withReserved.connected) throw new Error("expected connected result");
    // Country takes precedence; the unjoinable device filter is named.
    expect(withReserved.reservedFilterNote).toContain('Device "mobile"');
    expect(withReserved.totals.sessions.current).toBe(70);
    expect(withReserved.filters).toMatchObject({
      device: "mobile",
      country: "United States",
    });

    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals())
      .mockResolvedValueOnce(summaryTotals());
    mocks.getDailySummarySeries.mockResolvedValueOnce([]);
    const withoutReserved = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
    });
    if (!withoutReserved.connected)
      throw new Error("expected connected result");
    expect(withoutReserved.reservedFilterNote).toBeNull();
  });
});

describe("AnalyticsService.getAcquisition", () => {
  it("merges current and previous grouped rows with deltas and organic flags", async () => {
    mocks.getAcquisitionGroups
      .mockResolvedValueOnce([
        {
          channelGroup: "Organic Search",
          source: "google",
          medium: "organic",
          sessions: 16,
          engagedSessions: 8,
          userEngagementDuration: 80,
          screenPageViews: 20,
          eventCount: 30,
        },
        {
          channelGroup: "Direct",
          source: "(direct)",
          medium: "(none)",
          sessions: 4,
          engagedSessions: 1,
          userEngagementDuration: 10,
          screenPageViews: 5,
          eventCount: 6,
        },
      ])
      .mockResolvedValueOnce([
        {
          channelGroup: "Organic Search",
          source: "google",
          medium: "organic",
          sessions: 8,
          engagedSessions: 4,
          userEngagementDuration: 40,
          screenPageViews: 10,
          eventCount: 10,
        },
      ]);

    const result = await AnalyticsService.getAcquisition({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      channelGroup: "Organic Search",
      isOrganic: true,
      sessions: { current: 16, previous: 8, change: 8, pctChange: 100 },
    });
    expect(result.rows[1]).toMatchObject({
      channelGroup: "Direct",
      isOrganic: false,
      sessions: { current: 4, previous: 0, change: 4, pctChange: null },
    });
  });

  it("passes the channel filter to the repository (organic view)", async () => {
    mocks.getAcquisitionGroups.mockResolvedValue([]);

    await AnalyticsService.getAcquisition({
      ...BASE,
      range: "last_7_days",
      channel: "Organic Search",
    });
    expect(mocks.getAcquisitionGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { channelGroup: "Organic Search" },
    );
  });
});

describe("AnalyticsService.getLandingPages", () => {
  it("merges current/previous landing rows ordered by current sessions", async () => {
    mocks.getLandingGroups
      .mockResolvedValueOnce([
        {
          landingPage: "/b",
          sessions: 50,
          engagedSessions: 10,
          userEngagementDuration: 100,
          screenPageViews: 60,
        },
        {
          landingPage: "/a",
          sessions: 5,
          engagedSessions: 1,
          userEngagementDuration: 10,
          screenPageViews: 6,
        },
      ])
      .mockResolvedValueOnce([
        {
          landingPage: "/b",
          sessions: 25,
          engagedSessions: 5,
          userEngagementDuration: 50,
          screenPageViews: 30,
        },
      ]);

    const result = await AnalyticsService.getLandingPages({
      ...BASE,
      range: "last_7_days",
      limit: 10,
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows.map((row) => row.landingPage)).toEqual(["/b", "/a"]);
    expect(result.rows[0].sessions).toEqual({
      current: 50,
      previous: 25,
      change: 25,
      pctChange: 100,
    });
  });

  it("passes the limit through to the repository", async () => {
    mocks.getLandingGroups.mockResolvedValue([]);
    await AnalyticsService.getLandingPages({
      ...BASE,
      range: "last_7_days",
      limit: 10,
    });
    expect(mocks.getLandingGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { limit: 10 },
    );
  });
});

describe("AnalyticsService.getEvents", () => {
  it("returns not-connected when no connection row exists", async () => {
    mocks.getConnection.mockResolvedValue(null);
    const result = await AnalyticsService.getEvents({
      ...BASE,
      range: "last_7_days",
      limit: 10,
    });
    expect(result).toEqual({ connected: false as const });
    expect(mocks.getEventGroups).not.toHaveBeenCalled();
  });

  it("merges current/previous event rows with deltas", async () => {
    mocks.getEventGroups
      .mockResolvedValueOnce([
        { eventName: "page_view", eventCount: 16, isKeyEvent: false },
        { eventName: "purchase", eventCount: 4, isKeyEvent: true },
      ])
      .mockResolvedValueOnce([
        { eventName: "page_view", eventCount: 8, isKeyEvent: false },
      ]);

    const result = await AnalyticsService.getEvents({
      ...BASE,
      range: "last_7_days",
      limit: 10,
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      eventName: "page_view",
      eventCount: { current: 16, previous: 8, change: 8, pctChange: 100 },
    });
    expect(result.rows[1].eventCount).toMatchObject({
      current: 4,
      previous: 0,
      pctChange: null,
    });
  });

  it("passes limit and keyEventsOnly=false to the repository", async () => {
    mocks.getEventGroups.mockResolvedValue([]);
    await AnalyticsService.getEvents({
      ...BASE,
      range: "last_7_days",
      limit: 7,
    });
    expect(mocks.getEventGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { limit: 7, keyEventsOnly: false },
    );
  });
});

describe("AnalyticsService.getConversions", () => {
  it("reads only key events and carries the deferred-goal note", async () => {
    mocks.getEventGroups.mockResolvedValue([]);
    const result = await AnalyticsService.getConversions({
      ...BASE,
      range: "last_7_days",
      limit: 10,
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(mocks.getEventGroups).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.anything(),
      expect.anything(),
      { limit: 10, keyEventsOnly: true },
    );
    expect(result.goalSelectionDeferredNote).toContain("deferred");
  });
});

describe("AnalyticsService.getEcommerce", () => {
  it("hides the section without the hasEcommerce capability", async () => {
    mocks.getConnection.mockResolvedValue({
      ...CONNECTION,
      hasEcommerce: false,
    });
    const result = await AnalyticsService.getEcommerce({
      ...BASE,
      range: "last_7_days",
    });
    expect(result).toMatchObject({
      connected: true,
      available: false,
    });
    expect(mocks.getSummaryTotals).not.toHaveBeenCalled();
  });

  it("returns revenue deltas with currency passthrough when capable", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals({ totalRevenue: 100 }))
      .mockResolvedValueOnce(summaryTotals({ totalRevenue: 40 }));
    const result = await AnalyticsService.getEcommerce({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected || !result.available)
      throw new Error("expected available result");
    expect(result.totals.totalRevenue).toMatchObject({
      current: 100,
      previous: 40,
    });
    expect(result.currencyCode).toBe("USD");
    expect(result.currencyNote).toContain("never converted");
  });
});

describe("AnalyticsService.getAudience", () => {
  it("returns newUsers deltas with deferral and distinct-users notes", async () => {
    mocks.getSummaryTotals
      .mockResolvedValueOnce(summaryTotals({ newUsers: 70 }))
      .mockResolvedValueOnce(summaryTotals({ newUsers: 35 }));
    const result = await AnalyticsService.getAudience({
      ...BASE,
      range: "last_7_days",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.totals.newUsers).toMatchObject({
      current: 70,
      previous: 35,
      change: 35,
    });
    expect(result.newUsersFootnote).toBe("new_users footnote");
    expect(result.geoTechDeferredNote).toContain("deferred");
    expect(result.distinctUsersNote).toContain("never summed");
    expect(result).not.toHaveProperty("totalUsers");
  });
});

function geoGroups() {
  return [
    {
      country: "United States",
      sessions: 70,
      engagedSessions: 42,
      userEngagementDuration: 210,
      screenPageViews: 140,
      eventCount: 280,
      newUsers: 49,
      isOtherRow: false,
    },
    {
      country: "Germany",
      sessions: 30,
      engagedSessions: 18,
      userEngagementDuration: 90,
      screenPageViews: 60,
      eventCount: 120,
      newUsers: 21,
      isOtherRow: false,
    },
  ];
}

describe("AnalyticsService.getAnalyticsGeo", () => {
  it("returns per-country rows from the stored grain with coverage", async () => {
    mocks.getGeoGroups.mockResolvedValue(geoGroups());
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: ["2025-01-01", "2025-01-02"],
      coveredThrough: "2025-01-02",
    });
    const result = await AnalyticsService.getAnalyticsGeo({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      country: "United States",
      sessions: 70,
      newUsers: 49,
    });
    expect(result.coverage.status).toBe("complete");
    expect(mocks.getGeoGroups).toHaveBeenCalledWith(
      "p1",
      "properties/42",
      "2025-01-01",
      "2025-01-02",
    );
  });

  it("returns an explicit empty state with zero rows, never zero-filled rows", async () => {
    mocks.getGeoGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    const result = await AnalyticsService.getAnalyticsGeo({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toEqual([]);
    expect(result.coverage.status).toBe("none");
    expect(result.emptyNote).toContain("No geo data");
  });
});

describe("AnalyticsService country filter wiring", () => {  it("scopes overview totals to the stored geo grain when country is set", async () => {
    mocks.getGeoGroups.mockResolvedValue(geoGroups());
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: Array.from({ length: 7 }, (_, i) => `2025-01-0${i + 1}`),
      coveredThrough: "2025-01-07",
    });
    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
      country: "Germany",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.totals.sessions.current).toBe(30);
    expect(result.totals.newUsers.current).toBe(21);
    expect(result.reservedFilterNote).toBeNull();
    expect(mocks.getSummaryTotals).not.toHaveBeenCalled();
  });

  it("reports no coverage instead of zeros when the geo grain is uncovered", async () => {
    mocks.getGeoGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
      country: "Germany",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.coverage.status).toBe("none");
    expect(result.reservedFilterNote).toContain("No geo coverage");
  });
});

function technologyGroups() {
  return [
    {
      dimension: "device",
      value: "desktop",
      sessions: 60,
      engagedSessions: 36,
      userEngagementDuration: 180,
      screenPageViews: 120,
      eventCount: 240,
      newUsers: 42,
      isOtherRow: false,
    },
    {
      dimension: "device",
      value: "mobile",
      sessions: 40,
      engagedSessions: 24,
      userEngagementDuration: 120,
      screenPageViews: 80,
      eventCount: 160,
      newUsers: 28,
      isOtherRow: false,
    },
  ];
}

describe("AnalyticsService.getAnalyticsTechnology", () => {
  it("returns per-value rows for the requested dimension with coverage", async () => {
    mocks.getTechnologyGroups.mockResolvedValue(technologyGroups());
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: ["2025-01-01", "2025-01-02"],
      coveredThrough: "2025-01-02",
    });
    const result = await AnalyticsService.getAnalyticsTechnology({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
      dimension: "device",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      dimension: "device",
      value: "desktop",
      sessions: 60,
    });
    expect(result.coverage.status).toBe("complete");
    expect(mocks.getTechnologyGroups).toHaveBeenCalledWith(
      "p1",
      "properties/42",
      "2025-01-01",
      "2025-01-02",
      { dimension: "device" },
    );
  });

  it("returns an explicit empty state with zero rows, never zero-filled rows", async () => {
    mocks.getTechnologyGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    const result = await AnalyticsService.getAnalyticsTechnology({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
      dimension: "browser",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toEqual([]);
    expect(result.coverage.status).toBe("none");
    expect(result.emptyNote).toContain("No technology data");
  });
});

describe("AnalyticsService device filter wiring", () => {  it("scopes overview totals to the stored technology grain when device is set", async () => {
    mocks.getTechnologyGroups.mockResolvedValue(technologyGroups());
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: Array.from({ length: 7 }, (_, i) => `2025-01-0${i + 1}`),
      coveredThrough: "2025-01-07",
    });
    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
      device: "mobile",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.totals.sessions.current).toBe(40);
    expect(result.totals.newUsers.current).toBe(28);
    expect(result.reservedFilterNote).toBeNull();
  });

  it("reports no coverage instead of zeros when the technology grain is uncovered", async () => {
    mocks.getTechnologyGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    const result = await AnalyticsService.getOverview({
      ...BASE,
      range: "last_7_days",
      device: "mobile",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.coverage.status).toBe("none");
    expect(result.reservedFilterNote).toContain("No technology coverage");
  });
});

describe("AnalyticsService geo/tech zero-row vs failure", () => {
  it("marks covered-empty geo windows complete with a covered-period note", async () => {
    mocks.getGeoGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: ["2025-01-01", "2025-01-02"],
      coveredThrough: "2025-01-02",
    });
    const result = await AnalyticsService.getAnalyticsGeo({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toEqual([]);
    expect(result.coverage.status).toBe("complete");
    expect(result.emptyNote).toContain("covered period");
  });

  it("marks failed-date geo windows none with a sync note, never zeros", async () => {
    mocks.getGeoGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: [],
      coveredThrough: null,
    });
    const result = await AnalyticsService.getAnalyticsGeo({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-02",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toEqual([]);
    expect(result.coverage.status).toBe("none");
    expect(result.emptyNote).toContain("No geo data");
  });

  it("marks covered-empty technology windows complete with a covered-period note", async () => {
    mocks.getTechnologyGroups.mockResolvedValue([]);
    mocks.getGrainCoverage.mockResolvedValue({
      coveredDates: ["2025-01-01"],
      coveredThrough: "2025-01-01",
    });
    const result = await AnalyticsService.getAnalyticsTechnology({
      ...BASE,
      from: "2025-01-01",
      to: "2025-01-01",
      dimension: "os",
    });
    if (!result.connected) throw new Error("expected connected result");
    expect(result.rows).toEqual([]);
    expect(result.coverage.status).toBe("complete");
    expect(result.emptyNote).toContain("covered period");
  });
});
