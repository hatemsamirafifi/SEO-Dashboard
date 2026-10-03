import { describe, expect, it } from "vitest";
import {
  advanceSchedule,
  deriveNextDueAt,
  reportPeriodFor,
  scheduledForOf,
} from "./cadence";

// TDD (spec 012, T017): FAILS until T020 implements cadence.ts. Fixtures
// encode research.md R2 + data-model.md §4 verbatim: UTC period keys
// (Monday / 1st), late runs target the passed date, missed-multi-period
// yields one catch-up then advance. SC-003 anchor: the 3-month simulation.

describe("cadence derivation (spec 012, US2)", () => {
  it("leaves a future nextDueAt untouched (defensive no-op)", () => {
    const advanced = advanceSchedule(
      "weekly",
      new Date("2026-10-19T00:00:00Z"),
      new Date("2026-10-14T09:00:00Z"),
    );
    expect(advanced.runFor).toBe("2026-10-19");
    expect(advanced.nextDueAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("covers the previous full week/month for a due date", () => {
    expect(reportPeriodFor("weekly", "2026-10-12")).toEqual({
      from: "2026-10-05",
      to: "2026-10-11",
    });
    expect(reportPeriodFor("monthly", "2026-10-01")).toEqual({
      from: "2026-09-01",
      to: "2026-09-30",
    });
    // January due covers December of the prior year.
    expect(reportPeriodFor("monthly", "2027-01-01")).toEqual({
      from: "2026-12-01",
      to: "2026-12-31",
    });
  });

  it("derives next Monday 00:00 UTC for weekly cadence", () => {
    // Wednesday 2026-10-07 → Monday 2026-10-12.
    expect(deriveNextDueAt("weekly", new Date("2026-10-07T12:00:00Z"))).toBe(
      "2026-10-12T00:00:00.000Z",
    );
    // Monday 00:00 exactly → the FOLLOWING Monday (strictly future).
    expect(deriveNextDueAt("weekly", new Date("2026-10-12T00:00:00Z"))).toBe(
      "2026-10-19T00:00:00.000Z",
    );
  });

  it("derives the 1st of next month 00:00 UTC for monthly cadence", () => {
    expect(deriveNextDueAt("monthly", new Date("2026-10-07T12:00:00Z"))).toBe(
      "2026-11-01T00:00:00.000Z",
    );
    // Year boundary: December → January.
    expect(deriveNextDueAt("monthly", new Date("2026-12-15T00:00:00Z"))).toBe(
      "2027-01-01T00:00:00.000Z",
    );
  });

  it("keys scheduledFor by period (Monday / 1st)", () => {
    expect(scheduledForOf("weekly", new Date("2026-10-12T00:00:00Z"))).toBe(
      "2026-10-12",
    );
    // Any instant inside the week keys to its Monday.
    expect(scheduledForOf("weekly", new Date("2026-10-14T18:30:00Z"))).toBe(
      "2026-10-12",
    );
    expect(scheduledForOf("monthly", new Date("2026-10-01T00:00:00Z"))).toBe(
      "2026-10-01",
    );
    expect(scheduledForOf("monthly", new Date("2026-10-28T09:00:00Z"))).toBe(
      "2026-10-01",
    );
  });

  it("runs late for the passed due date, never skipping to the next one", () => {
    // Due Monday 10-12, cron discovers it Wednesday 10-14: the run still
    // targets 10-12, and nextDueAt advances to the following Monday.
    const advanced = advanceSchedule(
      "weekly",
      new Date("2026-10-12T00:00:00Z"),
      new Date("2026-10-14T09:00:00Z"),
    );
    expect(advanced.runFor).toBe("2026-10-12");
    expect(advanced.nextDueAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("catches up once then advances when multiple periods were missed", () => {
    // Due 09-07, discovered 10-14 (5 weekly periods missed): exactly one
    // catch-up (the most recent missed period 10-12), then advance.
    const advanced = advanceSchedule(
      "weekly",
      new Date("2026-09-07T00:00:00Z"),
      new Date("2026-10-14T09:00:00Z"),
    );
    expect(advanced.runFor).toBe("2026-10-12");
    expect(advanced.nextDueAt).toBe("2026-10-19T00:00:00.000Z");
  });

  it("derives the correct keys across a simulated 3-month span (SC-003)", () => {
    // Walk every day from 2026-10-01 to 2026-12-31 for both cadences,
    // advancing a virtual schedule: collect every runFor key. Schedules
    // start on their first real boundary (nextDueAt is always a boundary).
    for (const cadence of ["weekly", "monthly"] as const) {
      const seen = new Set<string>();
      let due = new Date(
        cadence === "weekly" ? "2026-10-05T00:00:00Z" : "2026-10-01T00:00:00Z",
      );
      const end = new Date("2026-12-31T00:00:00Z").getTime();
      let cursor = new Date("2026-10-01T00:00:00Z").getTime();
      const day = 24 * 60 * 60 * 1000;
      while (cursor <= end) {
        if (due.getTime() <= cursor) {
          const advanced = advanceSchedule(cadence, due, new Date(cursor));
          expect(
            seen.has(advanced.runFor),
            `${cadence}: doubled due date ${advanced.runFor}`,
          ).toBe(false);
          seen.add(advanced.runFor);
          due = new Date(advanced.nextDueAt);
        }
        cursor += day;
      }
      // Weekly: Mondays 10-05..12-28 = 13 keys. Monthly: 10-01, 11-01, 12-01.
      expect(seen.size).toBe(cadence === "weekly" ? 13 : 3);
      const sorted = [...seen].toSorted();
      expect(sorted[0]).toBe(
        cadence === "weekly" ? "2026-10-05" : "2026-10-01",
      );
    }
  });
});
