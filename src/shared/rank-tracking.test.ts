import { afterEach, describe, expect, it, vi } from "vitest";
import {
  computeNextCheckAt,
  parseUtcTimestampMs,
  resolveEligibleNextCheckAt,
  scheduleLabel,
} from "./rank-tracking";

describe("rank tracking schedules", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("labels monthly schedules", () => {
    expect(scheduleLabel("monthly")).toBe("Monthly");
  });

  it("schedules new monthly configs for the end of the current month", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-15T12:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-01-31T04:00:00.000Z");
  });

  it("moves new monthly configs to next month when this month's run time has passed", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-01-31T10:00:00.000Z"));
    vi.spyOn(Math, "random").mockReturnValueOnce(0).mockReturnValueOnce(0);

    expect(computeNextCheckAt("monthly")).toBe("2026-02-28T04:00:00.000Z");
  });

  it("advances monthly schedules on month end across shorter months", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-02-01T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-02-28T05:30:00.000Z",
    );
  });

  it("keeps advancing monthly schedules until the next check is in the future", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-03-10T00:00:00.000Z"));

    expect(computeNextCheckAt("monthly", "2026-01-31T05:30:00.000Z")).toBe(
      "2026-03-31T05:30:00.000Z",
    );
  });

  it("parses SQLite space-delimited timestamps as UTC regardless of host timezone", () => {
    expect(parseUtcTimestampMs("2026-11-14 15:13:20")).toBe(
      Date.parse("2026-11-14T15:13:20.000Z"),
    );
    expect(parseUtcTimestampMs("2026-11-14T15:13:20")).toBe(
      Date.parse("2026-11-14T15:13:20.000Z"),
    );
    expect(parseUtcTimestampMs("2026-11-14T15:13:20.578Z")).toBe(
      Date.parse("2026-11-14T15:13:20.578Z"),
    );
  });

  it("resolves eligible weekly nextCheckAt past 6-day scheduled spacing without letting manual runs shift it", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-11-14T16:00:00.000Z"));

    // No scheduled run yet -> keeps configured weekly anchor even after a manual import on Nov 14
    expect(
      resolveEligibleNextCheckAt({
        scheduleInterval: "weekly",
        isActive: true,
        nextCheckAt: "2026-11-18T07:24:00.000Z",
        lastScheduledAt: null,
      }),
    ).toBe("2026-11-18T07:24:00.000Z");

    // Scheduled run on Nov 14 -> Nov 18 violates 6-day minimum (Nov 20), so next eligible is Nov 25
    expect(
      resolveEligibleNextCheckAt({
        scheduleInterval: "weekly",
        isActive: true,
        nextCheckAt: "2026-11-18T07:24:00.000Z",
        lastScheduledAt: "2026-11-14 15:13:20",
      }),
    ).toBe("2026-11-25T07:24:00.000Z");
  });
});
