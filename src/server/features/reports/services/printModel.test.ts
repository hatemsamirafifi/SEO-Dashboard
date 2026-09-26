import { describe, expect, it } from "vitest";
import {
  reportPayloadSchema,
  type BrandingSnapshot,
  type ReportPayload,
} from "@/shared/reports";
import { buildPrintModel } from "./printModel";

export function payloadFixture(
  overrides: Partial<ReportPayload> = {},
): ReportPayload {
  return reportPayloadSchema.parse({
    version: 1,
    reportType: "overview",
    sections: [
      "search_visibility",
      "traffic",
      "opportunities",
      "insights",
    ],
    period: { from: "2026-01-01", to: "2026-01-14" },
    generatedAt: "2026-01-15T00:00:00.000Z",
    searchVisibility: {
      status: { available: true, reason: null },
      totals: { clicks: 1120, impressions: 14000, ctr: 0.08, position: 5 },
    },
    traffic: {
      status: { available: false, reason: "not_connected" },
      totals: null,
    },
    conversions: {
      status: { available: false, reason: "not_selected" },
      keyEvents: null,
      transactions: null,
    },
    rankings: {
      status: { available: false, reason: "not_selected" },
      trackedKeywords: null,
      improved: null,
      declined: null,
      top10: null,
      lastCheckedAt: null,
    },
    technical: {
      status: { available: false, reason: "not_selected" },
      auditStatus: null,
      pagesCrawled: null,
      topIssues: null,
    },
    backlinks: {
      status: { available: false, reason: "not_selected" },
      referringDomains: null,
      capturedAt: null,
    },
    opportunities: [
      {
        id: "opp-1",
        logicalKey: "ranking_drop:k1",
        type: "ranking",
        status: "open",
        priority: "Critical",
        impactScore: 80,
        confidenceScore: 70,
        title: "Important keywords lost rankings",
        explanationFact: "Observed during the same period.",
        recommendation: "Act soon.",
        completedAt: null,
      },
    ],
    insights: [],
    provenance: {
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
    },
    ...overrides,
  });
}

const BRANDING: BrandingSnapshot = {
  agency: {
    name: "Acme SEO",
    logoR2Key: null,
    accentColor: "#1a2b3c",
    footerText: "Prepared by Acme",
  },
  client: { name: "Client Co", logoR2Key: null, titleOverride: null },
};

describe("buildPrintModel", () => {
  it("freezes titles, banner, provenance, and metric rows", () => {
    const model = buildPrintModel(payloadFixture(), BRANDING);
    expect(model.title).toBe("Overview report");
    expect(model.subtitle).toContain("Acme SEO for Client Co");
    expect(model.subtitle).toContain("2026-01-01 → 2026-01-14");
    expect(model.banner).toBe(
      "All data sources were stable while this report was collected.",
    );
    expect(model.provenanceLines).toHaveLength(2);
    expect(model.footer).toBe("Prepared by Acme");
    const visibility = model.sections.find(
      (section) => section.key === "search_visibility",
    );
    expect(visibility?.metricRows).toEqual([
      { label: "Clicks", value: "1120" },
      { label: "Impressions", value: "14000" },
      { label: "CTR", value: "8.0%" },
      { label: "Avg. position", value: "5.0" },
    ]);
  });

  it("marks unavailable sections without zeros", () => {
    const model = buildPrintModel(payloadFixture(), null);
    expect(model.title).toBe("Overview report");
    expect(model.subtitle.startsWith("OpenSEO")).toBe(true);
    expect(model.footer).toBeNull();
    const traffic = model.sections.find(
      (section) => section.key === "traffic",
    );
    expect(traffic?.metricRows).toEqual([]);
    expect(traffic?.unavailableNote).toContain("Not connected");
  });

  it("notes empty lists and honors title overrides", () => {
    const model = buildPrintModel(
      payloadFixture(),
      {
        agency: null,
        client: {
          name: "Client Co",
          logoR2Key: null,
          titleOverride: "Q1 Review",
        },
      },
    );
    expect(model.title).toBe("Q1 Review");
    const insights = model.sections.find(
      (section) => section.key === "insights",
    );
    expect(insights?.emptyNote).toBe("No insights in this snapshot.");
    const opportunities = model.sections.find(
      (section) => section.key === "opportunities",
    );
    expect(opportunities?.items).toHaveLength(1);
    expect(opportunities?.items[0]?.lead).toBe("Critical / open");
  });
});
