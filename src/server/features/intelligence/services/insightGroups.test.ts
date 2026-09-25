import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("grouping tests must not touch the database");
      },
    },
  ),
}));

import type { Finding } from "@/shared/intelligence";
import {
  groupFindings,
  importanceOf,
  jaccard,
  severityOfConfidence,
} from "./insightGroups";

function finding(
  detectorKey: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    findingKey: `${detectorKey}-key`.padEnd(64, "0"),
    detectorKey,
    detectorVersion: 1,
    projectId: "project-1",
    entityKey: "entity-1",
    entity: {},
    explanationFact: "Observed during the same period.",
    evidence: {
      metrics: { clicks: 100 },
      periods: { from: "2026-01-01", to: "2026-01-28" },
      sources: ["gsc"],
      thresholdsApplied: {},
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: {},
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 70,
    coverageFlags: {},
    ...overrides,
  };
}

describe("importanceOf / severityOfConfidence / jaccard", () => {
  it("takes the max volume metric and bands confidence", () => {
    expect(
      importanceOf(
        finding("low_ctr_query", {
          evidence: {
            metrics: { impressions: 5000, clicks: 20, position: 8.5 },
            sources: ["gsc"],
            thresholdsApplied: {},
            correlations: [],
            evidenceType: "observational",
            partialData: [],
            confidenceInputs: {},
          },
        }),
      ),
    ).toBe(5000);
    expect(importanceOf(finding("low_ctr_query"))).toBe(100);
    expect(severityOfConfidence(90)).toBe("critical");
    expect(severityOfConfidence(70)).toBe("high");
    expect(severityOfConfidence(50)).toBe("medium");
    expect(severityOfConfidence(10)).toBe("info");
  });

  it("computes Jaccard similarity over entity sets", () => {
    expect(jaccard([], [])).toBe(1);
    expect(jaccard(["a", "b"], ["b", "c"])).toBeCloseTo(1 / 3, 5);
    expect(jaccard(["a"], ["a"])).toBe(1);
  });
});

describe("groupFindings", () => {
  it("aggregates set-tier findings per detectorKey with max severity", async () => {
    const groups = await groupFindings([
      finding("ranking_drop", {
        entityKey: "kw-a",
        confidenceScore: 60,
        explanationFact: "Keyword kw-a fell.",
      }),
      finding("ranking_drop", {
        entityKey: "kw-b",
        confidenceScore: 90,
        explanationFact: "Keyword kw-b fell.",
      }),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]?.insightKey).toBe("dashboard:ranking_drop");
    expect(groups[0]?.severity).toBe("critical");
    expect(groups[0]?.title).toBe("2 important keywords lost rankings");
    expect(groups[0]?.findingKeys).toHaveLength(2);
  });

  it("reuses detector titles for singles, group titles for sets", async () => {
    const single = await groupFindings([
      finding("low_ctr_query", {
        entityKey: "q",
        entity: { query: "q" },
        evidence: {
          metrics: { impressions: 500, clicks: 2, position: 8 },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
    ]);
    expect(single).toHaveLength(1);
    expect(single[0]?.title).toBe('Low CTR for "q" at position 8.0');
    const pair = await groupFindings([
      finding("low_ctr_query", { entityKey: "q1" }),
      finding("low_ctr_query", { entityKey: "q2" }),
    ]);
    expect(pair).toHaveLength(1);
    expect(pair[0]?.title).toBe("2 visible queries have low CTR");
  });

  it("emits per-entity insights with sha8 identity", async () => {
    const groups = await groupFindings([
      finding("content_decay", { entityKey: "/guide-a" }),
      finding("content_decay", { entityKey: "/guide-b" }),
    ]);
    expect(groups).toHaveLength(2);
    for (const group of groups) {
      expect(group.insightKey).toMatch(/^dashboard:content_decay:[0-9a-f]{8}$/);
    }
    expect(groups[0]?.insightKey).not.toBe(groups[1]?.insightKey);
  });

  it("bumps severity on high-importance entities", async () => {
    const groups = await groupFindings([
      finding("low_ctr_query", {
        confidenceScore: 60,
        evidence: {
          metrics: { impressions: 50000, clicks: 10 },
          sources: ["gsc"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
    ]);
    // medium (60) bumped one level by 50k-impression importance.
    expect(groups[0]?.severity).toBe("high");
  });

  it("merges sources and spans periods deterministically", async () => {
    const groups = await groupFindings([
      finding("ranking_drop", {
        evidence: {
          metrics: {},
          periods: { from: "2026-01-01", to: "2026-01-07" },
          sources: ["rank"],
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
    ]);
    expect(groups[0]?.sources).toEqual(["rank"]);
    expect(groups[0]?.periods).toEqual({
      from: "2026-01-01",
      to: "2026-01-07",
    });
    expect(groups[0]?.metrics).toMatchObject({});
  });
});
