import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("pure detector tests must not touch the database");
      },
    },
  ),
}));

import {
  detectCannibalization,
  isCannibalizationInput,
  type CannibalizationInput,
} from "./cannibalization";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minUrls: 2,
      minImpressions: 50,
      dominantShare: 0.8,
      intentOverlapMax: 0.2,
      maxEvidenceRows: 200,
    },
    thresholdVersion: 5,
  };
}

function candidate(
  overrides: Partial<CannibalizationInput["candidates"][number]> = {},
) {
  return {
    query: "best espresso machine",
    urls: ["https://example.com/a", "https://example.com/b"],
    urlImpressions: [800, 600],
    queryImpressions: 1500,
    topShare: 0.53,
    factIds: ["f1", "f2"],
    rankWitnessOnly: false,
    urlQueryOverlap: 1,
    urlQueryCounts: [4, 4] as [number, number],
    priorUrls: ["https://example.com/a", "https://example.com/b"],
    priorCovered: true,
    shiftedIn: [],
    shiftedOut: [],
    ...overrides,
  };
}

function input(
  overrides: Partial<CannibalizationInput> = {},
): CannibalizationInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    periodFromPrior: "2025-12-04",
    periodToPrior: "2025-12-31",
    candidates: [candidate()],
    thresholds: {
      minWindowDays: 28,
      minUrls: 2,
      minImpressions: 50,
      dominantShare: 0.8,
      intentOverlapMax: 0.2,
      maxEvidenceRows: 200,
    },
    ...overrides,
  };
}

function tierOf(findings: ReturnType<typeof detectCannibalization>) {
  return findings[0]?.entity.classification;
}

describe("cannibalization", () => {
  it("emits a two-URL overlap as potential with sorted-pair identity", () => {
    const findings = detectCannibalization(ctx(), input());
    expect(findings).toHaveLength(1);
    expect(findings[0]?.entityKey).toBe(
      "cannibalization:best espresso machine:https://example.com/a:https://example.com/b",
    );
    expect(findings[0]?.explanationFact).toContain("Potential");
    expect(findings[0]?.explanationFact).not.toMatch(
      /caused|because of|due to/i,
    );
    expect(findings[0]?.evidence.metrics.urlCount).toBe(2);
  });

  it("ignores single-URL queries", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [
          candidate({
            urls: ["https://example.com/a"],
            urlImpressions: [800],
          }),
        ],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores below-floor second URLs", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [candidate({ urlImpressions: [800, 10] })],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("emits rank-only witnesses labeled as such", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [candidate({ factIds: [], rankWitnessOnly: true })],
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.evidence.partialData).toContain("rank_witness_only");
    expect(findings[0]?.evidence.sources).toEqual(["rank"]);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isCannibalizationInput(null)).toBe(false);
    expect(isCannibalizationInput({ candidates: [] })).toBe(false);
    expect(isCannibalizationInput(input())).toBe(true);
  });
});

describe("cannibalization classification (spec 018)", () => {
  it("classifies a balanced, overlapping pair as possible cannibalization", () => {
    const findings = detectCannibalization(ctx(), input());
    expect(tierOf(findings)).toBe("POSSIBLE_CANNIBALIZATION");
    expect(findings[0]?.evidence.metrics.classification).toBe(
      "POSSIBLE_CANNIBALIZATION",
    );
    expect(findings[0]?.coverageFlags.classification).toBe(
      "POSSIBLE_CANNIBALIZATION",
    );
    expect(findings[0]?.confidenceScore).toBe(70);
  });

  it("classifies a lopsided split as normal URL diversity", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [candidate({ urlImpressions: [900, 100], topShare: 0.9 })],
      }),
    );
    expect(tierOf(findings)).toBe("NORMAL_URL_DIVERSITY");
    expect(findings[0]?.explanationFact).toContain("90%");
  });

  it("classifies barely overlapping query sets as distinct intent", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [
          candidate({
            urlQueryOverlap: 0.1,
            urlQueryCounts: [10, 9],
          }),
        ],
      }),
    );
    expect(tierOf(findings)).toBe("INTENT_DISTINCT");
    expect(findings[0]?.explanationFact).toContain("overlap 0.10");
  });

  it("classifies a changed set of serving URLs as needs review", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [
          candidate({
            priorUrls: ["https://example.com/a"],
            shiftedIn: ["https://example.com/b"],
            shiftedOut: [],
          }),
        ],
      }),
    );
    expect(tierOf(findings)).toBe("NEEDS_REVIEW");
    expect(findings[0]?.evidence.partialData).toContain("query_page_shift");
    expect(findings[0]?.evidence.metrics.shiftedUrlCount).toBe(1);
  });

  it("classifies a rank-only witness as insufficient data", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [candidate({ factIds: [], rankWitnessOnly: true })],
      }),
    );
    expect(tierOf(findings)).toBe("INSUFFICIENT_DATA");
    expect(findings[0]?.evidence.sources).toEqual(["rank"]);
  });

  it("never infers a shift when the prior window is not covered", () => {
    const findings = detectCannibalization(
      ctx(),
      input({
        candidates: [
          candidate({
            priorCovered: false,
            priorUrls: [],
            shiftedIn: ["https://example.com/a", "https://example.com/b"],
          }),
        ],
      }),
    );
    expect(tierOf(findings)).toBe("POSSIBLE_CANNIBALIZATION");
    expect(findings[0]?.evidence.partialData).toContain(
      "prior_window_not_covered",
    );
    expect(findings[0]?.evidence.partialData).not.toContain("query_page_shift");
    expect(findings[0]?.coverageFlags.priorWindowCovered).toBe(false);
  });

  it("keeps every tier prose free of causal verbs", () => {
    const tiers = [
      candidate(),
      candidate({ urlImpressions: [900, 100], topShare: 0.9 }),
      candidate({ urlQueryOverlap: 0.1 }),
      candidate({ shiftedIn: ["https://example.com/c"] }),
      candidate({ factIds: [], rankWitnessOnly: true }),
    ];
    for (const tier of tiers) {
      const findings = detectCannibalization(
        ctx(),
        input({ candidates: [tier] }),
      );
      expect(findings[0]?.explanationFact).not.toMatch(
        /caused|causes|because of|due to|led to|resulted in|triggered/i,
      );
    }
  });
});
