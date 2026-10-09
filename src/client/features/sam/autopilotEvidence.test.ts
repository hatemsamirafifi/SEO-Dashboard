import { describe, expect, it } from "vitest";
import type {
  AutopilotStepKind,
  AutopilotStepStatus,
} from "@/shared/autopilot";
import {
  attemptNote,
  correlationRows,
  monthlySummary,
  parseStepEvidence,
  recommendationCards,
  runStatusLabel,
  shouldPollRun,
  technicalFacts,
  type AutopilotStepLike,
} from "./autopilotEvidence";

function step(
  seq: number,
  evidence: Record<string, unknown> | null,
  status: AutopilotStepStatus = "completed",
): AutopilotStepLike {
  const kind: AutopilotStepKind =
    seq === 2 ? "synthesize" : seq === 1 ? "correlate" : "collect";
  return {
    seq,
    kind,
    name: `step-${seq}`,
    status,
    evidenceJson: evidence ? JSON.stringify(evidence) : null,
  };
}

describe("autopilotEvidence", () => {
  it("parses step evidence with corrupt JSON tolerated", () => {
    expect(parseStepEvidence(null)).toEqual({});
    expect(parseStepEvidence("{not json")).toEqual({});
    expect(parseStepEvidence(JSON.stringify({ a: 1 }))["a"]).toBe(1);
  });

  it("collects recommendation cards newest-first with confidence", () => {
    const cards = recommendationCards([
      step(0, { collectedAt: "2026-09-25" }),
      step(1, { rankedIds: ["a"] }),
      step(2, {
        recommendations: [
          {
            suggestedAction: "Inspect /pricing in analytics",
            reasoningSummary:
              "/pricing decreased during the same period as overlapping signals",
            confidence: { value: 65, why: "overlap across signals" },
            dataSource: "opportunity:opp-1",
          },
        ],
      }),
    ]);
    expect(cards).toHaveLength(1);
    expect(cards[0]?.confidenceValue).toBe(65);
    expect(cards[0]?.dataSource).toBe("opportunity:opp-1");
  });

  it("reads correlation rows with signal counts", () => {
    const rows = correlationRows([
      step(2, {
        correlationTable: [
          {
            entity: "/pricing",
            agreement: "corroborated",
            opportunityIds: ["a", "b"],
          },
          {
            entity: "/blog",
            agreement: "single_source",
            opportunityIds: ["c"],
          },
        ],
      }),
    ]);
    expect(rows).toEqual([
      { entity: "/pricing", agreement: "corroborated", signals: 2 },
      { entity: "/blog", agreement: "single_source", signals: 1 },
    ]);
  });

  it("labels attempts and run states distinctly", () => {
    expect(
      attemptNote({
        id: "a",
        attemptNumber: 1,
        status: "invalidated",
        invalidationReason: "SOURCE_CHANGED",
      }),
    ).toContain("set aside");
    expect(runStatusLabel("running")).toBe("Running");
    expect(runStatusLabel("pending")).toBe("Queued");
    expect(runStatusLabel("cancelled")).toBe("Cancelled");
    expect(shouldPollRun("running")).toBe(true);
    expect(shouldPollRun("completed")).toBe(false);
  });

  // Spec 013 (US4 T025): evidence renderers for the new workflow shapes.
  it("reads technical-SEO facts apart from recommendations", () => {
    const facts = technicalFacts([
      step(2, {
        facts: {
          auditCoverage: { state: "ready", auditId: "a1", pagesCrawled: 42 },
          rankedIssues: [
            { severity: "critical", type: "noindex-important", count: 2 },
          ],
        },
        recommendations: [
          {
            suggestedAction: "Inspect noindex-important findings",
            reasoningSummary: "2 pages observed in the latest stored audit",
            confidence: { value: 70, why: "stored severity critical" },
            dataSource: "audit:a1:noindex-important",
          },
        ],
      }),
    ]);
    expect(facts?.coverageState).toBe("ready");
    expect(facts?.rankedIssues).toEqual([
      { severity: "critical", type: "noindex-important", count: 2 },
    ]);
    // Recommendations still flow through the shared cards reader.
    expect(
      recommendationCards([
        step(2, {
          recommendations: [
            {
              suggestedAction: "Run a site audit first",
              reasoningSummary: "No audit evidence in stored state",
              confidence: { value: 80, why: "observed absence" },
              dataSource: "audit:coverage",
            },
          ],
        }),
      ]),
    ).toHaveLength(1);
    expect(technicalFacts([step(2, null)])).toBeNull();
    expect(technicalFacts([step(2, { facts: null })])).toBeNull();
  });

  it("reads monthly-review sections with honest unavailable reasons", () => {
    const summary = monthlySummary([
      step(2, {
        summary: {
          changed: [
            {
              source: "gsc",
              metric: "clicks",
              monthValue: 1000,
              priorValue: 1200,
              delta: -200,
              agreement: "corroborated",
            },
            {
              source: "ga4",
              metric: "pageViews",
              monthValue: 11000,
              priorValue: 11000,
              delta: 0,
              agreement: "single_source",
            },
          ],
          ratios: [{ metric: "ctr", monthValue: 0.02, priorValue: 0.025 }],
          unavailable: [{ source: "ga4", reason: "no_coverage (prior window)" }],
          unresolved: [
            { kind: "opportunity", label: "High", title: "Pricing lost rank" },
          ],
          nextActions: [
            {
              suggestedAction: "Review Pricing lost rank",
              reasoningSummary: "remains High and unresolved",
              confidence: { value: 68, why: "stored confidence" },
              dataSource: "opportunity:ranking_drop:/pricing",
            },
          ],
        },
      }),
    ]);
    expect(summary?.changed).toHaveLength(2);
    expect(
      summary?.changed.find((row) => row.metric === "pageViews")?.agreement,
    ).toBe("single_source");
    expect(summary?.ratios).toEqual([
      { metric: "ctr", monthValue: 0.02, priorValue: 0.025 },
    ]);
    // Unavailable reasons render verbatim — never zeros.
    expect(summary?.unavailable).toEqual([
      { source: "ga4", reason: "no_coverage (prior window)" },
    ]);
    expect(summary?.nextActionCount).toBe(1);
    expect(monthlySummary([step(2, null)])).toBeNull();
    expect(monthlySummary([step(2, { summary: null })])).toBeNull();
  });
});
