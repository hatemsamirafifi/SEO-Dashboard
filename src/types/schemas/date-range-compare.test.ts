import { describe, expect, it } from "vitest";
import {
  daysBetweenIso,
  resolveDateWindows,
  subtractYearIso,
} from "./date-range-compare";

describe("date-range-compare helpers", () => {
  const TODAY = "2026-10-14";

  it("resolves preset last_7_days without compare", () => {
    const res = resolveDateWindows({ dateRange: "last_7_days" }, TODAY);
    expect(res.current).toEqual({
      startDate: "2026-10-08",
      endDate: "2026-10-14",
    });
    expect(res.compare).toBeUndefined();
  });

  it("resolves preset last_28_days with previous_period compare", () => {
    const res = resolveDateWindows(
      { dateRange: "last_28_days", compareMode: "previous_period" },
      TODAY,
    );
    expect(res.current).toEqual({
      startDate: "2026-09-17",
      endDate: "2026-10-14",
    });
    expect(res.compare).toEqual({
      startDate: "2026-08-20",
      endDate: "2026-09-16",
    });
    expect(daysBetweenIso(res.current.startDate, res.current.endDate)).toBe(28);
    expect(daysBetweenIso(res.compare!.startDate, res.compare!.endDate)).toBe(
      28,
    );
  });

  it("resolves year over year compare", () => {
    const res = resolveDateWindows(
      {
        dateRange: "custom",
        startDate: "2026-06-01",
        endDate: "2026-06-30",
        compareMode: "previous_year",
      },
      TODAY,
    );
    expect(res.current).toEqual({
      startDate: "2026-06-01",
      endDate: "2026-06-30",
    });
    expect(res.compare).toEqual({
      startDate: "2025-06-01",
      endDate: "2025-06-30",
    });
  });

  it("resolves custom date range with custom compare dates", () => {
    const res = resolveDateWindows(
      {
        dateRange: "custom",
        startDate: "2026-09-01",
        endDate: "2026-09-15",
        compareMode: "custom",
        compareStartDate: "2026-08-01",
        compareEndDate: "2026-08-15",
      },
      TODAY,
    );
    expect(res.current).toEqual({
      startDate: "2026-09-01",
      endDate: "2026-09-15",
    });
    expect(res.compare).toEqual({
      startDate: "2026-08-01",
      endDate: "2026-08-15",
    });
  });

  it("handles leap year subtraction cleanly", () => {
    expect(subtractYearIso("2024-02-29")).toBe("2023-02-28");
    expect(subtractYearIso("2025-01-15")).toBe("2024-01-15");
  });
});
