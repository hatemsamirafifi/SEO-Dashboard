import { describe, expect, it } from "vitest";
import {
  assertGoogleAdsWindow,
  costFromMicros,
  googleAdsCompareGate,
  googleAdsCoverageFromUnits,
  googleAdsKpiDeltas,
  googleAdsWindowDayCount,
  kpisFromSums,
  precedingGoogleAdsWindow,
  ratioOrNull,
} from "./googleAdsAnalyticsMath";

function total(value: number | null, missing = false) {
  return { total: value, hasMissingComponents: missing };
}

const user = (status: string, date: string) => ({
  date,
  status,
  publishedGenerationId: "gen-1",
});

const covered = (date: string) => ({
  date,
  status: "success_with_data",
  publishedGenerationId: "gen",
  metricDateBasis: null,
});

describe("googleAdsAnalyticsMath", () => {
  it("derives cost from micros with null passthrough", () => {
    expect(costFromMicros(2_500_000)).toBe(2.5);
    expect(costFromMicros(5_000_000_000)).toBe(5000);
    expect(costFromMicros(null)).toBeNull();
  });

  it("only derives ratios from complete components", () => {
    expect(ratioOrNull(total(10), total(100))).toBe(0.1);
    expect(ratioOrNull(total(10, true), total(100))).toBeNull();
    expect(ratioOrNull(total(10), total(100, true))).toBeNull();
    expect(ratioOrNull(total(10), total(null))).toBeNull();
    expect(ratioOrNull(total(10), total(0))).toBeNull();
  });

  it("computes kpis with ratios, incomplete components reported as null", () => {
    const complete = kpisFromSums({
      rowCount: 1,
      impressions: total(100),
      clicks: total(10),
      costMicros: total(2_500_000),
      conversions: total(2.5),
      conversionsValue: total(50),
    });
    expect(complete).toEqual({
      impressions: 100,
      clicks: 10,
      cost: 2.5,
      conversions: 2.5,
      conversionsValue: 50,
      ctr: 0.1,
      cpc: 0.25,
      cpa: 1,
      roas: 20,
    });

    const partial = kpisFromSums({
      rowCount: 1,
      impressions: total(100),
      clicks: total(10),
      costMicros: total(2_500_000),
      conversions: total(2.5, true),
      conversionsValue: total(null),
    });
    // CPA / ROAS skip when conversions or value have missing components.
    expect(partial.cpa).toBeNull();
    expect(partial.roas).toBeNull();
    // CTR / CPC remain valid from complete impressions/clicks/cost.
    expect(partial.ctr).toBe(0.1);
    expect(partial.cpc).toBe(0.25);
  });

  it("caps windows at the bounded month range", () => {
    expect(() =>
      assertGoogleAdsWindow({ startDate: "2026-01-01", endDate: "2026-01-31" }),
    ).not.toThrow();
    expect(() =>
      assertGoogleAdsWindow({ startDate: "2026-01-01", endDate: "2029-02-01" }),
    ).toThrow(/capped/);

    expect(() =>
      assertGoogleAdsWindow({ startDate: "2026-01-01", endDate: "2025-12-31" }),
    ).toThrow(/after the end/);
    expect(
      googleAdsWindowDayCount({
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }),
    ).toBe(31);
    expect(
      precedingGoogleAdsWindow({
        startDate: "2026-02-01",
        endDate: "2026-02-15",
      }),
    ).toEqual({ startDate: "2026-01-17", endDate: "2026-01-31" });
  });

  it("reports coverage states uncovered/covered-empty/covered/partial", () => {
    const window = { startDate: "2026-01-01", endDate: "2026-01-04" };
    expect(googleAdsCoverageFromUnits([], window)).toMatchObject({
      status: "uncovered",
      coveredDates: 0,
      totalDates: 4,
      firstCoveredDate: null,
      lastCoveredDate: null,
    });
    expect(
      googleAdsCoverageFromUnits(
        [
          user("success_zero_rows", "2026-01-01"),
          user("success_zero_rows", "2026-01-02"),
          user("success_zero_rows", "2026-01-03"),
          user("success_zero_rows", "2026-01-04"),
        ],
        window,
      ),
    ).toMatchObject({
      status: "covered-empty",
      coveredDates: 4,
      firstCoveredDate: "2026-01-01",
      lastCoveredDate: "2026-01-04",
    });
    expect(
      googleAdsCoverageFromUnits(
        [
          user("success_with_data", "2026-01-01"),
          user("success_with_data", "2026-01-02"),
          user("success_with_data", "2026-01-03"),
          user("success_with_data", "2026-01-04"),
        ],
        window,
      ),
    ).toMatchObject({ status: "covered" });
    expect(
      googleAdsCoverageFromUnits(
        [
          user("success_with_data", "2026-01-01"),
          user("failed", "2026-01-02"),
          user("success_with_data", "2026-01-03"),
        ],
        window,
      ).status,
    ).toBe("partial");
  });

  it("gates the preceding comparison on full coverage + single basis", () => {
    const currentWindow = { startDate: "2026-02-01", endDate: "2026-02-02" };
    const previousWindow = { startDate: "2026-01-01", endDate: "2026-01-02" };
    expect(
      googleAdsCompareGate(
        [covered("2026-02-01"), covered("2026-02-02")],
        [covered("2026-01-01"), covered("2026-01-02")],
        currentWindow,
        previousWindow,
      ),
    ).toEqual({ gate: "ready" });

    // Mixed bases are refused.
    expect(
      googleAdsCompareGate(
        [
          {
            date: "2026-02-01",
            status: "success_with_data",
            publishedGenerationId: "g",
            metricDateBasis: "date",
          },
          {
            date: "2026-02-02",
            status: "success_with_data",
            publishedGenerationId: "g",
            metricDateBasis: null,
          },
        ],
        [covered("2026-01-01"), covered("2026-01-02")],
        currentWindow,
        previousWindow,
      ),
    ).toEqual({ gate: "unavailable", reason: "mixed_metric_date_basis" });

    // Partial coverage is refused.
    expect(
      googleAdsCompareGate(
        [covered("2026-02-01")],
        [covered("2026-01-01"), covered("2026-01-02")],
        currentWindow,
        previousWindow,
      ),
    ).toEqual({ gate: "unavailable", reason: "partial_coverage" });

    // Unequal windows are refused.
    expect(
      googleAdsCompareGate(
        [covered("2026-02-01"), covered("2026-02-02"), covered("2026-02-03")],
        [covered("2026-01-01"), covered("2026-01-02")],
        { startDate: "2026-02-01", endDate: "2026-02-03" },
        previousWindow,
      ),
    ).toEqual({ gate: "unavailable", reason: "unequal_windows" });
  });

  it("computes deltas with pctChange guarded against zero/null baselines", () => {
    const deltas = googleAdsKpiDeltas(
      {
        impressions: 140,
        clicks: 12,
        cost: 3,
        conversions: 3,
        conversionsValue: 60,
        ctr: 0.1,
        cpc: 0.25,
        cpa: 1,
        roas: 20,
      },
      {
        impressions: 100,
        clicks: 10,
        cost: 2.5,
        conversions: 2.5,
        conversionsValue: 50,
        ctr: 0.1,
        cpc: 0.25,
        cpa: 1,
        roas: 20,
      },
    );
    expect(deltas.find((d) => d.metric === "impressions")).toMatchObject({
      current: 140,
      previous: 100,
      absoluteChange: 40,
      pctChange: 40,
    });
    // Zero baselines report pctChange null, never Infinity.
    expect(
      googleAdsKpiDeltas(
        {
          impressions: 10,
          clicks: null,
          cost: null,
          conversions: null,
          conversionsValue: null,
          ctr: null,
          cpc: null,
          cpa: null,
          roas: null,
        },
        {
          impressions: 0,
          clicks: null,
          cost: null,
          conversions: null,
          conversionsValue: null,
          ctr: null,
          cpc: null,
          cpa: null,
          roas: null,
        },
      ).find((d) => d.metric === "impressions"),
    ).toMatchObject({ pctChange: null, absoluteChange: 10 });
  });
});
