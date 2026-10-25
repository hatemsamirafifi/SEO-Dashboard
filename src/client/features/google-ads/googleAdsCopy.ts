import type { GoogleAdsCoverageLike } from "./googleAdsTypes";

/** Google Ads page copy: date windows, currency-aware formatting, page-state
 *  classification and comparison-gate copy. Pure functions only. */

export type GoogleAdsRangePreset =
  | "last_7_days"
  | "last_28_days"
  | "last_30_days"
  | "last_90_days"
  | "custom";

export const GOOGLE_ADS_RANGE_OPTIONS: Array<{
  value: GoogleAdsRangePreset;
  label: string;
}> = [
  { value: "last_7_days", label: "Last 7 days" },
  { value: "last_28_days", label: "Last 28 days" },
  { value: "last_30_days", label: "Last 30 days" },
  { value: "last_90_days", label: "Last 90 days" },
  { value: "custom", label: "Custom" },
];

const PRESET_DAYS: Record<Exclude<GoogleAdsRangePreset, "custom">, number> = {
  last_7_days: 7,
  last_28_days: 28,
  last_30_days: 30,
  last_90_days: 90,
};

export type GoogleAdsDateWindow = { startDate: string; endDate: string };

/** Resolves the toolbar selection into a concrete YYYY-MM-DD window. `today`
 *  is injectable for deterministic tests; the last N days are inclusive. */
export function resolveGoogleAdsWindow(input: {
  preset: GoogleAdsRangePreset;
  startDate?: string | null;
  endDate?: string | null;
  today?: string;
}): GoogleAdsDateWindow {
  if (
    input.preset === "custom" &&
    input.startDate &&
    input.endDate &&
    input.startDate <= input.endDate
  ) {
    return { startDate: input.startDate, endDate: input.endDate };
  }
  const today = input.today ?? new Date().toISOString().slice(0, 10);
  const days = input.preset === "custom" ? 28 : PRESET_DAYS[input.preset];
  const endDate = today;
  const startDate = new Date(
    Date.parse(`${endDate}T00:00:00.000Z`) - (days - 1) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);
  return { startDate, endDate };
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;

/** Currency-aware amount. `null` renders as an em dash â€” missing data is
 *  never shown as a zero. An absent or non-ISO currency code degrades to a
 *  bare decimal amount so the number stays honest without a currency label. */
export function formatAdsCurrency(
  amount: number | null,
  currencyCode: string | null | undefined,
): string {
  if (amount === null || Number.isNaN(amount)) return "\u2014";
  const code =
    currencyCode && CURRENCY_CODE_PATTERN.test(currencyCode)
      ? currencyCode
      : null;
  if (code) {
    try {
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: code,
      }).format(amount);
    } catch {
      // Invalid currency codes degrade to the decimal fallback below.
    }
  }
  return amount.toFixed(2);
}

export function formatCount(value: number | null): string {
  if (value === null || Number.isNaN(value)) return "\u2014";
  return new Intl.NumberFormat("en-US").format(value);
}

/** A stored ratio (clicks / impressions) shown as a percentage. `null` â€”
 *  a ratio with missing components â€” renders as an em dash, never zero. */
export function formatPercentRatio(ratio: number | null): string {
  if (ratio === null || Number.isNaN(ratio)) return "\u2014";
  return `${(ratio * 100).toFixed(2)}%`;
}

export function formatRoas(roas: number | null): string {
  if (roas === null || Number.isNaN(roas)) return "\u2014";
  return `${roas.toFixed(2)}x`;
}

/** Percent change with sign and one decimal; `null` (no baseline) renders as
 *  an em dash so a missing previous period is never shown as zero. */
export function formatPctChange(pct: number | null): string {
  if (pct === null || Number.isNaN(pct)) return "\u2014";
  const sign = pct < 0 ? "-" : "+";
  return `${sign}${Math.abs(pct).toFixed(1)}%`;
}

/** Absolute delta with sign; zero stays a plain zero. */
export function formatDelta(
  change: number | null,
  format?: (value: number) => string,
): string {
  if (change === null) return "\u2014";
  if (change === 0) return "0";
  const sign = change < 0 ? "-" : "+";
  const formatted = format ? format(Math.abs(change)) : `${Math.abs(change)}`;
  return `${sign}${formatted}`;
}

// ---------------------------------------------------------------------------
// Page-state classification
// ---------------------------------------------------------------------------

/** Failure classes that indicate Google quota / rate-limit exhaustion. */
const QUOTA_ERROR_CLASSES = new Set([
  "QUOTA_EXHAUSTED",
  "QUOTA_TEMPORARILY_EXHAUSTED",
  "RATE_LIMITED",
]);

/** Failure classes that indicate auth, OAuth, permission or Google Cloud
 *  API-access-level restrictions: they need reconnection or access work. */
const PERM_ERROR_CLASSES = new Set([
  "OAUTH_TOKEN_FAILURE",
  "OAUTH_TOKEN_INVALID",
  "PERMISSION_DENIED",
  "API_ACCESS_RESTRICTED",
  "MISSING_CREDENTIALS",
  "MISSING_SCOPE",
  "CUSTOMER_NOT_FOUND",
]);

export type GoogleAdsSyncFailureKind =
  | "quota-failed"
  | "perm-failed"
  | "sync-failed";

/** Classifies a `GoogleAdsSyncRunPublic` failure for the distinct failure
 *  states (master plan Phase 4). Returns null when there is nothing failed. */
export function googleAdsSyncFailureKind(
  errorClass: string | null | undefined,
  errorMessage: string | null | undefined,
): GoogleAdsSyncFailureKind | null {
  if (!errorClass && !errorMessage) return null;
  if (errorClass && QUOTA_ERROR_CLASSES.has(errorClass)) {
    return "quota-failed";
  }
  if (errorClass && PERM_ERROR_CLASSES.has(errorClass)) {
    return "perm-failed";
  }
  const message = `${errorClass ?? ""} ${errorMessage ?? ""}`.toLowerCase();
  if (message.includes("quota") || message.includes("rate limit")) {
    return "quota-failed";
  }
  if (
    message.includes("oauth") ||
    message.includes("permission") ||
    message.includes("access level") ||
    message.includes("not connected") ||
    message.includes("credentials") ||
    message.includes("scope")
  ) {
    return "perm-failed";
  }
  return "sync-failed";
}

/** Failure line shown with the run; the safe class comes first when present. */
export function googleAdsFailureMessage(
  errorClass: string | null,
  errorMessage: string | null,
): string {
  return (
    [errorClass, errorMessage].filter(Boolean).join(": ") || "Sync failed."
  );
}

/** The latest completed sync is fresh within 48 hours. */
export function isGoogleAdsSyncFresh(
  completedAt: string | null,
  now: number,
): boolean {
  if (!completedAt) return false;
  const parsed = Date.parse(completedAt);
  if (Number.isNaN(parsed)) return false;
  return now - parsed <= 48 * 60 * 60 * 1000;
}

export type GoogleAdsPageView =
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "not-connected" }
  | { kind: "syncing" }
  | { kind: "quota-failed"; message: string }
  | { kind: "perm-failed"; message: string }
  | { kind: "sync-failed"; message: string }
  | { kind: "no-data" }
  | { kind: "partial"; coveredThrough: string | null }
  | {
      kind: "stale";
      reason: "old-sync" | "failed-units";
      lastCompletedAt: string | null;
    }
  | { kind: "ok" };

export type GoogleAdsPageViewInput = {
  connectionLoading: boolean;
  connectionError: boolean;
  connected: boolean;
  activeRun: boolean;
  latestRun: {
    status: string;
    errorClass: string | null;
    errorMessage: string | null;
    completedAt: string | null;
  } | null;
  unitsFailed: number;
  coverageStatus: GoogleAdsCoverageLike["status"] | "none";
  coveredThrough: string | null;
  rowCount: number | null;
};

/** Folds connection, sync-latest-run and coverage into one distinct page
 *  state. Precedence is load-bearing: provider failure is an explicit
 *  failure line, never zero data, and a mixed coverage window is never
 *  presented as complete. */
export function toGoogleAdsPageView(
  input: GoogleAdsPageViewInput,
): GoogleAdsPageView {
  if (input.connectionLoading) return { kind: "loading" };
  if (input.connectionError) return { kind: "error" };
  if (!input.connected) return { kind: "not-connected" };
  if (input.activeRun) return { kind: "syncing" };

  if (input.latestRun?.status === "failed") {
    const failure = googleAdsSyncFailureKind(
      input.latestRun.errorClass,
      input.latestRun.errorMessage,
    );
    const message = googleAdsFailureMessage(
      input.latestRun.errorClass,
      input.latestRun.errorMessage,
    );
    if (failure === "quota-failed") {
      return {
        kind: "quota-failed",
        message: message || "The Google quota was exhausted.",
      };
    }
    if (failure === "perm-failed") {
      return { kind: "perm-failed", message: message || "Access failed." };
    }
    return { kind: "sync-failed", message: message || "Last sync failed." };
  }

  if (
    input.coverageStatus === "none" ||
    input.coverageStatus === "uncovered" ||
    (input.coverageStatus === "covered-empty" && input.rowCount === 0)
  ) {
    return { kind: "no-data" };
  }
  if (input.coverageStatus === "partial") {
    return { kind: "partial", coveredThrough: input.coveredThrough };
  }

  const lastCompletedAt = input.latestRun?.completedAt ?? null;
  if (!isGoogleAdsSyncFresh(lastCompletedAt, Date.now())) {
    return { kind: "stale", reason: "old-sync", lastCompletedAt };
  }
  if (input.unitsFailed > 0) {
    return { kind: "stale", reason: "failed-units", lastCompletedAt };
  }
  return { kind: "ok" };
}

// ---------------------------------------------------------------------------
// Coverage + comparison copy
// ---------------------------------------------------------------------------

export type GoogleAdsCoverageCopy = {
  label: string;
  tone: "success" | "warning" | "error";
};

export function coverageCopy(
  status: GoogleAdsCoverageLike["status"],
): GoogleAdsCoverageCopy {
  switch (status) {
    case "covered":
      return { label: "Complete", tone: "success" };
    case "covered-empty":
      return { label: "Complete (zero data)", tone: "success" };
    case "partial":
      return { label: "Partial coverage", tone: "warning" };
    case "uncovered":
      return { label: "No coverage", tone: "error" };
  }
}

/** Compare-gate copy for the equal-length preceding-window comparison. */
export function compareGateCopy(
  gate:
    | "ready"
    | "unequal_windows"
    | "partial_coverage"
    | "mixed_metric_date_basis",
): string | null {
  switch (gate) {
    case "ready":
      return null;
    case "unequal_windows":
      return "Comparison unavailable: the selected period and its preceding window are not equal in length.";
    case "partial_coverage":
      return "Comparison unavailable: one or both windows are not fully covered. Missing dates are excluded, never zeroed.";
    case "mixed_metric_date_basis":
      return "Comparison unavailable: this window mixes metrics with different date bases.";
  }
}

/** Stale-state banner copy. A stale window is still shown as data, with an
 *  explicit freshness warning instead of silent trust. */
export function staleBannerCopy(view: {
  reason: "old-sync" | "failed-units";
  lastCompletedAt: string | null;
}): string {
  if (view.reason === "failed-units") {
    return `Stale data: the last sync (recently) left some reporting units failed. Dates with failed units are excluded, never zeroed.`;
  }
  return view.lastCompletedAt
    ? `Stale data: the last successful sync completed more than 48 hours ago (${view.lastCompletedAt}). Run a sync in Settings to refresh.`
    : "Stale data: no sync has completed in the last 48 hours.";
}
