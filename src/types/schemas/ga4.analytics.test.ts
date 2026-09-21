import { describe, expect, it } from "vitest";
import {
  ANALYTICS_RANGES,
  analyticsAcquisitionSchema,
  analyticsLandingPagesSchema,
  analyticsOverviewSchema,
} from "./ga4";

describe("analytics range filter schemas", () => {
  it("exposes exactly the 7/28/30/90d ranges", () => {
    expect([...ANALYTICS_RANGES]).toEqual([
      "last_7_days",
      "last_28_days",
      "last_30_days",
      "last_90_days",
    ]);
  });

  it("accepts every range and defaults to last_28_days", () => {
    for (const range of ANALYTICS_RANGES) {
      expect(
        analyticsOverviewSchema.parse({ projectId: "p1", range }),
      ).toMatchObject({ projectId: "p1", range });
    }
    expect(analyticsOverviewSchema.parse({ projectId: "p1" })).toMatchObject({
      range: "last_28_days",
    });
  });

  it("rejects unknown ranges", () => {
    for (const range of ["last_7d", "custom", "last_12_months", ""]) {
      expect(
        analyticsOverviewSchema.safeParse({ projectId: "p1", range }).success,
      ).toBe(false);
    }
  });

  it("is strict: unknown keys are rejected on all three schemas", () => {
    const payload = { projectId: "p1", range: "last_7_days", bogus: true };
    expect(analyticsOverviewSchema.safeParse(payload).success).toBe(false);
    expect(analyticsAcquisitionSchema.safeParse(payload).success).toBe(false);
    expect(analyticsLandingPagesSchema.safeParse(payload).success).toBe(false);
  });

  it("accepts optional channel/device/country filters", () => {
    const parsed = analyticsOverviewSchema.parse({
      projectId: "p1",
      range: "last_7_days",
      channel: "Organic Search",
      device: "mobile",
      country: "United States",
    });
    expect(parsed).toMatchObject({
      channel: "Organic Search",
      device: "mobile",
      country: "United States",
    });
  });

  it("rejects unknown device values", () => {
    expect(
      analyticsOverviewSchema.safeParse({
        projectId: "p1",
        device: "smartwatch",
      }).success,
    ).toBe(false);
  });

  it("requires projectId", () => {
    expect(
      analyticsOverviewSchema.safeParse({ range: "last_7_days" }).success,
    ).toBe(false);
  });

  it("landing schema defaults limit to 25 and bounds it 1..100", () => {
    expect(
      analyticsLandingPagesSchema.parse({ projectId: "p1" }),
    ).toMatchObject({ limit: 25 });
    expect(
      analyticsLandingPagesSchema.parse({ projectId: "p1", limit: 100 }),
    ).toMatchObject({ limit: 100 });
    expect(
      analyticsLandingPagesSchema.safeParse({ projectId: "p1", limit: 0 })
        .success,
    ).toBe(false);
    expect(
      analyticsLandingPagesSchema.safeParse({ projectId: "p1", limit: 101 })
        .success,
    ).toBe(false);
  });

  it("landing schema coerces string limits from router search params", () => {
    // TanStack router search params arrive as strings; the wire contract is
    // string-in/number-out (domain/backlinks precedent for numeric params).
    expect(
      analyticsLandingPagesSchema.parse({ projectId: "p1", limit: "10" }),
    ).toMatchObject({ limit: 10 });
    expect(
      analyticsLandingPagesSchema.safeParse({ projectId: "p1", limit: "many" })
        .success,
    ).toBe(false);
  });

  it("acquisition and landing share the overview range contract", () => {
    for (const schema of [
      analyticsAcquisitionSchema,
      analyticsLandingPagesSchema,
    ]) {
      expect(schema.parse({ projectId: "p1" })).toMatchObject({
        range: "last_28_days",
      });
      expect(
        schema.safeParse({ projectId: "p1", range: "last_12_months" }).success,
      ).toBe(false);
    }
  });
});
