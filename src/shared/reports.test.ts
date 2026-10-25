import { describe, expect, it } from "vitest";
import {
  consistencyBanner,
  PAID_SEARCH_SECTION_TITLE,
  paidSearchPayloadSchema,
  REPORT_PAYLOAD_VERSION,
  REPORT_TYPES,
  sectionsForReportType,
  type ReportProvenance,
} from "./reports";

function provenance(
  overrides: Partial<ReportProvenance> = {},
): ReportProvenance {
  return {
    consistencyStatus: "consistent",
    metricSourceVersions: "a".repeat(64),
    collectionVersionsBefore: null,
    collectionVersionsAfter: null,
    intelligenceRunId: "run-1",
    intelligenceRunHash: "b".repeat(64),
    intelligenceManifestHash: "c".repeat(64),
    intelligenceCompletedAt: "2026-01-15T00:00:00.000Z",
    hasSuccessfulScan: true,
    intelligenceStale: false,
    generatedAt: "2026-01-15T00:00:00.000Z",
    ...overrides,
  };
}

describe("report type sections", () => {
  it("covers exactly the five plan types over one payload shape", () => {
    expect([...REPORT_TYPES]).toEqual([
      "overview",
      "search_performance",
      "rank_tracking",
      "technical",
      "executive",
    ]);
  });

  it("maps overview to every section", () => {
    expect(sectionsForReportType("overview")).toEqual([
      "search_visibility",
      "traffic",
      "conversions",
      "rankings",
      "technical",
      "backlinks",
      "opportunities",
      "insights",
    ]);
  });

  it("selects focused subsets for the other four types", () => {
    expect(sectionsForReportType("search_performance")).toEqual([
      "search_visibility",
      "insights",
      "opportunities",
    ]);
    expect(sectionsForReportType("rank_tracking")).toEqual([
      "rankings",
      "insights",
      "opportunities",
    ]);
    expect(sectionsForReportType("technical")).toEqual([
      "technical",
      "insights",
      "opportunities",
    ]);
    expect(sectionsForReportType("executive")).toEqual([
      "search_visibility",
      "traffic",
      "opportunities",
      "insights",
    ]);
  });

  it("pins the payload version", () => {
    expect(REPORT_PAYLOAD_VERSION).toBe(1);
  });
});

describe("consistencyBanner", () => {
  it("states stability for consistent runs", () => {
    expect(consistencyBanner(provenance())).toBe(
      "All data sources were stable while this report was collected.",
    );
  });

  it("warns about mixed states on concurrent mutation", () => {
    const banner = consistencyBanner(
      provenance({
        consistencyStatus: "concurrent_mutation",
        metricSourceVersions: null,
        collectionVersionsBefore: "a".repeat(64),
        collectionVersionsAfter: "b".repeat(64),
      }),
    );
    expect(banner).toBe(
      "Some data changed while this report was collected; figures may mix two states.",
    );
  });

  it("records scan absence instead of implying intelligence", () => {
    const banner = consistencyBanner(
      provenance({
        intelligenceRunId: null,
        intelligenceRunHash: null,
        intelligenceManifestHash: null,
        intelligenceCompletedAt: null,
        hasSuccessfulScan: false,
      }),
    );
    expect(banner).toContain("No successful intelligence scan exists yet");
  });

  it("labels stale-but-stable intelligence distinctly", () => {
    const banner = consistencyBanner(
      provenance({
        intelligenceStale: true,
        intelligenceCompletedAt: "2020-05-01T00:00:00.000Z",
      }),
    );
    expect(banner).toContain("Intelligence is stale");
    expect(banner).toContain("2020-05-01T00:00:00.000Z");
  });
});

// Optional, backward-compatible paid-search extension (master plan phase 6).
function paidTotal(
  overrides: Partial<{
    impressions: number | null;
    clicks: number | null;
    cost: number | null;
    conversions: number | null;
    conversionsValue: number | null;
    ctr: number | null;
    cpc: number | null;
    cpa: number | null;
    roas: number | null;
  }> = {},
) {
  return {
    impressions: 1000,
    clicks: 100,
    cost: 50.0,
    conversions: 5,
    conversionsValue: 250,
    ctr: 0.1,
    cpc: 0.5,
    cpa: 10,
    roas: 5,
    ...overrides,
  };
}

describe("paidSearch payload extension", () => {
  function paidEnvelopes() {
    return {
      status: { available: true, reason: null },
      currencyCode: "USD",
      metricDateBasis: "month",
      totals: paidTotal(),
      previousTotals: null,
      deltas: [
        {
          metric: "clicks" as const,
          current: 100,
          previous: 90,
          absoluteChange: 10,
          pctChange: 0.111,
        },
      ],
      campaigns: [
        {
          campaignResourceId: "111",
          name: "Brand",
          status: "ENABLED",
          totals: paidTotal(),
        },
      ],
      searchTerms: [{ searchText: "seo tool", totals: paidTotal() }],
    };
  }

  it("parses a complete paid envelope", () => {
    const envelopes = paidEnvelopes();
    expect(paidSearchPayloadSchema.parse(envelopes)).toMatchObject({
      currencyCode: "USD",
      status: { available: true, reason: null },
    });
  });

  it("keeps a stored payload readable when it predates the extension", () => {
    // The section key is deliberately NOT in REPORT_SECTIONS — the extension
    // rides on optional payload data, not on the section selector lists.
    expect(PAID_SEARCH_SECTION_TITLE).toBe("Paid search (Google Ads)");
    expect(
      sectionsForReportType("overview").some(
        (s) => String(s) === "paid_search",
      ),
    ).toBe(false);
  });

  it("accepts unavailable envelopes without totals", () => {
    const envelopes = {
      status: { available: false, reason: "no_coverage" },
      currencyCode: null,
      metricDateBasis: null,
      totals: null,
      previousTotals: null,
      deltas: [],
      campaigns: [],
      searchTerms: [],
    };
    expect(paidSearchPayloadSchema.parse(envelopes)).toMatchObject({
      totals: null,
      status: { available: false, reason: "no_coverage" },
    });
  });

  it("reports previous totals only when the window was comparable", () => {
    const parsed = paidSearchPayloadSchema.parse({
      ...paidEnvelopes(),
      previousTotals: paidTotal({ conversionsValue: 200, roas: 4 }),
    });
    expect(parsed.previousTotals).toMatchObject({ cost: 50, roas: 4 });
    expect(parsed.previousTotals).not.toBeNull();
  });
});
