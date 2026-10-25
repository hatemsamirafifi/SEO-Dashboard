import { describe, expect, it } from "vitest";
import {
  compareGateCopy,
  coverageCopy,
  formatAdsCurrency,
  formatCount,
  formatDelta,
  formatPctChange,
  formatPercentRatio,
  formatRoas,
  googleAdsSyncFailureKind,
  isGoogleAdsSyncFresh,
  resolveGoogleAdsWindow,
  staleBannerCopy,
  toGoogleAdsPageView,
  type GoogleAdsPageViewInput,
} from "./googleAdsCopy";

describe("resolveGoogleAdsWindow", () => {
  it("resolves an inclusive last-N-days window", () => {
    const window = resolveGoogleAdsWindow({
      preset: "last_7_days",
      today: "2026-10-15",
    });
    expect(window).toEqual({ startDate: "2026-10-09", endDate: "2026-10-15" });
  });

  it("resolves the 28-day default window", () => {
    const window = resolveGoogleAdsWindow({
      preset: "last_28_days",
      today: "2026-10-15",
    });
    expect(window).toEqual({ startDate: "2026-09-18", endDate: "2026-10-15" });
  });

  it("honors a valid custom window", () => {
    const window = resolveGoogleAdsWindow({
      preset: "custom",
      startDate: "2026-09-01",
      endDate: "2026-09-30",
      today: "2026-10-15",
    });
    expect(window).toEqual({ startDate: "2026-09-01", endDate: "2026-09-30" });
  });

  it("falls back to the 28-day window for an invalid custom range", () => {
    const window = resolveGoogleAdsWindow({
      preset: "custom",
      startDate: "2026-09-30",
      endDate: "2026-09-01",
      today: "2026-10-15",
    });
    expect(window).toEqual({ startDate: "2026-09-18", endDate: "2026-10-15" });
  });
});

describe("formatting", () => {
  it("renders missing numbers as an em dash, never as zero", () => {
    expect(formatAdsCurrency(null, "USD")).toBe("\u2014");
    expect(formatCount(null)).toBe("\u2014");
    expect(formatPercentRatio(null)).toBe("\u2014");
    expect(formatRoas(null)).toBe("\u2014");
    expect(formatPctChange(null)).toBe("\u2014");
    expect(formatDelta(null)).toBe("\u2014");
  });

  it("formats amounts with the account currency", () => {
    expect(formatAdsCurrency(6120.45, "USD")).toBe("$6,120.45");
    expect(formatAdsCurrency(6120.45, null)).toBe("6120.45");
    expect(formatAdsCurrency(6120.45, "nope!")).toBe("6120.45");
  });

  it("signs ratios and deltas explicitly", () => {
    expect(formatPercentRatio(0.0669)).toBe("6.69%");
    expect(formatPctChange(5.25)).toBe("+5.3%");
    expect(formatPctChange(-12.34)).toBe("-12.3%");
    expect(formatDelta(-309.85, (v) => `$${v.toFixed(2)}`)).toBe("-$309.85");
    expect(formatDelta(0)).toBe("0");
  });
});

describe("googleAdsSyncFailureKind", () => {
  it("classifies quota, permission and generic sync failures", () => {
    expect(googleAdsSyncFailureKind("QUOTA_EXHAUSTED", null)).toBe(
      "quota-failed",
    );
    expect(googleAdsSyncFailureKind("PERMISSION_DENIED", "no access")).toBe(
      "perm-failed",
    );
    expect(googleAdsSyncFailureKind("HTTP_500", "backend blew up")).toBe(
      "sync-failed",
    );
  });

  it("returns null when the run has no failure information", () => {
    expect(googleAdsSyncFailureKind(null, null)).toBeNull();
  });
});

describe("isGoogleAdsSyncFresh", () => {
  const now = Date.parse("2026-10-15T12:00:00Z");
  it("is fresh within 48 hours", () => {
    expect(isGoogleAdsSyncFresh("2026-10-15T00:00:00Z", now)).toBe(true);
  });
  it("is stale after 48 hours or with no timestamp", () => {
    expect(isGoogleAdsSyncFresh("2026-10-13T00:00:00Z", now)).toBe(false);
    expect(isGoogleAdsSyncFresh(null, now)).toBe(false);
  });
});

function baseInput(
  overrides: Partial<GoogleAdsPageViewInput>,
): GoogleAdsPageViewInput {
  return {
    connectionLoading: false,
    connectionError: false,
    connected: true,
    activeRun: false,
    latestRun: null,
    unitsFailed: 0,
    coverageStatus: "covered",
    coveredThrough: null,
    rowCount: 0,
    ...overrides,
  };
}

describe("toGoogleAdsPageView", () => {
  const okInput = baseInput({
    coverageStatus: "covered",
    latestRun: {
      status: "success",
      errorClass: null,
      errorMessage: null,
      completedAt: new Date().toISOString(),
    },
  });

  it("ranks loading, errors and disconnection first", () => {
    expect(
      toGoogleAdsPageView(baseInput({ connectionLoading: true })).kind,
    ).toBe("loading");
    expect(toGoogleAdsPageView(baseInput({ connectionError: true })).kind).toBe(
      "error",
    );
    expect(toGoogleAdsPageView(baseInput({ connected: false })).kind).toBe(
      "not-connected",
    );
  });

  it("classifies the last run's failure classes distinctly", () => {
    const quota = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "covered",
        latestRun: {
          status: "failed",
          errorClass: "QUOTA_TEMPORARILY_EXHAUSTED",
          errorMessage: "too many requests",
          completedAt: null,
        },
      }),
    );
    expect(quota.kind).toBe("quota-failed");

    const perm = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "covered",
        latestRun: {
          status: "failed",
          errorClass: "PERMISSION_DENIED",
          errorMessage: null,
          completedAt: null,
        },
      }),
    );
    expect(perm.kind).toBe("perm-failed");

    const generic = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "covered",
        latestRun: {
          status: "failed",
          errorClass: "HTTP_500",
          errorMessage: "boom",
          completedAt: null,
        },
      }),
    );
    expect(generic.kind).toBe("sync-failed");
  });

  it("never presents uncovered windows as zero data", () => {
    expect(
      toGoogleAdsPageView(baseInput({ coverageStatus: "none" })).kind,
    ).toBe("no-data");
    expect(
      toGoogleAdsPageView(baseInput({ coverageStatus: "uncovered" })).kind,
    ).toBe("no-data");
    expect(
      toGoogleAdsPageView(
        baseInput({ coverageStatus: "covered-empty", rowCount: 0 }),
      ).kind,
    ).toBe("no-data");
  });

  it("returns partial state with its covered-through date", () => {
    const view = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "partial",
        coveredThrough: "2026-10-10",
        rowCount: 5,
      }),
    );
    expect(view).toMatchObject({
      kind: "partial",
      coveredThrough: "2026-10-10",
    });
  });

  it("marks old syncs and failed units as stale", () => {
    const stale = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "covered",
        rowCount: 12,
        latestRun: {
          status: "success",
          errorClass: null,
          errorMessage: null,
          completedAt: "2020-01-01T00:00:00Z",
        },
      }),
    );
    expect(stale).toMatchObject({ kind: "stale", reason: "old-sync" });

    const failedUnits = toGoogleAdsPageView(
      baseInput({
        coverageStatus: "covered",
        rowCount: 12,
        unitsFailed: 2,
        latestRun: {
          status: "partial",
          errorClass: null,
          errorMessage: null,
          completedAt: new Date().toISOString(),
        },
      }),
    );
    expect(failedUnits).toMatchObject({
      kind: "stale",
      reason: "failed-units",
    });
  });

  it("reaches the ok state only for complete covered data", () => {
    expect(toGoogleAdsPageView(okInput).kind).toBe("ok");
  });
});

describe("copy helpers", () => {
  it("labels every coverage status", () => {
    expect(coverageCopy("covered").label).toBe("Complete");
    expect(coverageCopy("covered-empty").tone).toBe("success");
    expect(coverageCopy("partial").tone).toBe("warning");
    expect(coverageCopy("uncovered").tone).toBe("error");
  });

  it("returns null copy only for the ready gate", () => {
    expect(compareGateCopy("ready")).toBeNull();
    for (const gate of [
      "unequal_windows",
      "partial_coverage",
      "mixed_metric_date_basis",
    ] as const) {
      expect(compareGateCopy(gate)).toContain("unavailable");
    }
  });

  it("explains both staleness reasons", () => {
    expect(
      staleBannerCopy({ reason: "failed-units", lastCompletedAt: null }),
    ).toContain("failed");
    expect(
      staleBannerCopy({
        reason: "old-sync",
        lastCompletedAt: "2026-10-10T00:00:00Z",
      }),
    ).toContain("48 hours");
  });
});
