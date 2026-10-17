// Spec 014 US1 tests (T011/T012): spike harness dimensions + budget guard.
// Deps are injected — no provider access, no router, no DB in these cases
// (ledger persistence is covered by verdictLedger.test.ts; the harness
// writes through the same mock-runBatch seam here).

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const ledger = vi.hoisted(() => ({
  recordVerdict: vi.fn(),
}));

vi.mock("@/db", () => ({
  db: {},
  withPgClient: async (fn: () => Promise<unknown>) => fn(),
}));

vi.mock("@/db/runBatch", () => ({
  runBatch: async () => {},
  executeInBatches: async () => {},
}));

vi.mock("./verdictLedger", async () => {
  const actual = await vi.importActual("./verdictLedger");
  return { ...actual, recordVerdict: ledger.recordVerdict };
});

vi.mock("@/server/lib/seo-data/cost-tracker", () => ({
  getCostCounters: () => ({ estimatedDataforseoCostUsd: 0 }),
}));

vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    GscSearchPerformanceRepository: {
      getStoredCoverageRange: vi.fn(),
    },
  }),
);

import {
  runSpike,
  SpikeBudgetExceededError,
  type SpikeHarnessDeps,
} from "./spikeHarness";
import { evaluateVerdict } from "./verdictLedger";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapSpikeManifest,
  CompetitorGapSpikeThresholds,
} from "@/shared/competitorGap";

const THRESHOLDS: CompetitorGapSpikeThresholds = {
  minKeywordCoverageRatio: 0.5,
  minFirstPartyCoverageRatio: 0.5,
  maxCostPerAnalysisCredits: 100,
  repeatCacheHitRate: 1.0,
  identityCollisionsAllowed: 0,
};

const MANIFEST: CompetitorGapSpikeManifest = {
  organizationId: "org-1",
  projectId: "project-1",
  sampleDomains: ["competitor-a.com", "competitor-b.com"],
  keywordSetRef: "kw-set-1",
  market: { locationCode: 2840, languageCode: "en" },
  budgetCapCredits: 500,
  timeBoxHours: 4,
  thresholds: THRESHOLDS,
};

const BILLING: BillingCustomerContext = {
  organizationId: "org-1",
  userEmail: "owner@example.com",
  userId: "user-1",
};

function passingDeps(): SpikeHarnessDeps {
  return {
    fetchCompetitors: vi
      .fn()
      .mockResolvedValue([
        { domain: "competitor-a.com", keyword_count: 10 },
        { domain: "competitor-b.com" },
      ]),
    fetchFirstPartyCoverageRatio: vi.fn().mockResolvedValue(0.9),
    measureCredits: vi.fn().mockReturnValue(0),
    now: () => new Date("2026-10-09T12:00:00.000Z"),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  ledger.recordVerdict.mockReset();
  ledger.recordVerdict.mockImplementation(
    async (input: {
      evidence: CompetitorGapSpikeEvidence;
      thresholds: CompetitorGapSpikeThresholds;
      manifest: CompetitorGapSpikeManifest;
      recordedAt?: string;
    }) => {
      const verdict = evaluateVerdict({
        evidence: input.evidence,
        thresholds: input.thresholds,
      });
      return {
        id: "row-id",
        organizationId: input.manifest.organizationId,
        projectId: input.manifest.projectId,
        verdict,
        evidence: input.evidence,
        thresholds: input.thresholds,
        inputManifest: input.manifest,
        recordedAt: input.recordedAt ?? "2026-10-09T12:00:00.000Z",
      };
    },
  );
});

describe("runSpike — evidence shape (T011a)", () => {
  it("produces the frozen evidence shape with all five dimensions measured", async () => {
    const deps = passingDeps();
    const row = await runSpike({
      manifest: MANIFEST,
      billing: BILLING,
      deps,
    });

    expect(row.verdict).toBe("COMPETITOR_GAP_READY");
    expect(row.evidence.quality.status).toBe("measured");
    if (row.evidence.quality.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.quality.value.keywordCoverageRatio).toBe(1);
    expect(row.evidence.quality.value.requiredFieldMissingRate).toBe(0);

    expect(row.evidence.coverage.status).toBe("measured");
    if (row.evidence.coverage.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.coverage.value.firstPartyCoverageRatio).toBe(0.9);
    expect(row.evidence.coverage.value.window).toEqual({
      from: "2026-09-11",
      to: "2026-10-09",
    });

    expect(row.evidence.cost.status).toBe("measured");
    expect(row.evidence.identity.status).toBe("measured");
    if (row.evidence.identity.status !== "measured")
      throw new Error("unreachable");
    // 6 raw variants per domain × 2 domains; distinct inputs never collide
    // under the §006 chain (www vs apex are deliberately DIFFERENT hosts).
    expect(row.evidence.identity.value.collisionsObserved).toBe(0);
    expect(row.evidence.identity.value.nonDeterministicMappings).toBe(0);

    expect(row.evidence.cache.status).toBe("measured");
    if (row.evidence.cache.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.cache.value.repeatAnalysisPaidCalls).toBe(0);
    expect(row.evidence.cache.value.repeatCacheHitRate).toBe(1);
  });

  it("records the manifest + thresholds with the verdict row (auditability)", async () => {
    const row = await runSpike({
      manifest: MANIFEST,
      billing: BILLING,
      deps: passingDeps(),
    });
    expect(row.inputManifest).toEqual(MANIFEST);
    expect(row.thresholds).toEqual(THRESHOLDS);
  });
});

describe("runSpike — provider failure → unavailable, never 0 (T011b, P8/P9)", () => {
  it("marks the quality dimension unavailable when competitor fetches fail", async () => {
    const deps = passingDeps();
    deps.fetchCompetitors = vi
      .fn()
      .mockRejectedValue(new Error("DATAFORSEO_ACCESS_PAUSED"));
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });

    expect(row.evidence.quality.status).toBe("unavailable");
    if (row.evidence.quality.status !== "unavailable")
      throw new Error("unreachable");
    expect(row.evidence.quality.reason).toContain("DATAFORSEO_ACCESS_PAUSED");
    expect(row.verdict).toBe("COMPETITOR_GAP_BLOCKED");
  });

  it("marks the coverage dimension unavailable when the coverage read fails", async () => {
    const deps = passingDeps();
    deps.fetchFirstPartyCoverageRatio = vi
      .fn()
      .mockRejectedValue(new Error("coverage read failed"));
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });

    expect(row.evidence.coverage.status).toBe("unavailable");
    expect(row.verdict).toBe("COMPETITOR_GAP_BLOCKED");
  });

  it("treats successful empty competitor rows as a MEASURED zero ratio, not unavailable", async () => {
    const deps = passingDeps();
    deps.fetchCompetitors = vi.fn().mockResolvedValue([]);
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });

    expect(row.evidence.quality.status).toBe("measured");
    if (row.evidence.quality.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.quality.value.keywordCoverageRatio).toBe(0);
    // A measured 0-coverage still fails the threshold — BLOCKED, but with a
    // measured value, not an unavailable marker.
    expect(row.verdict).toBe("COMPETITOR_GAP_BLOCKED");
  });
});

describe("runSpike — identity measurement (T011c)", () => {
  it("detects no collisions across scheme/case/trailing-slash/query variants", async () => {
    const deps = passingDeps();
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });
    if (row.evidence.identity.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.identity.value.collisionsObserved).toBe(0);
    expect(row.evidence.identity.value.nonDeterministicMappings).toBe(0);
  });
});

describe("runSpike — cache reuse (T011d, SC-004)", () => {
  it("reports zero repeat paid calls and hit rate 1 when the repeat fetch is free", async () => {
    const deps = passingDeps();
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });
    if (row.evidence.cache.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.cache.value.repeatAnalysisPaidCalls).toBe(0);
    expect(row.evidence.cache.value.repeatCacheHitRate).toBe(1);
    // One fetch per domain (quality) + one repeat (cache): 3 total calls.
    expect(deps.fetchCompetitors).toHaveBeenCalledTimes(3);
  });

  it("reports a paid repeat when the repeat fetch bills — evidence still measured", async () => {
    const credits = { value: 0 };
    const deps = passingDeps();
    deps.measureCredits = vi.fn().mockImplementation(() => credits.value);
    deps.fetchCompetitors = vi.fn().mockImplementation(async () => {
      credits.value += 1;
      return [{ domain: "competitor-a.com" }];
    });
    const row = await runSpike({ manifest: MANIFEST, billing: BILLING, deps });
    if (row.evidence.cache.status !== "measured")
      throw new Error("unreachable");
    expect(row.evidence.cache.value.repeatAnalysisPaidCalls).toBe(1);
    expect(row.evidence.cache.value.repeatCacheHitRate).toBe(0);
    expect(row.verdict).toBe("COMPETITOR_GAP_BLOCKED");
  });
});

describe("runSpike — budget guard (T012, P12)", () => {
  it("refuses to start when projected spend exceeds the manifest budget cap", async () => {
    const manifest = {
      ...MANIFEST,
      budgetCapCredits: 3, // projection is 4 (2 domains × 2 fetches)
    };
    await expect(
      runSpike({ manifest, billing: BILLING, deps: passingDeps() }),
    ).rejects.toBeInstanceOf(SpikeBudgetExceededError);

    expect(ledger.recordVerdict).not.toHaveBeenCalled();
  });

  it("records the refusal explicitly — no verdict row, no partial measurements", async () => {
    const manifest = { ...MANIFEST, budgetCapCredits: 1 };
    const deps = passingDeps();
    await expect(
      runSpike({ manifest, billing: BILLING, deps }),
    ).rejects.toThrow(/SPIKE_BUDGET_EXCEEDED/);

    expect(deps.fetchCompetitors).not.toHaveBeenCalled();
    expect(ledger.recordVerdict).not.toHaveBeenCalled();
  });

  it("runs when the projection fits the cap", async () => {
    const manifest = { ...MANIFEST, budgetCapCredits: 4 };
    const row = await runSpike({
      manifest,
      billing: BILLING,
      deps: passingDeps(),
    });
    expect(row.verdict).toBe("COMPETITOR_GAP_READY");
  });
});
