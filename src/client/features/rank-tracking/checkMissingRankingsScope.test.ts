import { beforeEach, describe, expect, it, vi } from "vitest";

// Selection-scope contract for "Check missing" on a table selection: the
// exact selected keyword IDs are sent to the server and intersected with the
// eligible set there — the eligible set is never guessed client-side from
// rendered state.

function selectedIdsFromTableState(
  selection: Record<string, boolean>,
  rowIdsInData: string[],
): string[] {
  return rowIdsInData.filter((id) => selection[id]);
}

function triggerPayload(selectedIds: string[]): {
  missingRankings: true;
  keywordIds: string[];
} | null {
  if (selectedIds.length === 0) return null;
  return { missingRankings: true, keywordIds: selectedIds };
}

const traceMocks = vi.hoisted(() => ({
  startOperation: vi.fn(() => "op_test_1"),
  updateOperation: vi.fn(),
  completeOperation: vi.fn(),
  recordOperation: vi.fn(),
  mutate: vi.fn(),
  triggerSuccessResult: null as any,
}));

vi.mock("react", async () => {
  const actual = await vi.importActual<typeof import("react")>("react");
  return {
    ...actual,
    useRef: (initial: any) => ({ current: initial }),
  };
});

vi.mock("@tanstack/react-query", () => ({
  useMutation: (opts: any) => ({
    mutate: (vars: any) => {
      traceMocks.mutate(vars);
      if (traceMocks.triggerSuccessResult) {
        opts?.onSuccess?.(traceMocks.triggerSuccessResult, vars);
      }
    },
    isPending: false,
  }),
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
    startOperation: traceMocks.startOperation,
    updateOperation: traceMocks.updateOperation,
    completeOperation: traceMocks.completeOperation,
    recordOperation: traceMocks.recordOperation,
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

describe("useRankCheckTrigger missingRankingStates & trace integration", () => {
  beforeEach(() => {
    traceMocks.startOperation.mockClear();
    traceMocks.updateOperation.mockClear();
    traceMocks.mutate.mockClear();
    traceMocks.triggerSuccessResult = null;
  });

  it("records missingRankingStates in start trace and updates with candidates/missing counts", async () => {
    traceMocks.triggerSuccessResult = {
      ok: true,
      runId: "run_123",
      scope: "all",
      selectedCount: 878,
      validatedCount: 15,
      candidatesCount: 878,
      missingEligibleBeforeFilter: 677,
      selectedStates: ["lost"],
      breakdown: { ranking_unavailable: 571, lost: 15, no_ranking: 91 },
    };

    const { useRankCheckTrigger } = await import("./useRankCheckTrigger");
    const { startCheck } = useRankCheckTrigger({
      configId: "config_1",
      isRunning: false,
      projectId: "project_1",
      devices: "both",
      onSuccess: vi.fn(),
    });

    startCheck({
      missingRankings: true,
      missingRankingStates: ["lost"],
    });

    expect(traceMocks.startOperation).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: "rank_tracking.check_missing_rankings",
        metadata: expect.objectContaining({
          missingRankingStates: ["lost"],
        }),
      }),
    );

    expect(traceMocks.mutate).toHaveBeenCalledWith(
      expect.objectContaining({
        missingRankings: true,
        missingRankingStates: ["lost"],
      }),
    );

    expect(traceMocks.updateOperation).toHaveBeenCalledWith(
      "op_test_1",
      expect.objectContaining({
        metadata: expect.objectContaining({
          missingRankingStates: ["lost"],
          candidatesCount: 878,
          missingEligibleBeforeFilter: 677,
          selectedStateEligible: 15,
        }),
      }),
    );
  });

  it("Clear all (empty missingRankingStates) starts NO trace and makes NO mutation", async () => {
    const { useRankCheckTrigger } = await import("./useRankCheckTrigger");
    const { startCheck } = useRankCheckTrigger({
      configId: "config_1",
      isRunning: false,
      projectId: "project_1",
      devices: "both",
      onSuccess: vi.fn(),
    });

    startCheck({
      missingRankings: true,
      missingRankingStates: [],
    });

    expect(traceMocks.startOperation).not.toHaveBeenCalled();
    expect(traceMocks.mutate).not.toHaveBeenCalled();
  });
});
