import { describe, expect, it } from "vitest";
import {
  buildGrainSubRequests,
  eachDayUtc,
  GA4_GRAINS,
  GA4_INITIAL_WINDOW_DAYS,
  GA4_LANDING_PAGE_TOP_N,
  GA4_REPORT_MAX_PAGES,
  GA4_REPORT_PAGE_LIMIT,
  GA4_SYNC_CHUNK_DAYS,
  isFatalGa4ErrorClass,
  isGa4SyncGrain,
  isSuccessCoverageStatus,
} from "./ga4SyncUtils";

describe("GA4 sync grains", () => {
  it("covers the four stored grains", () => {
    expect([...GA4_GRAINS].toSorted()).toEqual([
      "acquisition",
      "events",
      "landing_pages",
      "summary",
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