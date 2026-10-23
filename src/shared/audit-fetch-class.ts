// Page fetch taxonomy, declared once so the SQLite and Postgres columns, the
// MCP filter, and the CrawledPageResult types can't drift apart.

/**
 * How a page fetch resolved. "blocked" = WAF/bot challenge stood in the way;
 * "rate_limited" = a 429 (possibly after retries) prevented the crawler from
 * reading the page; "error" = the fetch itself failed (network/timeout).
 */
export const PAGE_FETCH_CLASSES = [
  "ok",
  "blocked",
  "rate_limited",
  "error",
] as const;

export type PageFetchClass = (typeof PAGE_FETCH_CLASSES)[number];

/**
 * Why a fetch produced no usable response. Synced with the audit_pages
 * failure_reason column. Null on every page that actually responded.
 * Covers transport-level failures only; blocking and rate limiting are
 * captured by the fetch class itself.
 */
export const PAGE_FAILURE_REASONS = ["network_error", "fetch_timeout"] as const;

export type PageFailureReason = (typeof PAGE_FAILURE_REASONS)[number];

/**
 * How completely an HTML page was extracted by the static crawler.
 *
 * The audit must never treat uncertain extraction as a confirmed SEO
 * verdict: finding checks whose evidence would depend on content that may
 * not have been extracted are suppressed for the non-complete states.
 * NOT_EXTRACTED covers rows where content extraction was not applicable
 * (redirect hops, non-HTML documents, 4xx/5xx responses).
 */
export const EXTRACTION_STATES = [
  "STATIC_COMPLETE",
  "STATIC_PARTIAL",
  "RENDERING_REQUIRED",
  "ACCESS_BLOCKED",
  "EXTRACTION_FAILED",
  "NOT_EXTRACTED",
] as const;

export type ExtractionState = (typeof EXTRACTION_STATES)[number];

/**
 * Terminal audit outcomes. Any audit whose crawl left URLs unread
 * (blocked/failed/rate-limited/capped) or unrendered reports
 * completed_partial — full success is never claimed for incomplete
 * coverage. cancelled preserves per-page states (D8) and partial metrics.
 */
export const AUDIT_STATUSES = [
  "running",
  "completed",
  "failed",
  "cancelled",
  "completed_partial",
] as const;

export type AuditStatus = (typeof AUDIT_STATUSES)[number];
