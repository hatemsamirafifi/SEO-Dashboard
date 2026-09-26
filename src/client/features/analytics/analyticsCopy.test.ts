import { describe, expect, it } from "vitest";
import {
  ANALYTICS_RANGE_OPTIONS,
  coverageBadge,
  formatDelta,
  formatPctChange,
  syncFailureKind,
  toAnalyticsPageView,
} from "./analyticsCopy";

describe("analytics page copy helpers", () => {
  it("formats percent changes with sign and one decimal", () => {
    expect(formatPctChange(12.345)).toBe("+12.3%");
    expect(formatPctChange(-4)).toBe("-4.0%");
    expect(formatPctChange(0)).toBe("+0.0%");
  });

  it("renders an em dash when there is no baseline", () => {
    expect(formatPctChange(null)).toBe("\u2014");
  });

  it("formats absolute deltas with sign", () => {
    expect(formatDelta(12)).toBe("+12");
    expect(formatDelta(-3)).toBe("-3");
    expect(formatDelta(0)).toBe("0");
  });

  it("classifies sync failures by error class", () => {
    expect(syncFailureKind("QUOTA_EXHAUSTED: slow down")).toBe("quota-failed");
    expect(syncFailureKind("OAUTH_TOKEN_FAILURE: reconnect")).toBe(
      "perm-failed",
    );
    expect(syncFailureKind("PERMISSION_DENIED: no access")).toBe("perm-failed");
    expect(syncFailureKind("PROPERTY_NOT_FOUND: gone")).toBe("perm-failed");
    expect(syncFailureKind("HTTP_ERROR_500: boom")).toBe("sync-failed");
    expect(syncFailureKind(null)).toBe(null);
  });

  it("folds loading before every other state", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: true,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: false,
        isRunning: false,
        latestSyncError: null,
        coverageStatus: "none",
        hasRows: false,
      }),
    ).toEqual({ kind: "loading" });
  });

  it("folds query errors before connection state", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: true,
        syncError: false,
        connected: true,
        isRunning: false,
        latestSyncError: null,
        coverageStatus: "complete",
        hasRows: true,
      }).kind,
    ).toBe("error");
  });

  it("shows not-connected before sync and data states", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: false,
        isRunning: false,
        latestSyncError: "QUOTA_EXHAUSTED: slow",
        coverageStatus: "complete",
        hasRows: true,
      }).kind,
    ).toBe("not-connected");
  });

  it("shows syncing before failure and data states", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: true,
        isRunning: true,
        latestSyncError: "HTTP_ERROR_500: boom",
        coverageStatus: "complete",
        hasRows: true,
      }).kind,
    ).toBe("syncing");
  });

  it("surfaces classified sync failures with their message", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: true,
        isRunning: false,
        latestSyncError: "QUOTA_EXHAUSTED: slow down",
        coverageStatus: "complete",
        hasRows: true,
      }),
    ).toEqual({
      kind: "quota-failed",
      message: "QUOTA_EXHAUSTED: slow down",
    });
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: true,
        isRunning: false,
        latestSyncError: "PERMISSION_DENIED: no access",
        coverageStatus: "complete",
        hasRows: true,
      }).kind,
    ).toBe("perm-failed");
  });

  it("shows no-data when coverage is empty or rows are absent", () => {
    const base = {
      connectionLoading: false,
      syncLoading: false,
      connectionError: false,
      syncError: false,
      connected: true,
      isRunning: false,
      latestSyncError: null,
      hasRows: true,
    };
    expect(
      toAnalyticsPageView({ ...base, coverageStatus: "none", hasRows: true })
        .kind,
    ).toBe("no-data");
    expect(
      toAnalyticsPageView({
        ...base,
        coverageStatus: "complete",
        hasRows: false,
      }).kind,
    ).toBe("no-data");
  });

  it("shows partial with the covered-through date", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: true,
        isRunning: false,
        latestSyncError: null,
        coverageStatus: "partial",
        hasRows: true,
        coveredThrough: "2026-09-10",
      }),
    ).toEqual({ kind: "partial", coveredThrough: "2026-09-10" });
  });

  it("reaches ok only with complete coverage and rows", () => {
    expect(
      toAnalyticsPageView({
        connectionLoading: false,
        syncLoading: false,
        connectionError: false,
        syncError: false,
        connected: true,
        isRunning: false,
        latestSyncError: null,
        coverageStatus: "complete",
        hasRows: true,
      }),
    ).toEqual({ kind: "ok" });
  });

  it("badges coverage without inventing data", () => {
    expect(coverageBadge({ status: "complete", coveredThrough: null })).toBe(
      "Complete",
    );
    expect(
      coverageBadge({ status: "partial", coveredThrough: "2026-09-10" }),
    ).toBe("Partial data through 2026-09-10");
    expect(coverageBadge({ status: "none", coveredThrough: null })).toBe(
      "No coverage",
    );
  });

  it("exposes one option per analytics range", () => {
    expect(ANALYTICS_RANGE_OPTIONS.map((option) => option.value)).toEqual([
      "last_7_days",
      "last_28_days",
      "last_30_days",
      "last_90_days",
    ]);
  });
});
