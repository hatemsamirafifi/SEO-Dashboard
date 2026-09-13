/* eslint-disable max-lines, max-lines-per-function, @typescript-eslint/no-unsafe-type-assertion */
import { beforeEach, describe, expect, it } from "vitest";
import { globalTraceStore } from "./globalTraceStore";
import { filterOperations } from "./globalTraceFormat";
import type { GlobalTraceOperation } from "@/shared/globalTraceTypes";

describe("GlobalTraceStore", () => {
  beforeEach(() => {
    globalTraceStore.clearTrace();
    globalTraceStore.setDiagnosticsEnabled(true);
    globalTraceStore.setActiveFilter("all");
  });

  it("1. starts and completes an operation with correct duration and status", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "proj_1",
      scope: "selected",
      selectedCount: 4,
    });

    let state = globalTraceStore.getState();
    const runningOp = state.operations.find((o) => o.operationId === opId);
    expect(runningOp).toBeDefined();
    expect(runningOp?.status).toBe("running");
    expect(runningOp?.selectedCount).toBe(4);

    globalTraceStore.completeOperation(opId, {
      status: "success",
      rankChecksSucceeded: 4,
      durationMs: 8200,
    });

    state = globalTraceStore.getState();
    const completedOp = state.operations.find((o) => o.operationId === opId);
    expect(completedOp?.status).toBe("success");
    expect(completedOp?.durationMs).toBe(8200);
    expect(completedOp?.rankChecksSucceeded).toBe(4);
  });

  it("2. counts provider calls accurately and matches individual providers", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
    });

    globalTraceStore.completeOperation(opId, {
      status: "success",
      providers: [
        { provider: "DataForSEO", httpStatus: 200 },
        { provider: "DataForSEO", httpStatus: 200 },
        { provider: "DataForSEO", httpStatus: 200 },
        { provider: "DataForSEO", httpStatus: 200 },
      ],
      providerCalls: 4,
    });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.providerCalls).toBe(4);
    expect(op?.providers).toHaveLength(4);
  });

  it("3. computes provider breakdown correctly (sum equals providerCalls)", () => {
    const opId = globalTraceStore.startOperation({
      feature: "domain_overview",
      operation: "domain_overview.get",
      source: "Domain Overview page",
    });

    globalTraceStore.completeOperation(opId, {
      status: "success",
      providers: [
        { provider: "Internal", httpStatus: 200 },
        { provider: "Internal", httpStatus: 200 },
        { provider: "DataForSEO", httpStatus: 200 },
        { provider: "DataForSEO", httpStatus: 200 },
      ],
      providerCalls: 4,
    });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.providerBreakdown).toEqual([
      { provider: "Internal", count: 2 },
      { provider: "DataForSEO", count: 2 },
    ]);
    const sum = op?.providerBreakdown?.reduce((acc, item) => acc + item.count, 0);
    expect(sum).toBe(4);
  });

  it("4. handles cache HIT, MISS, and Not applicable", () => {
    // Rank check: live, inherently not applicable
    const op1Id = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      cache: "Not applicable",
    });
    globalTraceStore.completeOperation(op1Id, { status: "success" });

    // Domain overview: cache hit
    const op2Id = globalTraceStore.startOperation({
      feature: "domain_overview",
      operation: "domain_overview.get",
      source: "Domain Overview page",
      cache: "HIT",
      cacheType: "R2",
    });
    globalTraceStore.completeOperation(op2Id, { status: "success" });

    const ops = globalTraceStore.getState().operations;
    const rankOp = ops.find((o) => o.operationId === op1Id);
    const domainOp = ops.find((o) => o.operationId === op2Id);

    expect(rankOp?.cache).toBe("Not applicable");
    expect(domainOp?.cache).toBe("HIT");
    expect(domainOp?.cacheType).toBe("R2");
  });

  it("5. records billing state accurately (Paid vs Free, metered, budget)", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      billing: "Paid",
      metered: true,
      budget: "PASS",
      cost: "$0.0123",
    });
    globalTraceStore.completeOperation(opId, { status: "success" });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.billing).toBe("Paid");
    expect(op?.metered).toBe(true);
    expect(op?.budget).toBe("PASS");
    expect(op?.cost).toBe("$0.0123");
  });

  it("6. records budget BLOCKED state with 0 provider calls and zero network execution", () => {
    const opId = globalTraceStore.startOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      selectedCount: 4,
      validatedCount: 4,
    });

    globalTraceStore.completeOperation(opId, {
      status: "blocked",
      budget: "BLOCKED",
      blockedReason: "DataForSEO budget exceeded",
      providerCalls: 0,
      rankChecksStarted: 0,
    });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("blocked");
    expect(op?.budget).toBe("BLOCKED");
    expect(op?.blockedReason).toBe("DataForSEO budget exceeded");
    expect(op?.providerCalls).toBe(0);
    expect(op?.rankChecksStarted).toBe(0);
  });

  it("7. records retry details when retries occur", () => {
    const opId = globalTraceStore.startOperation({
      feature: "settings",
      operation: "settings.dataforseo.connection_test",
      source: "Settings",
    });

    globalTraceStore.completeOperation(opId, {
      status: "success",
      retry: {
        attempted: true,
        count: 1,
        details: [
          { attempt: 1, provider: "DataForSEO", httpStatus: 500, durationMs: 250 },
        ],
      },
    });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.retry?.attempted).toBe(true);
    expect(op?.retry?.count).toBe(1);
    expect(op?.retry?.details?.[0].httpStatus).toBe(500);
  });

  it("8. normalizes errors and HTTP status codes", () => {
    const opId = globalTraceStore.startOperation({
      feature: "keyword_research",
      operation: "keyword_research.research",
      source: "Keyword Research page",
    });

    globalTraceStore.completeOperation(opId, {
      status: "failed",
      httpStatus: 402,
      errorClass: "CREDITS_UNAVAILABLE",
      errorMessage: "Payment Required",
    });

    const op = globalTraceStore.getState().operations.find((o) => o.operationId === opId);
    expect(op?.status).toBe("failed");
    expect(op?.httpStatus).toBe(402);
    expect(op?.errorClass).toBe("CREDITS_UNAVAILABLE");
    expect(op?.errorMessage).toBe("Payment Required");
  });

  it("9. clears trace explicitly without residual events", () => {
    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_all",
      source: "Rank Tracking page",
      status: "success",
      startedAt: Date.now(),
    });
    expect(globalTraceStore.getState().operations).toHaveLength(1);

    globalTraceStore.clearTrace();
    expect(globalTraceStore.getState().operations).toHaveLength(0);
  });

  it("10. preserves trace state across panel open and close", () => {
    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      status: "success",
      startedAt: Date.now(),
    });

    // Open panel
    globalTraceStore.setPanelOpen(true);
    expect(globalTraceStore.isPanelOpen()).toBe(true);
    expect(globalTraceStore.getState().operations).toHaveLength(1);

    // Close panel
    globalTraceStore.setPanelOpen(false);
    expect(globalTraceStore.isPanelOpen()).toBe(false);
    // Events must still be preserved!
    expect(globalTraceStore.getState().operations).toHaveLength(1);
  });

  it("11. isolates trace events by project", () => {
    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "project_A",
      status: "success",
      startedAt: Date.now(),
    });

    globalTraceStore.recordOperation({
      feature: "rank_tracking",
      operation: "rank_tracking.check_selected",
      source: "Rank Tracking page",
      projectId: "project_B",
      status: "success",
      startedAt: Date.now(),
    });

    // Project A should only see project A's operations
    const projAOps = globalTraceStore.getOperations("project_A");
    expect(projAOps).toHaveLength(1);
    expect(projAOps[0].projectId).toBe("project_A");

    // Project B should only see project B's operations
    const projBOps = globalTraceStore.getOperations("project_B");
    expect(projBOps).toHaveLength(1);
    expect(projBOps[0].projectId).toBe("project_B");
  });

  it("enforces circular buffer max limit of 500 events", () => {
    for (let i = 0; i < 520; i++) {
      globalTraceStore.recordOperation({
        feature: "rank_tracking",
        operation: `rank_tracking.check_${i}`,
        source: "Rank Tracking page",
        status: "success",
        startedAt: Date.now(),
      });
    }

    const state = globalTraceStore.getState();
    expect(state.operations.length).toBe(500);
    // Newest operation should be at index 0
    expect(state.operations[0].operation).toBe("rank_tracking.check_519");
  });

  it("correctly filters operations by filter categories", () => {
    const sampleOps: GlobalTraceOperation[] = [
      {
        traceId: "1",
        operationId: "1",
        feature: "rank_tracking",
        operation: "rank_tracking.check_selected",
        source: "UI",
        status: "success",
        startedAt: Date.now(),
        providerCalls: 4,
      },
      {
        traceId: "2",
        operationId: "2",
        feature: "keyword_research",
        operation: "keyword_research.research",
        source: "UI",
        status: "failed",
        startedAt: Date.now(),
        httpStatus: 500,
      },
      {
        traceId: "3",
        operationId: "3",
        feature: "settings",
        operation: "settings.dataforseo.connection_test",
        source: "Settings",
        status: "success",
        startedAt: Date.now(),
        billing: "Free",
      },
      {
        traceId: "4",
        operationId: "4",
        feature: "domain_overview",
        operation: "domain_overview.get",
        source: "UI",
        status: "success",
        startedAt: Date.now(),
        cache: "HIT",
      },
    ];

    expect(filterOperations(sampleOps, "all")).toHaveLength(4);
    expect(filterOperations(sampleOps, "errors")).toHaveLength(1);
    expect(filterOperations(sampleOps, "providers")).toHaveLength(1);
    expect(filterOperations(sampleOps, "billing")).toHaveLength(1);
    expect(filterOperations(sampleOps, "cache")).toHaveLength(1);
    expect(filterOperations(sampleOps, "rank_tracking")).toHaveLength(1);
    expect(filterOperations(sampleOps, "seo")).toHaveLength(2);
    expect(filterOperations(sampleOps, "settings")).toHaveLength(1);
  });

  it("persists operations into localStorage so they survive navigation/reloads", () => {
    const storage: Record<string, string> = {};
    const mockLocalStorage = {
      getItem: (key: string) => storage[key] ?? null,
      setItem: (key: string, value: string) => {
        storage[key] = value;
      },
      removeItem: (key: string) => {
        delete storage[key];
      },
      clear: () => {
        for (const k of Object.keys(storage)) delete storage[k];
      },
    };

    const globalObj = globalThis as Record<string, unknown>;
    const originalWindow = globalObj.window;
    globalObj.window = {
      localStorage: mockLocalStorage,
      addEventListener: () => {},
      removeEventListener: () => {},
    };

    try {
      const opId = globalTraceStore.startOperation({
        feature: "rank_tracking",
        operation: "rank_tracking.check_selected",
        source: "Rank Tracking page",
        selectedCount: 1,
      });

      const storedRaw = mockLocalStorage.getItem("openseo_global_trace_operations");
      expect(storedRaw).toBeTruthy();
      const stored = (storedRaw ? JSON.parse(storedRaw) : []) as GlobalTraceOperation[];
      expect(stored).toHaveLength(1);
      expect(stored[0]?.operationId).toBe(opId);
      expect(stored[0]?.status).toBe("running");

      globalTraceStore.completeOperation(opId, {
        status: "success",
        rankChecksSucceeded: 1,
      });

      const updatedRaw = mockLocalStorage.getItem("openseo_global_trace_operations");
      const updated = (updatedRaw ? JSON.parse(updatedRaw) : []) as GlobalTraceOperation[];
      expect(updated[0]?.status).toBe("success");
      expect(updated[0]?.rankChecksSucceeded).toBe(1);
    } finally {
      if (originalWindow === undefined) {
        delete globalObj.window;
      } else {
        globalObj.window = originalWindow;
      }
    }
  });

  it("synchronizes operations across tabs when a storage event is received", () => {
    let storageListener: ((event: unknown) => void) | undefined;
    const globalObj = globalThis as Record<string, unknown>;
    const originalWindow = globalObj.window;

    globalObj.window = {
      localStorage: {
        getItem: () => null,
        setItem: () => {},
        removeItem: () => {},
        clear: () => {},
      },
      addEventListener: (type: string, listener: (event: unknown) => void) => {
        if (type === "storage") {
          storageListener = listener;
        }
      },
      removeEventListener: () => {},
    };

    try {
      let notified = false;
      const unsubscribe = globalTraceStore.subscribe(() => {
        notified = true;
      });

      const externalOp: GlobalTraceOperation = {
        traceId: "ext-1",
        operationId: "ext-op-1",
        feature: "rank_tracking",
        operation: "rank_tracking.check_selected",
        source: "Tab A",
        status: "running",
        startedAt: Date.now(),
        selectedCount: 2,
      };

      const storeWithListener = globalTraceStore as unknown as {
        handleStorageEvent?: (event: { key: string; newValue: string }) => void;
      };
      if (typeof storeWithListener.handleStorageEvent === "function") {
        storeWithListener.handleStorageEvent({
          key: "openseo_global_trace_operations",
          newValue: JSON.stringify([externalOp]),
        });
      } else if (storageListener) {
        storageListener({
          key: "openseo_global_trace_operations",
          newValue: JSON.stringify([externalOp]),
        });
      }

      expect(notified).toBe(true);
      expect(globalTraceStore.getState().operations).toHaveLength(1);
      expect(globalTraceStore.getState().operations[0]?.operationId).toBe("ext-op-1");

      unsubscribe();
    } finally {
      if (originalWindow === undefined) {
        delete globalObj.window;
      } else {
        globalObj.window = originalWindow;
      }
    }
  });
});
