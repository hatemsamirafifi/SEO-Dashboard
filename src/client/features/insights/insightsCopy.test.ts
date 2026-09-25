import { describe, expect, it } from "vitest";
import {
  groupInsightsBySection,
  INSIGHT_SEVERITIES,
  INSIGHT_SECTIONS,
  sectionForDetector,
  SECTION_META,
  severityBadgeClass,
  severityLabel,
  SEVERITY_META,
  snoozeWeekFrom,
  type SectionInsightRow,
} from "./insightsCopy";

function row(overrides: Partial<SectionInsightRow> = {}): SectionInsightRow {
  return {
    id: "ins-1",
    insightKey: "dashboard:ranking_drop",
    detectorKey: "ranking_drop",
    severity: "high",
    detectedAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

describe("insight sections", () => {
  it("maps every detector family to a section", () => {
    const detectors = [
      "organic_traffic_change",
      "ga4_organic_change",
      "ranking_drop",
      "low_ctr_query",
      "cannibalization",
      "content_decay",
      "technical_on_important_page",
      "backlink_change",
    ];
    for (const detectorKey of detectors) {
      expect(sectionForDetector(detectorKey)).not.toBeNull();
    }
    expect(sectionForDetector("future_detector")).toBeNull();
    expect(sectionForDetector("organic_traffic_change")).toBe(
      "seo-performance",
    );
    expect(sectionForDetector("content_decay")).toBe("traffic-engagement");
  });

  it("describes every section and severity", () => {
    for (const section of INSIGHT_SECTIONS) {
      expect(SECTION_META[section]?.title.length).toBeGreaterThan(0);
    }
    for (const severity of INSIGHT_SEVERITIES) {
      expect(SEVERITY_META[severity]?.label.length).toBeGreaterThan(0);
      expect(SEVERITY_META[severity]?.badgeClass.startsWith("badge-")).toBe(
        true,
      );
    }
    expect(severityLabel("critical")).toBe("Critical");
    expect(severityBadgeClass("critical")).toContain("badge-error");
    expect(severityLabel("future")).toBe("future");
    expect(severityBadgeClass("future")).toContain("badge-ghost");
  });

  it("groups by family and orders recent changes by detection time", () => {
    const grouped = groupInsightsBySection([
      row(),
      row({
        id: "ins-2",
        insightKey: "dashboard:low_ctr_query",
        detectorKey: "low_ctr_query",
        detectedAt: "2026-01-05T00:00:00.000Z",
      }),
      row({
        id: "ins-3",
        insightKey: "dashboard:future_x",
        detectorKey: "future_detector",
        detectedAt: "2026-01-01T00:00:00.000Z",
      }),
    ]);
    expect(grouped["search-visibility"].map((r) => r.id)).toEqual([
      "ins-1",
      "ins-2",
    ]);
    expect(grouped["seo-performance"]).toEqual([]);
    // Unmapped families still surface in recent-changes, newest first.
    expect(grouped["recent-changes"].map((r) => r.id)).toEqual([
      "ins-2",
      "ins-1",
      "ins-3",
    ]);
  });

  it("computes a 7-day snooze target", () => {
    const target = snoozeWeekFrom(Date.parse("2026-01-01T00:00:00.000Z"));
    expect(target).toBe("2026-01-08T00:00:00.000Z");
  });
});
