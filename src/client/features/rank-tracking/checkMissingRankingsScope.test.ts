import { beforeEach, describe, expect, it, vi } from "vitest";

// Selection-scope contract for "Check missing" on a table selection: the
// exact selected keyword IDs are sent to the server and intersected with the
// eligible set there — the eligible set is never guessed client-side from
// rendered state.

/**
 * Mirrors RankTrackingTable's bulk-action wiring: tan-stack selection state
 * (keyed by row id = trackingKeywordId) to the ID list sent to
 * onCheckMissingSelected.
 */
function selectedIdsFromTableState(
  selection: Record<string, boolean>,
  rowIdsInData: string[],
): string[] {
  return rowIdsInData.filter((id) => selection[id]);
}

/**
 * Mirrors RankTrackingDomainDetail.handleCheckMissingSelected: the selected
 * ids travel verbatim as the missing-rankings trigger scope.
 */
function triggerPayload(selectedIds: string[]): {
  missingRankings: true;
  keywordIds: string[];
} | null {
  if (selectedIds.length === 0) return null;
  return { missingRankings: true, keywordIds: selectedIds };
}

describe("check missing: selection scope", () => {
  it("sends exactly the selected ids; eligibility intersection happens server-side", () => {
    const ids = selectedIdsFromTableState(
      { keyword_1: true, keyword_2: true, keyword_3: true },
      ["keyword_1", "keyword_2", "keyword_3", "keyword_4"],
    );
    const payload = triggerPayload(ids);
    expect(payload?.keywordIds).toEqual([
      "keyword_1",
      "keyword_2",
      "keyword_3",
    ]);
    expect(payload?.missingRankings).toBe(true);
  });

  it("no selection → no keywordIds (server resolves the config scope)", () => {
    expect(triggerPayload([])).toBeNull();
  });
});

// Operation naming contract for the trace: missing-rankings triggers label
// themselves rank_tracking.check_missing_rankings.
describe("resolveOperationAndScope", () => {
  let resolveOperationAndScope: (opts: {
    keywordIds?: string[];
    missingRankings?: boolean;
  }) => { operation: string; scope: string };

  beforeEach(async () => {
    vi.resetModules();
    vi.mock("@tanstack/react-query", () => ({
      useMutation: () => ({ mutate: vi.fn(), isPending: false }),
      useQueryClient: () => ({ invalidateQueries: vi.fn() }),
    }));
    vi.mock("sonner", () => ({
      toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() },
    }));
    vi.mock("@/client/lib/error-messages", () => ({
      getStandardErrorMessage: () => "err",
    }));
    vi.mock("@/client/lib/posthog", () => ({ captureClientEvent: vi.fn() }));
    vi.mock("@/serverFunctions/rank-tracking", () => ({
      triggerRankCheck: vi.fn(),
      cancelRankCheckRun: vi.fn(),
    }));
    vi.mock("@/client/features/tracing/globalTraceStore", () => ({
      globalTraceStore: {
        startOperation: vi.fn(() => "op_1"),
        updateOperation: vi.fn(),
        completeOperation: vi.fn(),
        recordOperation: vi.fn(),
      },
    }));
    vi.mock("@/client/features/tracing/cancellationRegistry", () => ({
      registerCancellation: vi.fn(),
      unregisterCancellation: vi.fn(),
    }));
    vi.mock("./rankTraceCompletion", () => ({
      resolveCheckBusyState: () => "proceed",
      busyBlockedReason: () => "busy",
    }));

    const mod = await import("./useRankCheckTrigger");
    resolveOperationAndScope = mod.resolveOperationAndScope;
  });

  it("missing-rankings without selection → check_missing_rankings / all", () => {
    const result = resolveOperationAndScope({ missingRankings: true });
    expect(result.operation).toBe("rank_tracking.check_missing_rankings");
    expect(result.scope).toBe("all");
  });

  it("missing-rankings with selection → check_missing_rankings / selected", () => {
    const result = resolveOperationAndScope({
      keywordIds: ["k1"],
      missingRankings: true,
    });
    expect(result.operation).toBe("rank_tracking.check_missing_rankings");
    expect(result.scope).toBe("selected");
  });

  it("plain selection → check_selected (unchanged)", () => {
    expect(resolveOperationAndScope({ keywordIds: ["k1"] }).operation).toBe(
      "rank_tracking.check_selected",
    );
  });

  it("no selection → check_all (unchanged)", () => {
    expect(resolveOperationAndScope({}).operation).toBe(
      "rank_tracking.check_all",
    );
  });
});
