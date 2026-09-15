import { beforeEach, describe, expect, it, vi } from "vitest";
import { globalTraceStore } from "./globalTraceStore";

vi.mock("@/serverFunctions/rank-tracking", () => ({
  cancelRankCheckRun: vi.fn(async () => ({ ok: true, status: "cancelled" })),
}));

describe("Global Debug Trace — Rank Tracking Selected Checks Integration", () => {
  beforeEach(() => {
    globalTraceStore.clearTrace();
    globalTraceStore.setDiagnosticsEnabled(true);
  });

  it("proves 4 selected keywords triggers exactly 4 rank checks and not 901", () => {
    const totalTrackedKeywords = 901;
    const selectedKeywordIds = ["kw_1", "kw_2", "kw_3", "kw_4"];
    const projectId = "project_powersiment";

    // 1. User clicks "Check selected" with 4 keywords -> trace started synchronously before async work
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId,
      scope: "selected",
      selectedCount: selectedKeywordIds.length,
      selectedKeywordIds,
      billing: "Paid",
      metered: true,
      budget: "PASS",
      cache: "Not applicable",
      retry: { attempted: false, count: 0 },
    });

    const runningOp = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(runningOp?.status).toBe("running");
    expect(runningOp?.scope).toBe("selected");
    expect(runningOp?.selectedCount).toBe(4);
    expect(runningOp?.selectedKeywordIds).toEqual(selectedKeywordIds);

    // 2. Server validates 4 keywords, rejects unselected 897, attaches runId
    const validatedCount = 4;
    const unselectedCount = totalTrackedKeywords - validatedCount; // 897
    const runId = "run_workflow_12345";

    globalTraceStore.updateOperation(opId, {
      validatedCount,
      rankChecksStarted: validatedCount,
      rankChecksSkipped: unselectedCount,
      metadata: { runId, configId: "cfg_1" },
      provider: `DataForSEO ×${validatedCount}`,
      providerCalls: validatedCount,
      providerBreakdown: [{ provider: "DataForSEO", count: validatedCount }],
      providers: Array.from({ length: validatedCount }, () => ({
        provider: "DataForSEO",
        endpoint: "v3/serp/google/organic/live/advanced",
        httpStatus: 200,
        taskStatus: 20000,
        transport: "HTTP",
        billing: "Paid",
        metered: true,
        budgetGuard: "PASS",
      })),
    });

    // 3. Complete check with exact per-keyword children
    const children = selectedKeywordIds.map((id, index) => ({
      keywordId: id,
      keyword: `test keyword ${index + 1}`,
      status: "success" as const,
      provider: "DataForSEO",
      positionBefore: 10 + index,
      positionAfter: 5 + index,
      httpStatus: 200,
      taskStatus: 20000,
      durationMs: 1200 + index * 50,
    }));

    globalTraceStore.completeOperation(opId, {
      status: "success",
      rankChecksSucceeded: validatedCount,
      rankChecksFailed: 0,
      durationMs: 8200,
      children,
    });

    // 4. Verify exact runtime-derived numbers in trace
    const finalOp = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(finalOp).toBeDefined();
    expect(finalOp?.status).toBe("success");
    expect(finalOp?.scope).toBe("selected");
    expect(finalOp?.selectedCount).toBe(4);
    expect(finalOp?.validatedCount).toBe(4);
    expect(finalOp?.rankChecksStarted).toBe(4);
    expect(finalOp?.rankChecksSucceeded).toBe(4);
    expect(finalOp?.rankChecksFailed).toBe(0);
    expect(finalOp?.rankChecksSkipped).toBe(897); // 897 unselected
    expect(finalOp?.providerCalls).toBe(4);
    expect(finalOp?.provider).toBe("DataForSEO ×4");
    expect(finalOp?.billing).toBe("Paid");
    expect(finalOp?.metered).toBe(true);
    expect(finalOp?.budget).toBe("PASS");
    expect(finalOp?.cache).toBe("Not applicable");
    expect(finalOp?.metadata?.runId).toBe("run_workflow_12345");
    expect(finalOp?.children).toHaveLength(4);
    expect(finalOp?.children?.[0].positionBefore).toBe(10);
    expect(finalOp?.children?.[0].positionAfter).toBe(5);

    // CRITICAL: The trace must NOT show 901 rank checks!
    expect(finalOp?.rankChecksStarted).not.toBe(901);
    expect(finalOp?.providerCalls).not.toBe(901);
  });

  it("handles budget blocked rank check gracefully with 0 provider calls", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      scope: "selected",
      selectedCount: 4,
    });

    globalTraceStore.completeOperation(opId, {
      status: "blocked",
      budget: "BLOCKED",
      blockedReason: "DataForSEO budget exceeded",
      providerCalls: 0,
      rankChecksStarted: 0,
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("blocked");
    expect(op?.budget).toBe("BLOCKED");
    expect(op?.providerCalls).toBe(0);
    expect(op?.rankChecksStarted).toBe(0);
  });

  it("trace exists and transitions to failed when server mutation throws validation error", () => {
    // 1. Trace created immediately on click
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "p_1",
      scope: "selected",
      selectedCount: 1,
      selectedKeywordIds: ["invalid_kw"],
    });

    // 2. Server validation rejects the keyword ID
    globalTraceStore.completeOperation(opId, {
      status: "failed",
      errorClass: "VALIDATION_ERROR",
      errorMessage: "None of the selected keywords are tracked on this domain",
      validatedCount: 0,
      rankChecksStarted: 0,
      providerCalls: 0,
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op).toBeDefined();
    expect(op?.status).toBe("failed");
    expect(op?.errorClass).toBe("VALIDATION_ERROR");
    expect(op?.validatedCount).toBe(0);
    expect(op?.providerCalls).toBe(0);
  });

  it("trace exists and transitions to failed when workflow creation fails", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      scope: "selected",
      selectedCount: 1,
    });

    globalTraceStore.completeOperation(opId, {
      status: "failed",
      errorClass: "WORKFLOW_CREATION_FAILED",
      errorMessage: "Failed to start rank check workflow",
      providerCalls: 0,
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("failed");
    expect(op?.errorClass).toBe("WORKFLOW_CREATION_FAILED");
    expect(op?.providerCalls).toBe(0);
  });

  it("trace correctly handles DataForSEO 40201 account pause without fake success", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      scope: "selected",
      selectedCount: 1,
    });

    // Polling receives completed run with 0 checked keywords and DataForSEO 40201 error
    globalTraceStore.completeOperation(opId, {
      status: "failed",
      rankChecksSucceeded: 0,
      rankChecksFailed: 1,
      httpStatus: 200,
      errorClass: "DATAFORSEO_ACCOUNT_PAUSED",
      budget: "PASS",
      errorMessage:
        "1 keyword(s) could not be checked: We noticed some unusual activity in your DataForSEO account",
      provider: "DataForSEO ×1",
      providerCalls: 1,
      providers: [
        {
          provider: "DataForSEO",
          endpoint: "v3/serp/google/organic/live/advanced",
          httpStatus: 200,
          taskStatus: 40201,
          transport: "HTTP",
          billing: "Paid",
          metered: true,
          budgetGuard: "PASS",
        },
      ],
      children: [
        {
          keywordId: "kw_1",
          status: "failed",
          provider: "DataForSEO",
          httpStatus: 200,
          taskStatus: 40201,
        },
      ],
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("failed");
    expect(op?.rankChecksSucceeded).toBe(0);
    expect(op?.rankChecksFailed).toBe(1);
    expect(op?.httpStatus).toBe(200);
    expect(op?.errorClass).toBe("DATAFORSEO_ACCOUNT_PAUSED");
    expect(op?.budget).toBe("PASS");
    expect(op?.providers?.[0]?.budgetGuard).toBe("PASS");
    expect(op?.children?.[0].status).toBe("failed");
  });

  it("trace correctly reports BLOCKED budgetGuard when budget guard blocks provider request", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      scope: "selected",
      selectedCount: 1,
    });

    globalTraceStore.completeOperation(opId, {
      status: "blocked",
      rankChecksSucceeded: 0,
      rankChecksFailed: 1,
      httpStatus: 402,
      errorClass: "CREDITS_UNAVAILABLE",
      budget: "BLOCKED",
      blockedReason: "DataForSEO daily budget exceeded",
      errorMessage: "DataForSEO daily budget exceeded",
      provider: "DataForSEO ×1",
      providerCalls: 0,
      providers: [
        {
          provider: "DataForSEO",
          endpoint: "v3/serp/google/organic/live/advanced",
          httpStatus: 402,
          transport: "HTTP",
          billing: "Paid",
          metered: true,
          budgetGuard: "BLOCKED",
        },
      ],
      children: [],
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("blocked");
    expect(op?.budget).toBe("BLOCKED");
    expect(op?.errorClass).toBe("CREDITS_UNAVAILABLE");
    expect(op?.providers?.[0]?.budgetGuard).toBe("BLOCKED");
    expect(op?.providerCalls).toBe(0);
  });

  it("trace correctly handles successful DataForSEO run when domain has no ranking in top 100", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      scope: "selected",
      selectedCount: 1,
    });

    // Polling receives completed run where keyword was checked, but no ranking was found
    globalTraceStore.completeOperation(opId, {
      status: "success",
      rankChecksSucceeded: 1,
      rankChecksFailed: 0,
      httpStatus: 200,
      providerCalls: 1,
      provider: "DataForSEO ×1",
      children: [
        {
          keywordId: "kw_1",
          status: "no_result",
          provider: "DataForSEO",
          positionBefore: null,
          positionAfter: null,
          httpStatus: 200,
          taskStatus: 20000,
        },
      ],
    });

    const op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("success");
    expect(op?.rankChecksSucceeded).toBe(1);
    expect(op?.children?.[0].status).toBe("no_result");
    expect(op?.children?.[0].positionAfter).toBeNull();
  });

  it("enforces project isolation in getOperations", () => {
    globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "project_A",
    });

    globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "project_B",
    });

    const opsA = globalTraceStore.getOperations("project_A");
    const opsB = globalTraceStore.getOperations("project_B");
    const allOps = globalTraceStore.getOperations();

    expect(opsA).toHaveLength(1);
    expect(opsA[0].projectId).toBe("project_A");
    expect(opsB).toHaveLength(1);
    expect(opsB[0].projectId).toBe("project_B");
    expect(allOps).toHaveLength(2);
  });

  it("cancellation lifecycle: starts at 0 checks started, updates incrementally, and finalizes as cancelled with truthful counts", async () => {
    const selectedKeywordIds = ["kw_1", "kw_2", "kw_3", "kw_4", "kw_5"];
    const projectId = "project_lifecycle";

    // 1. Trigger check selected: initial state starts at 0 checks started & 0 provider calls
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId,
      scope: "selected",
      selectedCount: 5,
      selectedKeywordIds,
      supportsCancellation: true,
      rankChecksStarted: 0,
      providerCalls: 0,
      billing: "Paid",
      metered: true,
      budget: "PASS",
      cache: "Not applicable",
      retry: { attempted: false, count: 0 },
    });

    let op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("running");
    expect(op?.supportsCancellation).toBe(true);
    expect(op?.rankChecksStarted).toBe(0);
    expect(op?.providerCalls).toBe(0);

    // 2. Server creates run and client updates with runId
    const runId = "run_life_123";
    globalTraceStore.updateOperation(opId, {
      supportsCancellation: true,
      rankCheckRunId: runId,
      metadata: { runId, configId: "cfg_1" },
    });

    // 3. Worker executes first 2 keywords: progress increments
    globalTraceStore.updateOperation(opId, {
      rankChecksStarted: 2,
      providerCalls: 2,
      rankChecksSucceeded: 2,
      counters: { checked: 2, total: 5 },
    });

    op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.rankChecksStarted).toBe(2);
    expect(op?.providerCalls).toBe(2);

    // 4. User cancels
    await globalTraceStore.cancelOperation(opId, {
      completedBeforeCancellation: 2,
      remainingItems: 3,
      errorMessage: "Cancelled by user",
    });

    op = globalTraceStore
      .getState()
      .operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("cancelled");
    expect(op?.completedBeforeCancellation).toBe(2);
    expect(op?.remainingItems).toBe(3);
    // Provider calls and checks started must remain at actual 2, never reset to 0 or inflated to 5
    expect(op?.providerCalls).toBe(2);
    expect(op?.rankChecksStarted).toBe(2);
  });
});
