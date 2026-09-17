import type {
  GlobalTraceFeature,
  GlobalTraceFilter,
  GlobalTraceOperation,
  GlobalTraceStatus,
} from "@/shared/globalTraceTypes";
import { computeProviderBreakdown } from "./globalTraceFormat";
import { cancellationRegistry } from "./cancellationRegistry";
import { dispatchRankCheckServerCancel } from "./rankCheckCancelDispatch";
import {
  DIAGNOSTICS_STORAGE_KEY,
  MAX_OPERATIONS,
  OPERATIONS_STORAGE_KEY,
  getInitialDiagnosticsEnabled,
  getInitialOperations,
  isOperationArrayGuard,
  safeTraceId,
  saveDiagnosticsEnabledToStorage,
  saveOperationsToStorage,
} from "./globalTraceStorage";

// Re-exported for existing consumers that import from the store module.
export { safeTraceId } from "./globalTraceStorage";

type Listener = () => void;

export interface GlobalTraceStoreState {
  operations: GlobalTraceOperation[];
  diagnosticsEnabled: boolean;
  activeFilter: GlobalTraceFilter;
  panelOpen: boolean;
}

class GlobalTraceStore {
  private state: GlobalTraceStoreState;
  private listeners = new Set<Listener>();

  constructor() {
    this.state = {
      operations: getInitialOperations(),
      diagnosticsEnabled: getInitialDiagnosticsEnabled(),
      activeFilter: "all",
      panelOpen: false,
    };

    if (typeof window !== "undefined") {
      window.addEventListener("storage", this.handleStorageEvent);
      Reflect.set(window, "__GLOBAL_TRACE_STORE__", this);
    }
  }

  private saveOperations(ops: GlobalTraceOperation[]) {
    saveOperationsToStorage(ops);
  }

  private handleStorageEvent = (event: StorageEvent) => {
    if (event.key === OPERATIONS_STORAGE_KEY) {
      try {
        const raw = event.newValue;
        const parsed: unknown = raw ? JSON.parse(raw) : [];
        if (isOperationArrayGuard(parsed)) {
          this.state = {
            ...this.state,
            operations: parsed.slice(0, MAX_OPERATIONS),
          };
          this.notify();
        }
      } catch {
        // Ignore
      }
    } else if (event.key === DIAGNOSTICS_STORAGE_KEY) {
      const enabled = event.newValue !== "false";
      if (this.state.diagnosticsEnabled !== enabled) {
        this.state = {
          ...this.state,
          diagnosticsEnabled: enabled,
        };
        this.notify();
      }
    }
  };

  private notify() {
    for (const listener of this.listeners) {
      listener();
    }
  }

  subscribe = (listener: Listener) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getState = (): GlobalTraceStoreState => {
    return this.state;
  };

  setDiagnosticsEnabled = (enabled: boolean) => {
    if (this.state.diagnosticsEnabled === enabled) return;
    saveDiagnosticsEnabledToStorage(enabled);
    this.state = {
      ...this.state,
      diagnosticsEnabled: enabled,
    };
    this.notify();
  };

  isDiagnosticsEnabled = (): boolean => {
    return this.state.diagnosticsEnabled;
  };

  setPanelOpen = (open: boolean) => {
    if (this.state.panelOpen === open) return;
    this.state = {
      ...this.state,
      panelOpen: open,
    };
    this.notify();
  };

  isPanelOpen = (): boolean => {
    return this.state.panelOpen;
  };

  setActiveFilter = (filter: GlobalTraceFilter) => {
    if (this.state.activeFilter === filter) return;
    this.state = {
      ...this.state,
      activeFilter: filter,
    };
    this.notify();
  };

  getActiveFilter = (): GlobalTraceFilter => {
    return this.state.activeFilter;
  };

  /**
   * Starts a new operation in the trace log.
   * Returns the generated operationId.
   */
  startOperation = (
    input: Omit<
      GlobalTraceOperation,
      "traceId" | "operationId" | "startedAt" | "status"
    > & {
      status?: GlobalTraceStatus;
      operationId?: string;
      startedAt?: number;
    },
  ): string => {
    if (!this.state.diagnosticsEnabled) {
      return input.operationId || safeTraceId();
    }

    try {
      const operationId = input.operationId || safeTraceId();
      const traceId = safeTraceId();
      const startedAt = input.startedAt ?? Date.now();

      const newOp: GlobalTraceOperation = {
        ...input,
        traceId,
        operationId,
        status: input.status ?? "running",
        startedAt,
      };

      let newOps = [newOp, ...this.state.operations];
      if (newOps.length > MAX_OPERATIONS) {
        newOps = newOps.slice(0, MAX_OPERATIONS);
      }

      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
      return operationId;
    } catch {
      // Diagnostic operations must never throw (and the fallback itself
      // must not throw either — safeTraceId never uses crypto.randomUUID
      // without a capability check).
      return input.operationId || safeTraceId();
    }
  };

  /**
   * Updates an in-flight operation with progress or new metadata.
   */
  updateOperation = (
    operationId: string,
    patch: Partial<GlobalTraceOperation>,
  ) => {
    if (!this.state.diagnosticsEnabled) return;
    try {
      const index = this.state.operations.findIndex(
        (op) => op.operationId === operationId,
      );
      if (index === -1) return;

      const existing = this.state.operations[index];
      const updated: GlobalTraceOperation = {
        ...existing,
        ...patch,
      };

      // Recalculate provider breakdown if providers changed
      if (patch.providers && !patch.providerBreakdown) {
        updated.providerBreakdown = computeProviderBreakdown(patch.providers);
      }

      const newOps = [
        ...this.state.operations.slice(0, index),
        updated,
        ...this.state.operations.slice(index + 1),
      ];

      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
    } catch {
      // Diagnostic operations must never throw
    }
  };

  /**
   * Completes an operation with a terminal status (success / failed / blocked).
   */
  completeOperation = (
    operationId: string,
    patch: Partial<GlobalTraceOperation> & { status?: GlobalTraceStatus },
  ) => {
    if (!this.state.diagnosticsEnabled) return;
    try {
      const index = this.state.operations.findIndex(
        (op) => op.operationId === operationId,
      );
      if (index === -1) return;

      const existing = this.state.operations[index];
      const completedAt = patch.completedAt ?? Date.now();
      const durationMs =
        patch.durationMs ?? Math.max(0, completedAt - existing.startedAt);

      // Once an operation reaches terminal status 'cancelled', a later completion
      // (e.g. from an out-of-order poll or delayed promise) must not overwrite 'cancelled'.
      const targetStatus =
        existing.status === "cancelled"
          ? "cancelled"
          : (patch.status ?? "success");

      const updated: GlobalTraceOperation = {
        ...existing,
        ...patch,
        status: targetStatus,
        completedAt,
        durationMs,
      };

      if (updated.providers && !updated.providerBreakdown) {
        updated.providerBreakdown = computeProviderBreakdown(updated.providers);
      }

      if (updated.providerBreakdown && !updated.provider) {
        updated.provider = updated.providerBreakdown
          .map((item) => `${item.provider} ×${item.count}`)
          .join(" · ");
      }

      const newOps = [
        ...this.state.operations.slice(0, index),
        updated,
        ...this.state.operations.slice(index + 1),
      ];

      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
    } catch {
      // Diagnostic operations must never throw
    }
  };

  /**
   * Records an already completed operation in a single call.
   */
  recordOperation = (
    op: Omit<GlobalTraceOperation, "traceId" | "operationId"> & {
      operationId?: string;
    },
  ) => {
    if (!this.state.diagnosticsEnabled) return;
    try {
      const operationId = op.operationId || safeTraceId();
      const traceId = safeTraceId();
      const completedAt = op.completedAt ?? Date.now();
      const durationMs = op.durationMs ?? 0;

      const fullOp: GlobalTraceOperation = {
        ...op,
        traceId,
        operationId,
        completedAt,
        durationMs,
      };

      if (fullOp.providers && !fullOp.providerBreakdown) {
        fullOp.providerBreakdown = computeProviderBreakdown(fullOp.providers);
      }

      if (fullOp.providerBreakdown && !fullOp.provider) {
        fullOp.provider = fullOp.providerBreakdown
          .map((item) => `${item.provider} ×${item.count}`)
          .join(" · ");
      }

      let newOps = [fullOp, ...this.state.operations];
      if (newOps.length > MAX_OPERATIONS) {
        newOps = newOps.slice(0, MAX_OPERATIONS);
      }

      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
    } catch {
      // Diagnostic operations must never throw
    }
  };

  /**
   * Explicitly removes a single operation from the trace log.
   * Does NOT affect or cancel the underlying task.
   * Returns true if found and removed, false otherwise.
   */
  removeOperation = (operationId: string): boolean => {
    try {
      const index = this.state.operations.findIndex(
        (op) => op.operationId === operationId,
      );
      if (index === -1) return false;

      const newOps = [
        ...this.state.operations.slice(0, index),
        ...this.state.operations.slice(index + 1),
      ];

      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
      return true;
    } catch {
      return false;
    }
  };

  /**
   * Cancels a currently running or pending operation.
   * Invokes the registered cancellation handler if available.
   * Required transition: running/pending -> cancelling -> cancelled.
   * Idempotent: safe to call multiple times; ignores terminal operations.
   */
  cancelOperation = async (
    operationId: string,
    patch?: Partial<GlobalTraceOperation>,
  ): Promise<boolean> => {
    try {
      const op = this.state.operations.find(
        (item) => item.operationId === operationId,
      );
      if (!op) return false;

      // Only pending or running operations can be cancelled
      if (op.status !== "running" && op.status !== "pending") {
        return false;
      }

      const cancelRequestedAt = Date.now();
      this.updateOperation(operationId, {
        status: "cancelling",
        cancelRequestedAt,
        ...(patch?.completedBeforeCancellation !== undefined && {
          completedBeforeCancellation: patch.completedBeforeCancellation,
        }),
        ...(patch?.remainingItems !== undefined && {
          remainingItems: patch.remainingItems,
        }),
      });

      // Invoke registered cancellation handler, if any
      try {
        await cancellationRegistry.invoke(operationId);
      } catch (err) {
        console.error(
          `Cancellation handler for ${operationId} encountered an error:`,
          err,
        );
      }

      // If this is a rank_tracking operation with a runId, dispatch real server cancellation directly
      await dispatchRankCheckServerCancel(op);

      // Check current state after invocation to respect races with natural completion
      const current = this.state.operations.find(
        (item) => item.operationId === operationId,
      );
      if (!current) return true;

      // If the operation already reached success or failed in the meantime, keep it
      if (current.status === "success" || current.status === "failed") {
        return true;
      }

      const cancelledAt = Math.max(Date.now(), cancelRequestedAt);
      this.completeOperation(operationId, {
        ...patch,
        status: "cancelled",
        cancelledAt,
        completedAt: cancelledAt,
        errorMessage:
          patch?.errorMessage ?? current.errorMessage ?? "Cancelled by user",
      });

      return true;
    } catch {
      return false;
    }
  };

  /**
   * Explicitly clears the trace.
   * If a projectId is provided, clears all operations visible in that scope
   * (both project-specific operations and global/settings operations).
   * If not provided, clears all operations.
   */
  clearTrace = (projectId?: string) => {
    try {
      let newOps: GlobalTraceOperation[];
      if (projectId) {
        newOps = this.state.operations.filter((op) =>
          Boolean(op.projectId && op.projectId !== projectId),
        );
      } else {
        newOps = [];
      }
      this.state = {
        ...this.state,
        operations: newOps,
      };
      this.saveOperations(newOps);
      this.notify();
    } catch {
      // Diagnostic operations must never throw
    }
  };

  getOperations = (projectId?: string): GlobalTraceOperation[] => {
    if (!projectId) return this.state.operations;
    // Project isolation: return operations for the project or global settings operations
    return this.state.operations.filter(
      (op) => !op.projectId || op.projectId === projectId,
    );
  };

  findActiveOperationByFeature = (
    feature: GlobalTraceFeature,
    projectId?: string,
  ): GlobalTraceOperation | undefined => {
    return this.state.operations.find(
      (op) =>
        op.feature === feature &&
        (op.status === "running" ||
          op.status === "cancelling" ||
          op.status === "pending") &&
        (!projectId || !op.projectId || op.projectId === projectId),
    );
  };
}

export const globalTraceStore = new GlobalTraceStore();
