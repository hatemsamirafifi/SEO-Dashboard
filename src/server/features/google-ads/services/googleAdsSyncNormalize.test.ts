import { describe, expect, it } from "vitest";
import {
  adGroupDimensionsFromRows,
  campaignDimensionsFromRows,
  keywordDimensionsFromRows,
  normalizedUnitRows,
  stagedMetricsFromDaily,
} from "./googleAdsSyncNormalize";

describe("stagedMetricsFromDaily", () => {
  it("keeps finite non-negative metrics and rejects lossy or negative cells", () => {
    const metrics = stagedMetricsFromDaily({
      impressions: 120,
      clicks: 7,
      costMicros: "9000000000000000000",
      conversions: 2.5,
      conversionsValue: -1,
    });
    expect(metrics).toEqual({
      impressions: 120,
      clicks: 7,
      // An over-safe-integer digit text is rejected, never rounded.
      costMicros: null,
      conversions: 2.5,
      conversionsValue: null,
    });
  });

  it("treats absent cells as absent, never as zero", () => {
    expect(
      stagedMetricsFromDaily({
        impressions: null,
        clicks: null,
        costMicros: null,
        conversions: null,
        conversionsValue: null,
      }),
    ).toEqual({
      impressions: null,
      clicks: null,
      costMicros: null,
      conversions: null,
      conversionsValue: null,
    });
    expect(
      stagedMetricsFromDaily({
        impressions: Number.NaN,
        clicks: Infinity,
        costMicros: "not-digits",
        conversions: Number.NaN,
        conversionsValue: 0,
      }),
    ).toEqual({
      impressions: null,
      clicks: null,
      costMicros: null,
      conversions: null,
      conversionsValue: 0,
    });
  });

  it("accepts exact int64 digit text within the safe range", () => {
    expect(
      stagedMetricsFromDaily({
        impressions: "9223372036854775807",
        clicks: "42",
        costMicros: 5_000_000,
        conversions: null,
        conversionsValue: null,
      }),
    ).toMatchObject({ clicks: 42, costMicros: 5_000_000 });
    // Exact int64 max is beyond MAX_SAFE_INTEGER: rejected, not imprecise.
    expect(
      stagedMetricsFromDaily({
        impressions: "12345678901234567890",
        clicks: "0",
        costMicros: null,
        conversions: null,
        conversionsValue: null,
      }).impressions,
    ).toBeNull();
  });
});

const METRICS = {
  impressions: 10,
  clicks: 2,
  costMicros: 50000,
  conversions: 1,
  conversionsValue: 5,
};

describe("normalizedUnitRows", () => {
  it("stages account rows keyed by metrics alone", () => {
    const { rows, malformedRows } = normalizedUnitRows(
      "account",
      "2026-10-01",
      [{ date: "2026-10-01", metrics: METRICS }],
    );
    expect(rows).toEqual([{ metrics: { ...METRICS } }]);
    expect(malformedRows).toBe(0);
  });

  it("counts date-mismatched rows as malformed and drops them", () => {
    const { rows, malformedRows } = normalizedUnitRows(
      "account",
      "2026-10-01",
      [{ date: "2026-09-30", metrics: METRICS }],
    );
    expect(rows).toEqual([]);
    expect(malformedRows).toBe(1);
  });

  it("stages campaign rows and counts dimensionless rows as malformed", () => {
    const { rows, malformedRows } = normalizedUnitRows(
      "campaign",
      "2026-10-01",
      [
        {
          date: "2026-10-01",
          campaignResourceId: "campaign-1",
          campaignId: "123",
          metrics: METRICS,
        },
        { date: "2026-10-01", metrics: METRICS },
        {
          date: "2026-10-01",
          campaignResourceId: "campaign-2",
          campaignId: null,
          metrics: METRICS,
        },
      ],
    );
    expect(rows).toEqual([
      { metrics: { ...METRICS }, campaignResourceId: "campaign-1" },
    ]);
    expect(malformedRows).toBe(2);
  });

  it("stages keyword, search-term, device and landing-page grains with their keys", () => {
    const keyword = normalizedUnitRows("keyword", "2026-10-01", [
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        adGroupResourceId: "a1",
        keywordResourceId: "k1",
        keywordText: "red shoes",
        keywordMatchType: "EXACT",
        metrics: METRICS,
      },
    ]);
    expect(keyword.rows).toEqual([
      {
        metrics: { ...METRICS },
        campaignResourceId: "c1",
        adGroupResourceId: "a1",
        keywordResourceId: "k1",
      },
    ]);
    expect(keyword.malformedRows).toBe(0);

    const searchTerm = normalizedUnitRows("search_term", "2026-10-01", [
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        adGroupResourceId: "a1",
        searchText: "red shoes",
        metrics: METRICS,
      },
    ]);
    expect(searchTerm.rows[0]).toMatchObject({
      metrics: { ...METRICS },
      searchText: "red shoes",
    });

    const device = normalizedUnitRows("device", "2026-10-01", [
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        device: "MOBILE",
        metrics: METRICS,
      },
    ]);
    expect(device.rows[0]).toMatchObject({
      metrics: { ...METRICS },
      device: "MOBILE",
    });

    const landing = normalizedUnitRows("landing_page", "2026-10-01", [
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        landingPageUrl: "https://example.test/landing",
        metrics: METRICS,
      },
    ]);
    expect(landing.rows[0]).toMatchObject({
      metrics: { ...METRICS },
      landingPageUrl: "https://example.test/landing",
    });
  });
});

describe("dimension builders", () => {
  it("deduplicates campaign dimensions and skips rows without identity", () => {
    const dimensions = campaignDimensionsFromRows([
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        campaignId: "123",
        campaignName: "Brand",
        campaignStatus: "ENABLED",
        servingStatus: "SERVING",
        advertisingChannelType: "SEARCH",
        metrics: METRICS,
      },
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        campaignId: "123",
        campaignName: "Brand (renamed)",
        campaignStatus: "ENABLED",
        servingStatus: "SERVING",
        advertisingChannelType: "SEARCH",
        metrics: METRICS,
      },
      {
        date: "2026-10-01",
        campaignResourceId: "c2",
        campaignId: "999",
        campaignName: "   ",
        campaignStatus: "ENABLED",
        servingStatus: null,
        advertisingChannelType: null,
        metrics: METRICS,
      },
    ]);
    // Last row lacks a non-empty name (enrichment only, never required).
    expect(dimensions).toHaveLength(1);
    expect(dimensions[0]).toEqual({
      campaignResourceId: "c1",
      campaignId: "123",
      name: "Brand (renamed)",
      status: "ENABLED",
      servingStatus: "SERVING",
      advertisingChannelType: "SEARCH",
    });
  });

  it("builds ad-group and keyword dimensions with bounded text", () => {
    const adGroups = adGroupDimensionsFromRows([
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        adGroupId: "456",
        adGroupResourceId: "a1",
        adGroupName: "Shoes",
        adGroupStatus: "ENABLED",
        metrics: METRICS,
      },
    ]);
    expect(adGroups[0]).toMatchObject({
      adGroupResourceId: "a1",
      campaignResourceId: "c1",
      name: "Shoes",
    });

    const keywords = keywordDimensionsFromRows([
      {
        date: "2026-10-01",
        campaignResourceId: "c1",
        adGroupResourceId: "a1",
        keywordResourceId: "k1",
        criterionId: "789",
        keywordText: "red shoes",
        keywordMatchType: null,
        metrics: METRICS,
      },
    ]);
    expect(keywords[0]).toMatchObject({
      keywordResourceId: "k1",
      keywordText: "red shoes",
      keywordMatchType: null,
    });
  });
});
