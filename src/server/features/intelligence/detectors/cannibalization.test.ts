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
    },
    thresholdVersion: 2,
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
    ...overrides,
  };
}

function input(
  overrides: Partial<CannibalizationInput> = {},
): CannibalizationInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    candidates: [candidate()],
    thresholds: { minWindowDays: 28, minUrls: 2, minImpressions: 50 },
    ...overrides,
  };
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
