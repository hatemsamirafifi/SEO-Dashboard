import { describe, expect, it } from "vitest";
import {
  availabilityNote,
  consistencyBadgeClass,
  consistencyLabel,
  defaultPeriod,
  formatPeriod,
  REPORT_TYPE_OPTIONS,
  reportTypeLabel,
  SECTION_TITLES,
} from "./reportsCopy";

describe("reports copy", () => {
  it("labels all five report types", () => {
    expect(REPORT_TYPE_OPTIONS.map((option) => option.value)).toEqual([
      "overview",
      "search_performance",
      "rank_tracking",
      "technical",
      "executive",
    ]);
    expect(reportTypeLabel("executive")).toBe("Executive");
    expect(reportTypeLabel("unknown")).toBe("unknown");
  });

  it("titles every section", () => {
    expect(Object.keys(SECTION_TITLES)).toHaveLength(8);
    expect(SECTION_TITLES.opportunities).toBe("Opportunities");
  });

  it("distinguishes consistency states", () => {
    expect(consistencyLabel("consistent")).toBe("Stable data");
    expect(consistencyLabel("concurrent_mutation")).toContain("changed");
    expect(consistencyBadgeClass("concurrent_mutation")).toContain(
      "badge-warning",
    );
    expect(consistencyBadgeClass("consistent")).toContain("badge-success");
  });

  it("explains unavailable sections without zeros", () => {
    expect(availabilityNote("not_connected")).toContain("Not connected");
    expect(availabilityNote("no_coverage")).toContain("No coverage");
    expect(availabilityNote("provider_failed")).toContain("unavailable");
    expect(availabilityNote("no_data")).toContain("No data yet");
    expect(availabilityNote(null)).toBeNull();
    expect(availabilityNote("not_selected")).toBeNull();
  });

  it("formats periods and defaults to 28 days", () => {
    expect(formatPeriod({ from: "2026-01-01", to: "2026-01-14" })).toBe(
      "2026-01-01 → 2026-01-14",
    );
    const period = defaultPeriod();
    expect(period.from <= period.to).toBe(true);
  });
});
