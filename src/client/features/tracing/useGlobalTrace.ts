import { useCallback, useMemo, useSyncExternalStore } from "react";
import { filterOperations } from "./globalTraceFormat";
import { globalTraceStore } from "./globalTraceStore";

export function useGlobalTrace(projectId?: string) {
  const state = useSyncExternalStore(
    globalTraceStore.subscribe,
    globalTraceStore.getState,
    globalTraceStore.getState,
  );

  const scopedOperations = useMemo(() => {
    return projectId
      ? state.operations.filter(
          (op) => !op.projectId || op.projectId === projectId,
        )
      : state.operations;
  }, [state.operations, projectId]);

  const filteredOperations = useMemo(() => {
    return filterOperations(scopedOperations, state.activeFilter);
  }, [scopedOperations, state.activeFilter]);

  const clearTrace = useCallback(() => {
    globalTraceStore.clearTrace(projectId);
  }, [projectId]);

  const removeOperation = useCallback((operationId: string) => {
    return globalTraceStore.removeOperation(operationId);
  }, []);

  const cancelOperation = useCallback(async (operationId: string) => {
    return globalTraceStore.cancelOperation(operationId);
  }, []);

  return {
    operations: filteredOperations,
    allOperations: scopedOperations,
    totalCount: scopedOperations.length,
    diagnosticsEnabled: state.diagnosticsEnabled,
    activeFilter: state.activeFilter,
    panelOpen: state.panelOpen,
    setDiagnosticsEnabled: globalTraceStore.setDiagnosticsEnabled,
    setActiveFilter: globalTraceStore.setActiveFilter,
    setPanelOpen: globalTraceStore.setPanelOpen,
    clearTrace,
    removeOperation,
    cancelOperation,
  };
}
