import { describe, expect, it } from "vitest";
import {
  googleAdsAnalyticsWindowSchema,
  googleAdsDeviceBreakdownSchema,
  googleAdsSearchTermBreakdownSchema,
  googleAdsSyncTriggerSchema,
} from "@/types/schemas/google-ads";

describe("googleAdsAnalyticsWindowSchema", () => {
  it("accepts a project id alone and defaults no window", () => {
    const parsed = googleAdsAnalyticsWindowSchema.parse({ projectId: "p1" });
    expect(parsed).toEqual({ projectId: "p1" });
  });

  it("accepts an ordered calendar window", () => {
    const parsed = googleAdsAnalyticsWindowSchema.parse({
      projectId: "p1",
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    });
    expect(parsed).toMatchObject({
      startDate: "2026-01-01",
      endDate: "2026-03-31",
    });
  });

  it("rejects half a window, an unordered window and a non calendar date", () => {
    expect(
      googleAdsAnalyticsWindowSchema.safeParse({
        projectId: "p1",
        startDate: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      googleAdsAnalyticsWindowSchema.safeParse({
        projectId: "p1",
        endDate: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      googleAdsAnalyticsWindowSchema.safeParse({
        projectId: "p1",
        startDate: "2026-03-31",
        endDate: "2026-01-01",
      }).success,
    ).toBe(false);
    expect(
      googleAdsAnalyticsWindowSchema.safeParse({
        projectId: "p1",
        startDate: "2026-02-30",
        endDate: "2026-03-01",
      }).success,
    ).toBe(false);
  });

  it("caps the window at 37 months", () => {
    expect(
      googleAdsAnalyticsWindowSchema.safeParse({
        projectId: "p1",
        startDate: "2022-09-01",
        endDate: "2026-10-24",
      }).success,
    ).toBe(false);
  });
});

describe("googleAdsSyncTriggerSchema", () => {
  it("is the validated optional-window trigger", () => {
    expect(googleAdsSyncTriggerSchema.parse({ projectId: "p1" })).toEqual({
      projectId: "p1",
    });
    expect(
      googleAdsSyncTriggerSchema.safeParse({
        projectId: "p1",
        startDate: "2026-01-01",
        endDate: "2026-01-31",
      }).success,
    ).toBe(true);
    expect(
      googleAdsSyncTriggerSchema.safeParse({
        projectId: "p1",
        startDate: "2026-01-01",
      }).success,
    ).toBe(false);
  });
});

describe("breakdown filter schemas", () => {
  it("rejects providing both the exact and the LIKE search filter", () => {
    const both = googleAdsSearchTermBreakdownSchema.safeParse({
      projectId: "p1",
      searchText: "shoes",
      searchTextLike: "sho",
    });
    expect(both.success).toBe(false);

    const exact = googleAdsSearchTermBreakdownSchema.parse({
      projectId: "p1",
      searchText: "shoes",
    });
    expect(exact.searchText).toBe("shoes");
  });

  it("bounds the filter text and rejects unknown keys", () => {
    expect(
      googleAdsSearchTermBreakdownSchema.safeParse({
        projectId: "p1",
        searchText: "x".repeat(256),
      }).success,
    ).toBe(false);
    expect(
      googleAdsDeviceBreakdownSchema.safeParse({
        projectId: "p1",
        accessToken: "ya29.secret-token",
      }).success,
    ).toBe(false);
  });
});
