import { describe, expect, it } from "vitest";
import {
  applyClientFilters,
  EVENT_META,
  eventLabel,
  factorLabel,
  formatDateTime,
  formatMissInfo,
  humanizeKey,
  parseEvidenceJson,
  parseEventReason,
  priorityBadgeClass,
  priorityLabel,
  sourceLabel,
  statusBadgeClass,
  statusLabel,
  toPriorityParam,
  typeLabel,
  OPPORTUNITY_PRIORITIES,
  OPPORTUNITY_STATUSES,
  OPPORTUNITY_TYPES,
  PRIORITY_META,
  STATUS_META,
  toOpportunitiesPageView,
  TYPE_META,
  validateDismissalReason,
  type OpportunityFilterRow,
} from "./opportunitiesCopy";

function row(
  overrides: Partial<OpportunityFilterRow> = {},
): OpportunityFilterRow {
  return {
    type: "ctr",
    priority: "High",
    keyword: "best shoes",
    page: null,
    title: 'Low CTR for "best shoes"',
    logicalKey: "low_ctr_query:best shoes",
    ...overrides,
  };
}

describe("opportunities metadata completeness", () => {
  it("covers every status, type, and priority with labels and badges", () => {
    for (const status of OPPORTUNITY_STATUSES) {
      expect(STATUS_META[status]?.label.length).toBeGreaterThan(0);
      expect(STATUS_META[status]?.badgeClass.startsWith("badge-")).toBe(true);
    }
    for (const type of OPPORTUNITY_TYPES) {
      expect(TYPE_META[type]?.label.length).toBeGreaterThan(0);
    }
    for (const priority of OPPORTUNITY_PRIORITIES) {
      expect(PRIORITY_META[priority]?.label.length).toBeGreaterThan(0);
      expect(PRIORITY_META[priority]?.badgeClass.startsWith("badge-")).toBe(
        true,
      );
    }
  });

  it("labels every lifecycle event type", () => {
    const expected = [
      "detected",
      "redetected",
      "rescored",
      "evidence_updated",
      "status_changed",
      "stale_marked",
      "stale_cleared",
      "completed",
      "dismissed",
      "recurred",
      "superseded",
    ];
    expect(Object.keys(EVENT_META).toSorted()).toEqual(expected.toSorted());
    expect(eventLabel("detected")).toBe("Detected");
    expect(eventLabel("unknown_future_type")).toBe("unknown_future_type");
  });
});

describe("toOpportunitiesPageView", () => {
  it("separates loading, error, empty, filtered-empty, and ok", () => {
    expect(
      toOpportunitiesPageView({
        isPending: true,
        isError: false,
        totalCount: 0,
        filteredCount: 0,
      }),
    ).toEqual({ kind: "loading" });
    expect(
      toOpportunitiesPageView({
        isPending: false,
        isError: true,
        totalCount: 0,
        filteredCount: 0,
      }),
    ).toEqual({ kind: "error" });
    expect(
      toOpportunitiesPageView({
        isPending: false,
        isError: false,
        totalCount: 0,
        filteredCount: 0,
      }),
    ).toEqual({ kind: "empty" });
    expect(
      toOpportunitiesPageView({
        isPending: false,
        isError: false,
        totalCount: 4,
        filteredCount: 0,
      }),
    ).toEqual({ kind: "filtered-empty" });
    expect(
      toOpportunitiesPageView({
        isPending: false,
        isError: false,
        totalCount: 4,
        filteredCount: 2,
      }),
    ).toEqual({ kind: "ok" });
  });
});

describe("applyClientFilters", () => {
  const rows = [
    row(),
    row({
      type: "decay",
      priority: "Medium",
      keyword: null,
      page: "/guide",
      title: "Sustained click decline on /guide",
      logicalKey: "content_decay:/guide",
    }),
    row({
      type: "technical",
      priority: "Critical",
      keyword: null,
      page: "/pricing",
      title: "Critical missing_title on /pricing",
      logicalKey: "technical:missing_title:/pricing",
    }),
  ];

  it("passes everything through on empty search", () => {
    expect(applyClientFilters(rows, { search: "" })).toHaveLength(3);
  });

  it("searches keyword, page, title, and key case-insensitively", () => {
    expect(
      applyClientFilters(rows, { search: "PRICING" }).map((r) => r.logicalKey),
    ).toEqual(["technical:missing_title:/pricing"]);
    expect(
      applyClientFilters(rows, { search: "low_ctr" }).map((r) => r.logicalKey),
    ).toEqual(["low_ctr_query:best shoes"]);
    expect(applyClientFilters(rows, { search: "no such thing" })).toHaveLength(
      0,
    );
  });
});

describe("validateDismissalReason", () => {
  it("requires a non-empty reason under 500 characters", () => {
    expect(validateDismissalReason("")).not.toBeNull();
    expect(validateDismissalReason("   ")).not.toBeNull();
    expect(validateDismissalReason("x".repeat(501))).not.toBeNull();
    expect(validateDismissalReason("Fixed in the new template.")).toBeNull();
  });
});

describe("formatDateTime", () => {
  it("formats ISO timestamps and dashes missing ones", () => {
    expect(formatDateTime("2026-01-05T13:30:00.000Z")).toContain("Jan 5, 2026");
    expect(formatDateTime(null)).toBe("\u2014");
    expect(formatDateTime("not-a-date")).toBe("\u2014");
  });
});

describe("badge-safe lookups", () => {
  it("labels known values and degrades unknown ones neutrally", () => {
    expect(priorityLabel("Critical")).toBe("Critical");
    expect(priorityBadgeClass("Critical")).toContain("badge-error");
    expect(statusLabel("in_progress")).toBe("In progress");
    expect(statusBadgeClass("in_progress")).toContain("badge-warning");
    expect(typeLabel("ctr")).toBe("Low CTR");
    expect(priorityLabel("Future")).toBe("Future");
    expect(priorityBadgeClass("Future")).toContain("badge-ghost");
    expect(statusLabel("Future")).toBe("Future");
    expect(typeLabel("future")).toBe("future");
  });
});

describe("factor labels and key humanization", () => {
  it("labels known factors and prettifies unknown keys", () => {
    expect(factorLabel("trafficPotential")).toBe("Traffic potential");
    expect(factorLabel("mystery")).toBe("mystery");
    expect(humanizeKey("coverageDayRatio")).toBe("Coverage Day Ratio");
    expect(humanizeKey("ctr")).toBe("Ctr");
  });
});

describe("parseEvidenceJson", () => {
  it("parses valid frozen evidence and rejects corrupt shapes", () => {
    const valid = JSON.stringify({
      metrics: { clicks: 10, ratio: 0.5, flag: true },
      periods: { from: "2026-01-01", to: "2026-01-28" },
      sources: ["gsc"],
      thresholdsApplied: { minImpressions: 100 },
      partialData: ["heuristic"],
    });
    expect(parseEvidenceJson(valid)?.metrics.clicks).toBe(10);
    expect(parseEvidenceJson(valid)?.periods?.from).toBe("2026-01-01");
    expect(parseEvidenceJson(valid)?.partialData).toEqual(["heuristic"]);
    expect(parseEvidenceJson(null)).toBeNull();
    expect(parseEvidenceJson("not json")).toBeNull();
    expect(parseEvidenceJson(JSON.stringify({ sources: ["gsc"] }))).toBeNull();
    expect(
      parseEvidenceJson(JSON.stringify({ metrics: {}, sources: [42] })),
    ).toBeNull();
  });

  it("parses source refs including ga4Keys, rejecting malformed refs", () => {
    const withRefs = JSON.stringify({
      metrics: { conversionsBefore: 40 },
      sources: ["ga4"],
      sourceRefs: {
        ga4Keys: ["ga4:properties/123:events:signup:2026-01-01..2026-02-28"],
        gscFactIds: ["fact-1"],
      },
    });
    expect(parseEvidenceJson(withRefs)?.sourceRefs).toEqual({
      ga4Keys: ["ga4:properties/123:events:signup:2026-01-01..2026-02-28"],
      gscFactIds: ["fact-1"],
    });
    const badRefs = JSON.stringify({
      metrics: {},
      sources: ["ga4"],
      sourceRefs: { ga4Keys: [{ nested: "object" }] },
    });
    expect(parseEvidenceJson(badRefs)).toBeNull();
  });
});

describe("parseEventReason", () => {
  it("extracts dismissal reasons and ignores the rest", () => {
    expect(
      parseEventReason(
        JSON.stringify({ from: "open", to: "dismissed", reason: "Done." }),
      ),
    ).toBe("Done.");
    expect(parseEventReason(null)).toBeNull();
    expect(parseEventReason(JSON.stringify({ from: "open" }))).toBeNull();
    expect(parseEventReason("garbage")).toBeNull();
  });
});

describe("formatMissInfo", () => {
  it("narrates misses and staleness, silent when fresh", () => {
    expect(formatMissInfo({ consecutiveMisses: 0, stale: false })).toBeNull();
    expect(formatMissInfo({ consecutiveMisses: 1, stale: false })).toBe(
      "Not seen in the last scan.",
    );
    expect(formatMissInfo({ consecutiveMisses: 2, stale: false })).toBe(
      "Not seen in the last 2 scans.",
    );
    expect(formatMissInfo({ consecutiveMisses: 3, stale: true })).toContain(
      "Stale",
    );
  });
});

describe("spec 010 filter metadata", () => {
  it("labels the GA4-backed types and sources, degrading unknown values", () => {
    expect(typeLabel("ga4_conversion")).toBe("Conversion drop");
    expect(typeLabel("ga4_engagement")).toBe("Engagement drop");
    expect(typeLabel("striking_distance")).toBe("Striking distance");
    expect(typeLabel("future_type")).toBe("future_type");
    expect(sourceLabel("ga4")).toBe("Analytics");
    expect(sourceLabel("gsc")).toBe("Search Console");
    expect(sourceLabel("rank")).toBe("Rank tracking");
    expect(sourceLabel("audit")).toBe("Site audit");
    expect(sourceLabel("backlinks")).toBe("Backlinks");
    expect(sourceLabel("future_source")).toBe("future_source");
  });

  it("narrows priority select values, dropping garbage to unfiltered", () => {
    expect(toPriorityParam("Critical")).toBe("Critical");
    expect(toPriorityParam("Low")).toBe("Low");
    expect(toPriorityParam("critical")).toBeUndefined();
    expect(toPriorityParam("bogus")).toBeUndefined();
    expect(toPriorityParam("")).toBeUndefined();
  });
});
