import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  COMPLETE_DAY,
  FETCHED_AT,
  SCOPE,
  analyticsTestDbEach,
  campaignRow,
  initializeAnalyticsTestDatabase,
  publish,
  publishGrain,
} from "./googleAdsAnalyticsTestDb";
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import { getOverview, getSyncState } from "./GoogleAdsAnalyticsService";

beforeAll(() => initializeAnalyticsTestDatabase());
analyticsTestDbEach();
afterAll(() => {
  // Each test file owns a fresh in-memory database; vitest's worker teardown
  // closes the connection, so no cross-file connection sharing is needed.
});

describe("GoogleAdsAnalyticsService.getOverview", () => {
  it("aggregates stored sums with arithmetic-fixture precision", async () => {
    await publish("2026-01-15", COMPLETE_DAY);
    const overview = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-01", endDate: "2026-01-31" },
    });
    expect(overview.totals).toMatchObject({
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
    expect(overview.coverage).toMatchObject({
      status: "partial",
      coveredDates: 1,
      totalDates: 31,
    });
    expect(overview.rowCount).toBe(1);
    expect(overview.daily).toHaveLength(1);
    expect(overview.daily[0]?.totals.ctr).toBe(0.1);
  });

  it("reports uncovered/covered-empty/covered via published units", async () => {
    await publish("2026-01-15", null);
    const emptyDay = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-15", endDate: "2026-01-15" },
    });
    expect(emptyDay.coverage.status).toBe("covered-empty");
    expect(emptyDay.totals.impressions).toBeNull();
    expect(emptyDay.totals.cost).toBeNull();

    const uncovered = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-01", endDate: "2026-01-02" },
    });
    expect(uncovered.coverage.status).toBe("uncovered");
    expect(
      (
        await getOverview({
          scope: SCOPE,
          window: { startDate: "2026-01-14", endDate: "2026-01-16" },
        })
      ).coverage.status,
    ).toBe("partial");

    await publish("2026-01-16", COMPLETE_DAY);
    expect(
      (
        await getOverview({
          scope: SCOPE,
          window: { startDate: "2026-01-15", endDate: "2026-01-16" },
        })
      ).coverage.status,
    ).toBe("covered");
  });

  it("caps query windows at the bounded month range", async () => {
    await expect(
      getOverview({
        scope: SCOPE,
        window: { startDate: "2020-01-01", endDate: "2026-01-01" },
      }),
    ).rejects.toThrow(/capped/);
    await expect(
      getOverview({
        scope: SCOPE,
        window: { startDate: "2026-05-01", endDate: "2026-01-01" },
      }),
    ).rejects.toThrow(/after the end/);
  });

  it("runs the gated equal-length preceding comparison", async () => {
    // Current window fully covered (2 days).
    await publish("2026-02-01", COMPLETE_DAY);
    await publish("2026-02-02", COMPLETE_DAY);
    const gated = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    // Preceding window (2026-01-31..02-01 shifted back) has no data: refused.
    expect(gated.compare.gate).toBe("partial_coverage");
    expect(gated.compare.deltas).toBeNull();

    // Publish the preceding window too; the gate opens.
    await publish("2026-01-30", COMPLETE_DAY);
    await publish("2026-01-31", COMPLETE_DAY);
    const ready = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    expect(ready.compare.gate).toBe("ready");
    expect(ready.compare.window).toEqual({
      startDate: "2026-01-30",
      endDate: "2026-01-31",
    });
    expect(ready.compare.deltas?.[0]).toMatchObject({
      metric: "impressions",
      current: 200,
      previous: 200,
      pctChange: 0,
    });

    // Mixed metricDateBasis across the two fully-covered windows closes the
    // gate again (coverage passes, basis check refuses).
    await GoogleAdsAnalyticsRepository.publishUnit({
      scope: SCOPE,
      date: "2026-02-02",
      grain: "account",
      rows: [{ metrics: COMPLETE_DAY }],
      sourceFetchedAt: FETCHED_AT,
      currencyCode: "USD",
      metricDateBasis: "conversion_date",
    });
    const mixed = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    expect(mixed.coverage.status).toBe("covered");
    expect(mixed.compare.gate).toBe("mixed_metric_date_basis");
  });

  it("returns the bounded sync state ledger", async () => {
    await publish("2026-01-15", COMPLETE_DAY);
    await publishGrain("2026-01-15", "campaign", [campaignRow("campaign-1")]);

    const state = await getSyncState(SCOPE);
    expect(state.activeRun).toBeNull();
    expect(state.runs).toEqual([]);
    expect(state.units).toMatchObject({
      total: 2,
      pending: 0,
      successWithData: 2,
      successZeroRows: 0,
      partial: 0,
      failed: 0,
    });

    expect(
      (
        await getSyncState({
          projectId: "unknown-project",
          organizationId: "org-a",
          customerId: "1234567890",
        })
      ).units,
    ).toMatchObject({ total: 0 });
  });
});
