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

import { detectDecay, isDecayInput, type DecayInput } from "./contentDecay";

function ctx() {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      declineRatio: 0.3,
      minVolume: 50,
    },
    thresholdVersion: 2,
  };
}

function row(
  page: string,
  clicks: [number, number, number],
  days = 28,
): DecayInput["rows"][number] {
  return {
    page,
    windows: clicks.map((c) => ({
      clicks: c,
      impressions: c * 10,
      days,
    })),
    factIds: ["f1"],
  };
}

function input(overrides: Partial<DecayInput> = {}): DecayInput {
  return {
    periodFrom: "2026-01-01",
    periodTo: "2026-01-28",
    windowDays: 28,
    expectedDays: 28,
    rows: [row("https://example.com/guide", [176, 320, 400])],
    rankAgreementByUrl: {},
    rankAvailable: false,
    ga4AgreementByUrl: {},
    ga4Available: false,
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      declineRatio: 0.3,
      minVolume: 50,
    },
    ...overrides,
  };
}

describe("content_decay", () => {
  it("emits on a sustained decline, capped Medium without witnesses", () => {
    const findings = detectDecay(ctx(), input());
    expect(findings).toHaveLength(1);
    // Canonical page identity (shared with technical keys and joins).
    expect(findings[0]?.entityKey).toBe("/https://example.com/guide");
    expect(findings[0]?.evidence.metrics.declineRatio).toBeCloseTo(
      (176 - 320) / 320,
      5,
    );
    expect(findings[0]?.confidenceScore).toBeLessThanOrEqual(69);
    expect(findings[0]?.confidenceScore).toBeGreaterThanOrEqual(40);
    expect(findings[0]?.evidence.partialData).toContain(
      "rank_corroboration_unavailable",
    );
    expect(findings[0]?.evidence.partialData).toContain(
      "ga4_corroboration_unavailable",
    );
    expect(findings[0]?.evidence.sources).toEqual(["gsc"]);
  });

  it("reaches High on large sustained deltas with GA4 agreement alone", () => {
    const findings = detectDecay(
      ctx(),
      input({
        rows: [row("https://example.com/big", [100, 300, 400])],
        ga4AgreementByUrl: { "/https://example.com/big": true },
        ga4Available: true,
        rankAvailable: true,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidenceScore).toBeGreaterThanOrEqual(70);
    expect(findings[0]?.evidence.sources).toEqual(["gsc", "ga4"]);
    expect(findings[0]?.explanationFact).toContain("GA4 session declines");
  });

  it("reaches High on large sustained deltas with rank agreement", () => {
    const findings = detectDecay(
      ctx(),
      input({
        rows: [row("https://example.com/big", [100, 300, 400])],
        rankAgreementByUrl: { "/https://example.com/big": true },
        rankAvailable: true,
      }),
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.confidenceScore).toBeGreaterThanOrEqual(70);
  });

  it("ignores single-window blips (no older-direction agreement)", () => {
    const findings = detectDecay(
      ctx(),
      input({ rows: [row("https://example.com/blip", [176, 320, 200])] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("ignores truncated entities (partial-window negative)", () => {
    const findings = detectDecay(
      ctx(),
      input({ rows: [row("https://example.com/thin", [176, 320, 400], 10)] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("suppresses below-volume baselines", () => {
    const findings = detectDecay(
      ctx(),
      input({ rows: [row("https://example.com/small", [10, 30, 40])] }),
    );
    expect(findings).toHaveLength(0);
  });

  it("rejects mistyped inputs via the guard", () => {
    expect(isDecayInput(null)).toBe(false);
    expect(isDecayInput({ rows: [] })).toBe(false);
    expect(isDecayInput(input())).toBe(true);
  });
});
