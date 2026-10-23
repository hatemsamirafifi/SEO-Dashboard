/**
 * Finalize-time truth helpers for site audits.
 *
 * An audit may only claim full success when its frontier drained and every
 * fetched page was fully analyzable. Anything else reports completed_partial
 * with the deficit visible in the URL counters, and a user-initiated cancel
 * always reports cancelled while preserving per-page states (D8).
 */
import type { AuditStatus } from "@/shared/audit-fetch-class";

export const FINAL_AUDIT_STATUSES = [
  "completed",
  "completed_partial",
  "cancelled",
] as const;

export type FinalAuditStatus = (typeof FINAL_AUDIT_STATUSES)[number];

/**
 * Same bucket partition the repository's SQL aggregation encodes (see
 * AuditRepository.getAuditPageCounters): fetch classes partition the fetched
 * pages, and rendering_required overlaps "ok" so it lives in its own bucket
 * instead of urls_analyzed.
 */
export type AuditUrlCounters = {
  urlsDiscovered: number;
  urlsFetched: number;
  urlsAnalyzed: number;
  urlsBlocked: number;
  urlsFailed: number;
  urlsSkipped: number;
  urlsRenderingRequired: number;
  urlsExtractionComplete: number;
};

export const ZERO_URL_COUNTERS: AuditUrlCounters = {
  urlsDiscovered: 0,
  urlsFetched: 0,
  urlsAnalyzed: 0,
  urlsBlocked: 0,
  urlsFailed: 0,
  urlsSkipped: 0,
  urlsRenderingRequired: 0,
  urlsExtractionComplete: 0,
};

export function hasCoverageDeficit(params: {
  counters: AuditUrlCounters;
  /** URLs that entered the frontier but were never fetched. */
  frontierRemaining: number;
}): boolean {
  const { counters, frontierRemaining } = params;
  return (
    counters.urlsBlocked > 0 ||
    counters.urlsFailed > 0 ||
    counters.urlsSkipped > 0 ||
    counters.urlsRenderingRequired > 0 ||
    frontierRemaining > 0
  );
}

export function resolveFinalStatus(params: {
  cancelRequested: boolean;
  deficit: boolean;
}): FinalAuditStatus {
  if (params.cancelRequested) return "cancelled";
  return params.deficit ? "completed_partial" : "completed";
}

/**
 * Share of analyzed (fetchClass ok, non-rendering-required) pages whose
 * static extraction completed. Null when nothing was analyzable — an empty
 * denominator must never read as 0% or 100%.
 *
 * This is the extraction-level evidence coverage: a page counts as covered
 * when its extraction completed (STATIC_COMPLETE). Per-tier evidence
 * coverage (structured-data / html / api) is a finer measure that Phase 4's
 * schema generator produces once per-field evidence is persisted; until
 * then this ratio is the honest, persisted coverage signal.
 */
export function extractionCompleteRatio(
  counters: AuditUrlCounters,
): number | null {
  const analyzed = counters.urlsAnalyzed + counters.urlsRenderingRequired;
  if (analyzed === 0) return null;
  return counters.urlsExtractionComplete / analyzed;
}

/**
 * URLs the user never got: blocked, failed, rate-limited, capped out of the
 * frontier, plus unrenderable in-place. Only used for display; status and
 * counters are the persisted truth.
 */
export function enumerateDeficits(params: {
  counters: AuditUrlCounters;
  frontierRemaining: number;
}): { key: string; count: number }[] {
  const { counters, frontierRemaining } = params;
  const deficits: { key: string; count: number }[] = [];
  if (counters.urlsBlocked > 0)
    deficits.push({ key: "blocked", count: counters.urlsBlocked });
  if (counters.urlsFailed > 0)
    deficits.push({ key: "failed", count: counters.urlsFailed });
  if (counters.urlsSkipped > 0)
    deficits.push({ key: "rate_limited", count: counters.urlsSkipped });
  if (counters.urlsRenderingRequired > 0)
    deficits.push({
      key: "rendering_required",
      count: counters.urlsRenderingRequired,
    });
  if (frontierRemaining > 0)
    deficits.push({ key: "not_crawled", count: frontierRemaining });
  return deficits;
}

export function isAuditStatus(value: string): value is AuditStatus {
  return [
    "running",
    "completed",
    "failed",
    "cancelled",
    "completed_partial",
  ].includes(value);
}
