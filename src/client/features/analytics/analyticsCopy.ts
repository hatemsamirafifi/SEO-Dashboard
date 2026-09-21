import { ANALYTICS_RANGES, type AnalyticsRange } from "@/types/schemas/ga4";

export const ANALYTICS_RANGE_OPTIONS: Array<{
  value: AnalyticsRange;
  label: string;
}> = [
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_28_days", label: "Last 28 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
];

export function assertAnalyticsRangesComplete(): void {
  if (ANALYTICS_RANGE_OPTIONS.length !== ANALYTICS_RANGES.length) {
    throw new Error("Analytics range options drifted from the schema ranges");
  }
}

/** Percent change with sign and one decimal; null (no baseline) renders as
 *  an em dash so a missing previous period is never shown as zero. */
export function formatPctChange(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return "\u2014";
  const sign = pct < 0 ? "-" : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Absolute delta with sign; zero stays a plain zero. */
export function formatDelta(change: number): string {
  if (change === 0) return "0";
  const sign = change < 0 ? "-" : "+";
  return `${sign}${Math.abs(change)}`;
}

export type AnalyticsSyncFailureKind =
  | "quota-failed"
  | "perm-failed"
  | "sync-failed";

/** Classify a `Ga4SyncService` error (`"${class}: ${message}"`) for the
 *  distinct failure states (final-plan §17). Returns null when there is no
 *  failure to surface. */
export function syncFailureKind(
  error: string | null | undefined,
): AnalyticsSyncFailureKind | null {
  if (!error) return null;
  if (error.startsWith("QUOTA_EXHAUSTED")) return "quota-failed";
  if (
    error.startsWith("OAUTH_TOKEN_FAILURE") ||
    error.startsWith("PERMISSION_DENIED") ||
    error.startsWith("PROPERTY_NOT_FOUND")
  )
    return "perm-failed";
  return "sync-failed";
}

export type AnalyticsCoverageStatus = "complete" | "partial" | "none";

export type AnalyticsPageView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not-connected" }
  | { kind: "syncing" }
  | { kind: "quota-failed"; message: string }
  | { kind: "perm-failed"; message: string }
  | { kind: "sync-failed"; message: string }
  | { kind: "no-data" }
  | { kind: "partial"; coveredThrough: string | null }
  | { kind: "ok" };

/** Fold connection, sync, failure-class, coverage, and row presence into one
 *  distinct page state. Precedence is load-bearing: provider failure is an
 *  explicit failure line, never zero data (invariant 5). */
export function toAnalyticsPageView(input: {
  connectionLoading: boolean;
  syncLoading: boolean;
  connectionError: boolean;
  syncError: boolean;
  connected: boolean;
  isRunning: boolean;
  latestSyncError: string | null;
  coverageStatus: AnalyticsCoverageStatus;
  hasRows: boolean;
  coveredThrough?: string | null;
}): AnalyticsPageView {
  if (input.connectionLoading || input.syncLoading) return { kind: "loading" };
  if (input.connectionError || input.syncError) return { kind: "error" };
  if (!input.connected) return { kind: "not-connected" };
  if (input.isRunning) return { kind: "syncing" };
  const failure = syncFailureKind(input.latestSyncError);
  if (failure && input.latestSyncError) {
    return {
      kind: failure,
      message: input.latestSyncError,
    } as AnalyticsPageView;
  }
  if (input.coverageStatus === "none" || !input.hasRows)
    return { kind: "no-data" };
  if (input.coverageStatus === "partial")
    return { kind: "partial", coveredThrough: input.coveredThrough ?? null };
  return { kind: "ok" };
}

/** Coverage badge text. Partial coverage names the covered-through date so
 *  truncated windows are never mistaken for full ones (§9.5). */
export function coverageBadge(input: {
  status: AnalyticsCoverageStatus;
  coveredThrough: string | null;
}): string {
  if (input.status === "complete") return "Complete";
  if (input.status === "partial") {
    return input.coveredThrough
      ? `Partial data through ${input.coveredThrough}`
      : "Partial data";
  }
  return "No coverage";
}
