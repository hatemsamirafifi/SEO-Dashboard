import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import {
  MaintainerSpikeTrigger,
  formatSpikeEvidence,
  executeSpikeWithGuards,
  type VerdictStatusDisplayData,
} from "./MaintainerSpikeTrigger";
import { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";
import type { CompetitorGapSpikeEvidence } from "@/shared/competitorGap";

// Mock serverFunctions to avoid actual network/DB execution in unit tests
const mocks = vi.hoisted(() => ({
  getVerdict: vi.fn(),
  runSpike: vi.fn(),
}));

vi.mock("@/serverFunctions/competitorGap", () => ({
  getCompetitorGapVerdict: mocks.getVerdict,
  runCompetitorGapSpike: mocks.runSpike,
}));

// Mock useQuery from @tanstack/react-query
let mockQueryResult: {
  data: unknown;
  isFetching: boolean;
  refetch: () => void;
} = {
  data: null,
  isFetching: false,
  refetch: vi.fn(),
};

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => mockQueryResult,
}));

function fixtureEvidence(): CompetitorGapSpikeEvidence {
  return {
    quality: {
      status: "measured",
      value: { keywordCoverageRatio: 0.85, requiredFieldMissingRate: 0 },
    },
    coverage: {
      status: "measured",
      value: {
        firstPartyCoverageRatio: 0.72,
        window: { from: "2026-09-11", to: "2026-10-09" },
      },
    },
    cost: {
      status: "measured",
      value: {
        measuredCreditsPerAnalysis: 12,
        extrapolatedMonthlyPerProject: 48,
      },
    },
    identity: {
      status: "measured",
      value: { collisionsObserved: 0, nonDeterministicMappings: 0 },
    },
    cache: {
      status: "measured",
      value: { repeatAnalysisPaidCalls: 0, repeatCacheHitRate: 1.0 },
    },
  };
}

describe("MaintainerSpikeTrigger Component Tests", () => {
  it("Requirement 10: hides completely for non-maintainers", () => {
    mockQueryResult = { data: null, isFetching: false, refetch: vi.fn() };
    const html = renderToStaticMarkup(
      React.createElement(MaintainerSpikeTrigger, {
        projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
        isMaintainer: false,
      }),
    );
    expect(html).toBe("");
  });

  it("Requirement 6 & 11: manifest values are immutable and displayed read-only", () => {
    mockQueryResult = { data: null, isFetching: false, refetch: vi.fn() };
    const html = renderToStaticMarkup(
      React.createElement(MaintainerSpikeTrigger, {
        projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
        isMaintainer: true,
      }),
    );

    // Manifest values and evaluation headers are present
    expect(html).toContain("Evaluation:");
    expect(html).toContain("Competitor Gap G5 R2");
    expect(html).toContain("Previous evaluation:");
    expect(html).toContain("COMPETITOR_GAP_BLOCKED");
    expect(html).toContain("cgv_4c878e65_2026-10-14T20:09:49.856Z");
    expect(html).toContain("Current evaluation: R2 — not yet executed");
    expect(html).toContain(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId);
    expect(html).toContain("emtyiaz.com, manaraa.com, bahthy.com");
    expect(html).toContain("gsc-top-queries-2026-10-09");
    expect(html).toContain("500 credits");
    expect(html).toContain("Run Competitor Gap Spike");

    // Proves there are no inputs to edit these fields
    expect(html).not.toContain('<input value="500"');
    expect(html).not.toContain('<input value="gsc-top-queries-2026-10-09"');
    expect(html).not.toContain('name="thresholds"');
  });

  it("Requirement 3 & 12: detects and rejects wrong project context", () => {
    mockQueryResult = { data: null, isFetching: false, refetch: vi.fn() };
    const html = renderToStaticMarkup(
      React.createElement(MaintainerSpikeTrigger, {
        projectId: "wrong-project-id",
        isMaintainer: true,
      }),
    );

    expect(html).toContain("Project context mismatch");
    expect(html).toContain("Invocation is disabled for this project");
  });

  it("Requirement 7 & 12: duplicate execution prevented when verdict already exists in UI", () => {
    mockQueryResult = {
      data: {
        verdict: "COMPETITOR_GAP_READY",
        gateState: "READY",
        verdictId: "cgv_r2_12345",
        evidence: fixtureEvidence(),
        thresholds: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds,
      },
      isFetching: false,
      refetch: vi.fn(),
    };

    const html = renderToStaticMarkup(
      React.createElement(MaintainerSpikeTrigger, {
        projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
        isMaintainer: true,
      }),
    );

    // Displays recorded verdict & row ID
    expect(html).toContain("Spike Verdict Recorded");
    expect(html).toContain("COMPETITOR_GAP_READY");
    expect(html).toContain("cgv_r2_12345");
    expect(html).toContain("repeat execution is locked out");

    // The execution button is not present
    expect(html).not.toContain("Run Competitor Gap Spike</button>");
  });

  it("Requirement 9: formats and displays all 9 required metrics and unavailable dimensions correctly", () => {
    const evidence = fixtureEvidence();
    const formatted = formatSpikeEvidence(evidence);

    expect(formatted).not.toBeNull();
    expect(formatted!.keywordCoverageRatio).toBe("85.0%");
    expect(formatted!.firstPartyCoverageRatio).toBe("72.0%");
    expect(formatted!.costPerAnalysisCredits).toBe("12 credits");
    expect(formatted!.repeatCacheHitRate).toBe("100.0%");
    expect(formatted!.repeatAnalysisPaidCalls).toBe("0");
    expect(formatted!.identityCollisions).toBe("0");
    expect(formatted!.identityDeterministic).toBe("YES");
    expect(formatted!.unavailableDimensions).toBe(
      "None (all dimensions measured)",
    );

    // Test with an unavailable dimension
    const withUnavailable: CompetitorGapSpikeEvidence = {
      ...evidence,
      coverage: { status: "unavailable", reason: "GSC not connected" },
    };
    const formattedUnavailable = formatSpikeEvidence(withUnavailable);
    expect(formattedUnavailable!.firstPartyCoverageRatio).toBe("unavailable");
    expect(formattedUnavailable!.unavailableDimensions).toContain(
      "Coverage (GSC not connected)",
    );
  });
});

describe("executeSpikeWithGuards Safety Engine Tests", () => {
  it("Requirement 7: prevents duplicate execution if verdict row already exists before invocation", async () => {
    const mockGetVerdict = vi.fn().mockResolvedValue({
      verdict: "COMPETITOR_GAP_READY",
      gateState: "READY",
      verdictId: "cgv_existing_1",
    });
    const mockRunSpike = vi.fn();

    const outcome = await executeSpikeWithGuards({
      projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
      manifest: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
    });

    expect(outcome).toEqual({
      type: "ALREADY_RECORDED",
      verdict: "COMPETITOR_GAP_READY",
      verdictId: "cgv_existing_1",
    });
    // Hard invariant: runCompetitorGapSpike must NOT be called
    expect(mockRunSpike).not.toHaveBeenCalled();
  });

  it("Requirement 8: double-click / in-flight duplicate prevented", async () => {
    const inFlightLock = { current: true };
    const mockGetVerdict = vi.fn();
    const mockRunSpike = vi.fn();

    const outcome = await executeSpikeWithGuards({
      projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
      manifest: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
      inFlightLock,
    });

    expect(outcome).toEqual({ type: "ABORTED_IN_FLIGHT" });
    expect(mockRunSpike).not.toHaveBeenCalled();
    expect(mockGetVerdict).not.toHaveBeenCalled();
  });

  it("Requirement 8: surfaces server error when invocation fails", async () => {
    const mockGetVerdict = vi.fn().mockResolvedValue(null);
    const mockRunSpike = vi.fn().mockResolvedValue({
      ok: false,
      error: "SPIKE_BUDGET_EXCEEDED: Projected 600 > Cap 500",
    });

    const outcome = await executeSpikeWithGuards({
      projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
      manifest: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
    });

    expect(outcome).toEqual({
      type: "ERROR",
      error: "SPIKE_BUDGET_EXCEEDED: Projected 600 > Cap 500",
    });
    expect(mockRunSpike).toHaveBeenCalledTimes(1);
  });

  it("Requirement 9 & 12: successful invocation reads the recorded ledger verdict and polls result", async () => {
    const recordedRow: VerdictStatusDisplayData = {
      verdict: "COMPETITOR_GAP_READY",
      gateState: "READY",
      verdictId: "cgv_fresh_999",
      evidence: fixtureEvidence(),
      thresholds: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds,
    };

    // Pre-check returns null (no verdict), post-run poll returns recorded row
    const mockGetVerdict = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(recordedRow);

    const mockRunSpike = vi.fn().mockResolvedValue({
      ok: true,
      verdict: "COMPETITOR_GAP_READY",
      verdictId: "cgv_fresh_999",
    });

    const inFlightLock = { current: false };

    const outcome = await executeSpikeWithGuards({
      projectId: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId,
      manifest: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
      inFlightLock,
    });

    expect(outcome).toEqual({
      type: "INVOKED",
      verdict: "COMPETITOR_GAP_READY",
      rowId: "cgv_fresh_999",
      pollResult: recordedRow,
    });

    // Invariant: exactly-once invocation
    expect(mockRunSpike).toHaveBeenCalledTimes(1);
    expect(mockRunSpike).toHaveBeenCalledWith({
      data: FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
    });
    expect(mockGetVerdict).toHaveBeenCalledTimes(2);
    // Lock released after completion
    expect(inFlightLock.current).toBe(false);
  });

  it("R1 verdict does NOT block an authorized R2 evaluation", async () => {
    // When checking for R2, getVerdict receives evaluationId: 'competitor-gap-g5-r2' and returns null
    const mockGetVerdict = vi.fn().mockImplementation(({ data }) => {
      if (data.evaluationId === "competitor-gap-g5-r2") {
        return Promise.resolve(null);
      }
      // R1 historical row is blocked
      return Promise.resolve({
        verdict: "COMPETITOR_GAP_BLOCKED",
        gateState: "BLOCKED",
        verdictId: "cgv_4c878e65_2026-10-14T20:09:49.856Z",
      });
    });

    const mockRunSpike = vi.fn().mockResolvedValue({
      ok: true,
      verdict: "COMPETITOR_GAP_READY",
      verdictId: "cgv_r2_new",
    });

    const r2Manifest = {
      ...FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      evaluationId: "competitor-gap-g5-r2",
    };

    const outcome = await executeSpikeWithGuards({
      projectId: r2Manifest.projectId,
      manifest: r2Manifest,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
    });

    expect(outcome.type).toBe("INVOKED");
    expect(mockRunSpike).toHaveBeenCalledTimes(1);
    expect(mockGetVerdict).toHaveBeenCalledWith({
      data: {
        projectId: r2Manifest.projectId,
        evaluationId: "competitor-gap-g5-r2",
      },
    });
  });

  it("existing R2 verdict prevents duplicate R2 execution", async () => {
    const mockGetVerdict = vi.fn().mockResolvedValue({
      verdict: "COMPETITOR_GAP_READY",
      gateState: "READY",
      verdictId: "cgv_r2_existing_row",
    });
    const mockRunSpike = vi.fn();

    const r2Manifest = {
      ...FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
      evaluationId: "competitor-gap-g5-r2",
    };

    const outcome = await executeSpikeWithGuards({
      projectId: r2Manifest.projectId,
      manifest: r2Manifest,
      getVerdict: mockGetVerdict,
      runSpike: mockRunSpike,
    });

    expect(outcome).toEqual({
      type: "ALREADY_RECORDED",
      verdict: "COMPETITOR_GAP_READY",
      verdictId: "cgv_r2_existing_row",
    });
    expect(mockRunSpike).not.toHaveBeenCalled();
  });
});
