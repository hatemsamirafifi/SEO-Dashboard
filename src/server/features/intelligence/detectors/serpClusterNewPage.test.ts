import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  detectSerpClusterNewPage,
  isSerpClusterNewPageInput,
  type SerpClusterNewPageInput,
} from "./serpClusterNewPage";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minKeywordThreshold: 3,
      minCoverageRatio: 0.8,
      minClusterPages: 2,
      freshnessDays: 30,
    },
    thresholdVersion: 6,
  };
}

function input(
  overrides: Partial<SerpClusterNewPageInput> = {},
): SerpClusterNewPageInput {
  return {
    candidates: [
      {
        configId: "cfg-1",
        clusterId: "https://a.com/1|https://b.com/1",
        keywordCount: 4,
        pageCount: 2,
        newPageUrls: ["https://b.com/1"],
        keywords: ["k1", "k2", "k3", "k4"],
        coverageStatus: "ready",
        coveragePercent: 100,
        locationCode: 2840,
        languageCode: "en",
        device: "desktop",
      },
    ],
    thresholds: {
      minKeywordThreshold: 3,
      minCoverageRatio: 0.8,
      minClusterPages: 2,
      freshnessDays: 30,
    },
    ...overrides,
  };
}

describe("serp_cluster_new_page (spec 019)", () => {
  it("emits one evidence-backed finding per new-page cluster", () => {
    const findings = detectSerpClusterNewPage(ctx(), input());

    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe(
      "serp_cluster:cfg-1:https://a.com/1|https://b.com/1",
    );
    expect(findings[0]?.entity.newPageUrls).toBe("https://b.com/1");
    expect(findings[0]?.evidence.metrics).toMatchObject({
      keywordCount: 4,
      pageCount: 2,
      newPageCount: 1,
      coveragePercent: 100,
    });
    expect(findings[0]?.evidence.sources).toEqual(["rank"]);
    expect(findings[0]?.explanationFact).not.toMatch(
      /caused|because of|due to|led to|resulted in|triggered/i,
    );
  });

  it("skips clusters below the keyword threshold", () => {
    const base = input();
    const findings = detectSerpClusterNewPage(
      ctx(),
      input({
        candidates: [{ ...base.candidates[0], keywordCount: 2 }],
      }),
    );

    expect(findings).toEqual([]);
  });

  it("marks a partial coverage as partial data", () => {
    const base = input();
    const findings = detectSerpClusterNewPage(
      ctx(),
      input({
        candidates: [
          { ...base.candidates[0], coverageStatus: "insufficient_data" },
        ],
      }),
    );

    expect(findings[0]?.evidence.partialData).toContain(
      "organic_coverage_partial",
    );
    expect(findings[0]?.coverageFlags.coverageStatus).toBe("insufficient_data");
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isSerpClusterNewPageInput(null)).toBe(false);
    expect(isSerpClusterNewPageInput({ candidates: [] })).toBe(false);
    expect(isSerpClusterNewPageInput(input())).toBe(true);
  });
});
