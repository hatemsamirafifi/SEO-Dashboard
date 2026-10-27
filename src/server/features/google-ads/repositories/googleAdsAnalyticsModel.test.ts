import { describe, expect, it } from "vitest";
import {
  GOOGLE_ADS_GRAINS,
  googleAdsFactsWindowSchema,
  googleAdsPublishFenceSchema,
  googleAdsUnitScopeSchema,
  isGoogleAdsIsoDate,
  isGoogleAdsIsoInstant,
  parseStagedFactRows,
} from "./googleAdsAnalyticsModel";

describe("googleAdsAnalyticsModel", () => {
  it("stores the seven never-combinable grains", () => {
    expect(GOOGLE_ADS_GRAINS).toEqual([
      "account",
      "campaign",
      "ad_group",
      "keyword",
      "search_term",
      "device",
      "landing_page",
    ]);
  });

  it("validates strict ISO dates and instants", () => {
    expect(isGoogleAdsIsoDate("2026-01-31")).toBe(true);
    expect(isGoogleAdsIsoDate("2026-02-30")).toBe(false);
    expect(isGoogleAdsIsoDate("2026-2-3")).toBe(false);
    expect(isGoogleAdsIsoDate(123)).toBe(false);
    expect(isGoogleAdsIsoInstant("2026-01-01T00:00:00.000Z")).toBe(true);
    expect(isGoogleAdsIsoInstant("not-an-instant")).toBe(false);
  });

  it("validates the unit scope against ten digit Ads customer ids", () => {
    expect(() =>
      googleAdsUnitScopeSchema.parse({
        organizationId: "org-a",
        projectId: "project-1",
        customerId: "123-456-7890",
      }),
    ).toThrow();
    expect(
      googleAdsUnitScopeSchema.parse({
        organizationId: "org-a",
        projectId: "project-1",
        customerId: "1234567890",
      }),
    ).toEqual({
      organizationId: "org-a",
      projectId: "project-1",
      customerId: "1234567890",
    });
    // Unknown parameters are rejected, not silently dropped.
    expect(() =>
      googleAdsUnitScopeSchema.parse({
        organizationId: "org-a",
        projectId: "project-1",
        customerId: "1234567890",
        sneaky: true,
      }),
    ).toThrow();
  });

  it("validates reporting windows inclusively", () => {
    expect(
      googleAdsFactsWindowSchema.parse({
        startDate: "2026-01-01",
        endDate: "2026-01-01",
      }),
    ).toEqual({ startDate: "2026-01-01", endDate: "2026-01-01" });
    expect(() =>
      googleAdsFactsWindowSchema.parse({
        startDate: "2026-01-02",
        endDate: "2026-01-01",
      }),
    ).toThrow();
    expect(() =>
      googleAdsFactsWindowSchema.parse({
        startDate: "not-a-date",
        endDate: "2026-01-01",
      }),
    ).toThrow();
  });

  it("validates publish fences strictly, including the immutable connection id", () => {
    const fence = {
      connectionId: "conn-row-1",
      grantAccountId: "google-sub-1",
      connectionUpdatedAt: "2026-01-01T00:00:00.000Z",
    };
    expect(googleAdsPublishFenceSchema.parse(fence)).toEqual(fence);
    expect(() =>
      googleAdsPublishFenceSchema.parse({
        ...fence,
        connectionUpdatedAt: "nope",
      }),
    ).toThrow();
    expect(() =>
      googleAdsPublishFenceSchema.parse({
        grantAccountId: "google-sub-1",
        connectionUpdatedAt: "2026-01-01T00:00:00.000Z",
      }),
    ).toThrow();
  });

  it("validates staged rows per grain and rejects unknown fields", () => {
    expect(
      parseStagedFactRows("campaign", [
        {
          campaignResourceId: "customers/1234567890/campaigns/42",
          metrics: {
            impressions: 100,
            clicks: 10,
            costMicros: 2500000,
            conversions: 2.5,
            conversionsValue: 50,
          },
        },
      ]),
    ).toEqual([
      {
        campaignResourceId: "customers/1234567890/campaigns/42",
        metrics: {
          impressions: 100,
          clicks: 10,
          costMicros: 2500000,
          conversions: 2.5,
          conversionsValue: 50,
        },
      },
    ]);

    // Nulls mean "not reported", never zero.
    expect(parseStagedFactRows("account", [{ metrics: null }])).toEqual([
      { metrics: null },
    ]);

    // Wrong grain dimensions are rejected.
    expect(() =>
      parseStagedFactRows("account", [
        { campaignResourceId: "campaigns/1", metrics: null },
      ]),
    ).toThrow();

    // Unknown extra fields are rejected.
    expect(() =>
      parseStagedFactRows("account", [{ metrics: null, device: "DESKTOP" }]),
    ).toThrow();

    // Negative or overflowing metrics are rejected outright.
    expect(() =>
      parseStagedFactRows("account", [{ metrics: { costMicros: -1 } }]),
    ).toThrow();
    expect(() =>
      parseStagedFactRows("account", [
        { metrics: { impressions: Number.MAX_SAFE_INTEGER + 1 } },
      ]),
    ).toThrow();

    // Devices accept the bounded Ads enum.
    expect(
      parseStagedFactRows("device", [
        {
          campaignResourceId: "customers/1234567890/campaigns/42",
          device: "MOBILE",
          metrics: { impressions: 1 },
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      parseStagedFactRows("device", [
        {
          campaignResourceId: "x",
          device: "NOT_A_DEVICE",
          metrics: null,
        },
      ]),
    ).toThrow();

    // Search terms require non-empty text.
    expect(() =>
      parseStagedFactRows("search_term", [
        {
          campaignResourceId: "x",
          adGroupResourceId: "y",
          searchText: "",
          metrics: null,
        },
      ]),
    ).toThrow();
  });
});
