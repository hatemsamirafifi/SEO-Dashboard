import { describe, expect, it } from "vitest";
import type {
  AutopilotStepKind,
  AutopilotStepStatus,
} from "@/shared/autopilot";
import {
  attemptNote,
  correlationRows,
  parseStepEvidence,
  recommendationCards,
  runStatusLabel,
  shouldPollRun,
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
});
