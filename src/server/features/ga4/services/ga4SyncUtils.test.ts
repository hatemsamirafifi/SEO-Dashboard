import { describe, expect, it } from "vitest";
import {
  buildGeoTechSubRequests,
  buildGrainSubRequests,
  eachDayUtc,
  GA4_GEO_TECH_SUB_REQUEST_COUNT,
  GA4_GEO_TOP_N,
  GA4_GRAINS,
  GA4_INITIAL_WINDOW_DAYS,
  GA4_LANDING_PAGE_TOP_N,
  GA4_REPORT_MAX_PAGES,
  GA4_REPORT_PAGE_LIMIT,
  GA4_SYNC_CHUNK_DAYS,
  GA4_TECHNOLOGY_TOP_N,
  isFatalGa4ErrorClass,
  isGa4SyncGrain,
  isSuccessCoverageStatus,
  rollUpOtherTail,
} from "./ga4SyncUtils";

describe("GA4 sync grains", () => {
  it("covers the six stored grains", () => {
    expect([...GA4_GRAINS].toSorted()).toEqual([
      "acquisition",
      "events",
      "geo",
      "landing_pages",
      "summary",
      "technology",
    ]);
  });

  it("builds five sub-requests for one chunk (summary split by the 10-metric API cap)", () => {
    const requests = buildGrainSubRequests({
      propertyId: "42",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(requests).toHaveLength(5);
    for (const request of requests) {
      expect(request.propertyId).toBe("42");
      expect(request.dateRanges).toEqual([
        { startDate: "2025-01-01", endDate: "2025-01-07" },
      ]);
      expect(request.metrics.length).toBeLessThanOrEqual(10);
    }
    const summaryMetrics = requests
      .filter((request) => request.dimensions.join() === "date")
      .flatMap((request) => request.metrics);
    expect(summaryMetrics).toContain("sessions");
    expect(summaryMetrics).toContain("totalRevenue");
    const landing = requests.find((request) =>
      request.dimensions.includes("landingPagePlusQueryString"),
    );
    expect(landing?.limit).toBe(GA4_LANDING_PAGE_TOP_N);
  });

  it("builds two geo/tech sub-requests outside the five-request batch cap", () => {
    const requests = buildGeoTechSubRequests({
      propertyId: "42",
      startDate: "2025-01-01",
      endDate: "2025-01-07",
    });
    expect(requests).toHaveLength(GA4_GEO_TECH_SUB_REQUEST_COUNT);
    const [geo, tech] = requests;
    expect(geo?.dimensions).toEqual(["date", "country"]);
    expect(tech?.dimensions).toEqual([
      "date",
      "deviceCategory",
      "browser",
      "operatingSystem",
    ]);
    for (const request of requests) {
      expect(request?.metrics).toEqual([
        "sessions",
        "engagedSessions",
        "userEngagementDuration",
        "screenPageViews",
        "eventCount",
        "newUsers",
      ]);
      expect(request?.metrics.length).toBeLessThanOrEqual(10);
    }
    expect(GA4_GEO_TOP_N).toBeGreaterThan(0);
    expect(GA4_TECHNOLOGY_TOP_N).toBeGreaterThan(0);
  });
});

function tailMetrics(sessions: number) {
  return {
    sessions,
    engagedSessions: 1,
    userEngagementDuration: 10,
    screenPageViews: 2,
    eventCount: 3,
    newUsers: 1,
  };
}

describe("rollUpOtherTail", () => {
  it("passes small sets through with no truncation", () => {
    const rollup = rollUpOtherTail({
      rows: [
        { key: "b", metrics: tailMetrics(5) },
        { key: "a", metrics: tailMetrics(9) },
      ],
      topN: 300,
      countsKnown: true,
    });
    expect(rollup.retained.map((row) => row.key)).toEqual(["a", "b"]);
    expect(rollup.other).toBeNull();
    expect(rollup.isTruncated).toBe(false);
    expect(rollup.otherRowPresent).toBe(false);
    expect(rollup.omittedDimensionCount).toBeNull();
  });

  it("ranks sessions-desc with key-asc ties and sums the tail exactly", () => {
    const rollup = rollUpOtherTail({
      rows: [
        { key: "c", metrics: tailMetrics(4) },
        { key: "b", metrics: tailMetrics(4) },
        { key: "a", metrics: tailMetrics(10) },
      ],
      topN: 2,
      countsKnown: true,
    });
    expect(rollup.retained.map((row) => row.key)).toEqual(["a", "b"]);
    expect(rollup.other?.sessions).toBe(4);
    expect(rollup.isTruncated).toBe(true);
    expect(rollup.retainedDimensionCount).toBe(2);
    expect(rollup.omittedDimensionCount).toBe(1);
    expect(rollup.otherRowPresent).toBe(true);
  });

  it("folds API-returned (other) rows into the tail with counts unknown", () => {
    const rollup = rollUpOtherTail({
      rows: [
        { key: "a", metrics: tailMetrics(10) },
        { key: "(other)", metrics: tailMetrics(7) },
      ],
      topN: 300,
      countsKnown: true,
    });
    expect(rollup.retained.map((row) => row.key)).toEqual(["a"]);
    expect(rollup.other?.sessions).toBe(7);
    expect(rollup.isTruncated).toBe(true);
    expect(rollup.omittedDimensionCount).toBeNull();
  });

  it("reports counts unknown when pagination stopped early", () => {
    const rollup = rollUpOtherTail({
      rows: [
        { key: "a", metrics: tailMetrics(10) },
        { key: "b", metrics: tailMetrics(1) },
      ],
      topN: 1,
      countsKnown: false,
    });
    expect(rollup.other?.sessions).toBe(1);
    expect(rollup.omittedDimensionCount).toBeNull();
    expect(rollup.isTruncated).toBe(true);
  });
});

describe("eachDayUtc", () => {
  it("lists every day in a closed range", () => {
    expect(eachDayUtc("2025-01-01", "2025-01-03")).toEqual([
      "2025-01-01",
      "2025-01-02",
      "2025-01-03",
    ]);
  });

  it("returns an empty list for inverted or invalid ranges", () => {
    expect(eachDayUtc("2025-01-03", "2025-01-01")).toEqual([]);
    expect(eachDayUtc("nope", "2025-01-01")).toEqual([]);
  });
});

describe("sync constants", () => {
  it("uses a 7-day chunk with a bounded landing-page top-N", () => {
    expect(GA4_SYNC_CHUNK_DAYS).toBe(7);
    expect(GA4_LANDING_PAGE_TOP_N).toBeGreaterThan(0);
    expect(GA4_REPORT_PAGE_LIMIT).toBeLessThanOrEqual(100_000);
    expect(GA4_REPORT_MAX_PAGES).toBeGreaterThan(0);
    expect(GA4_INITIAL_WINDOW_DAYS).toBe(90);
  });

  it("treats quota as non-fatal and permission/token failures as fatal", () => {
    expect(isFatalGa4ErrorClass("QUOTA_EXHAUSTED")).toBe(false);
    expect(isFatalGa4ErrorClass("OAUTH_TOKEN_FAILURE")).toBe(true);
    expect(isFatalGa4ErrorClass("PERMISSION_DENIED")).toBe(true);
    expect(isFatalGa4ErrorClass("PROPERTY_NOT_FOUND")).toBe(true);
    expect(isFatalGa4ErrorClass("INVALID_REQUEST")).toBe(true);
  });

  it("recognizes success coverage states case-insensitively", () => {
    expect(isSuccessCoverageStatus("SUCCESS_WITH_DATA")).toBe(true);
    expect(isSuccessCoverageStatus("success_zero_rows")).toBe(true);
    expect(isSuccessCoverageStatus("PENDING")).toBe(false);
    expect(isSuccessCoverageStatus("FAILED")).toBe(false);
    expect(isGa4SyncGrain("summary")).toBe(true);
    expect(isGa4SyncGrain("nope")).toBe(false);
  });
});
