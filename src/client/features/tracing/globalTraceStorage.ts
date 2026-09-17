import type { GlobalTraceOperation } from "@/shared/globalTraceTypes";

export const MAX_OPERATIONS = 500;
export const DIAGNOSTICS_STORAGE_KEY = "openseo_global_diagnostics_enabled";
export const OPERATIONS_STORAGE_KEY = "openseo_global_trace_operations";

/**
 * Secure-context-safe ID generation for trace/operation records.
 * `crypto.randomUUID` only exists in secure contexts (HTTPS / localhost);
 * on plain-HTTP origins it is undefined and would throw, which must never
 * break the underlying SEO operation being traced.
 */
export function safeTraceId(): string {
  try {
    if (
      typeof crypto !== "undefined" &&
      typeof crypto.randomUUID === "function"
    ) {
      return crypto.randomUUID();
    }
  } catch {
    // Fall through to the Math.random fallback below.
  }
  return `trace_${Date.now().toString(36)}_${Math.floor(
    Math.random() * 0xffffff,
  ).toString(36)}`;
}

export function getInitialDiagnosticsEnabled(): boolean {
  if (typeof window === "undefined") return true;
  try {
    const stored = window.localStorage.getItem(DIAGNOSTICS_STORAGE_KEY);
    if (stored !== null) {
      return stored === "true";
    }
  } catch {
    // Ignore localStorage access errors
  }
  return true;
}

function isOperationArray(val: unknown): val is GlobalTraceOperation[] {
  return Array.isArray(val);
}

export function getInitialOperations(): GlobalTraceOperation[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(OPERATIONS_STORAGE_KEY);
    if (raw) {
      const parsed: unknown = JSON.parse(raw);
      if (isOperationArray(parsed)) {
        return parsed.slice(0, MAX_OPERATIONS);
      }
    }
  } catch {
    // Ignore localStorage access errors
  }
  return [];
}

export function saveOperationsToStorage(ops: GlobalTraceOperation[]) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(OPERATIONS_STORAGE_KEY, JSON.stringify(ops));
  } catch {
    // Ignore localStorage access errors
  }
}

export function saveDiagnosticsEnabledToStorage(enabled: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(DIAGNOSTICS_STORAGE_KEY, String(enabled));
  } catch {
    // Ignore localStorage access errors
  }
}

export function isOperationArrayGuard(
  val: unknown,
): val is GlobalTraceOperation[] {
  return isOperationArray(val);
}
