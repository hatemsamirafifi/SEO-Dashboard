import type { SerpProviderError } from "./types";

/**
 * Central retry policy for SERP provider calls.
 *
 * One classifier decides whether a provider failure is worth retrying.
 * Adapters normalize provider-specific failures into `SerpProviderError`
 * (via `code` + `deterministic`); this module owns the single retryable /
 * non-retryable decision so it is never scattered across DataForSEO, Serper
 * and Zenserp call sites.
 *
 * Rules:
 * - Ordinary operational failures (timeout, connection reset, DNS/transport,
 *   HTTP 408/429/5xx, temporary malformed upstream response) are retryable.
 * - Retries are prevented ONLY when retrying the same request cannot succeed
 *   without an external configuration/account/billing change: invalid
 *   credentials, quota exhaustion, paused account, provider disabled,
 *   unsupported request configuration.
 * - RATE_LIMITED (HTTP 429 without quota evidence) is retryable and distinct
 *   from QUOTA_EXHAUSTED (explicit quota/credit exhaustion, non-retryable).
 */

/** Retryable provider failure categories (temporary/operational). */
const RETRYABLE_CODES = new Set([
  "NETWORK_OR_TIMEOUT",
  "PROVIDER_UNAVAILABLE",
  "UPSTREAM_UNAVAILABLE",
  "RATE_LIMITED",
  "TEMPORARY_UNAVAILABLE",
  "MALFORMED_JSON",
  "INVALID_PROVIDER_RESPONSE",
  "TRANSIENT_UPSTREAM",
  "PROVIDER_FAILURE",
]);

/**
 * Deterministic failures — retrying cannot succeed without an external
 * configuration, credential, account, or billing change.
 */
const NON_RETRYABLE_CODES = new Set([
  "AUTH_FAILED",
  "DATAFORSEO_AUTH_FAILED",
  "INVALID_CREDENTIALS",
  "INVALID_API_KEY",
  "QUOTA_EXHAUSTED",
  "CREDITS_UNAVAILABLE",
  "DATAFORSEO_ACCOUNT_PAUSED",
  "ACCOUNT_PAUSED",
  "PAYMENT_REQUIRED",
  "PROVIDER_DISABLED",
  "MISSING_CREDENTIALS",
  "INVALID_CONFIGURATION",
  "UNSUPPORTED_DEVICE",
  "UNSUPPORTED_LOCATION",
  // Pagination outcome, not a provider failure: the provider crawled what it
  // could and stopped. Retrying the same request cannot deepen the result —
  // the resolver falls through to the next provider instead.
  "INSUFFICIENT_DEPTH",
]);

export type ProviderFailureClassification = {
  /** Canonical failure category (the provider error code). */
  category: string;
  /** True when the same provider request may succeed if retried. */
  retryable: boolean;
};

/**
 * The single classification for provider failures. `deterministic` on
 * `SerpProviderError` is set by the provider adapters; it means "the provider
 * told us this exact request cannot succeed" (401/403 auth, 40201 paused
 * account, explicit quota exhaustion) — the opposite of a transient failure.
 */
export function classifyProviderFailure(
  error: Pick<SerpProviderError, "code" | "deterministic">,
): ProviderFailureClassification {
  // Adapters flag deterministic account/config failures; never retry those.
  if (error.deterministic) {
    return { category: error.code, retryable: false };
  }
  if (NON_RETRYABLE_CODES.has(error.code)) {
    return { category: error.code, retryable: false };
  }
  if (RETRYABLE_CODES.has(error.code)) {
    return { category: error.code, retryable: true };
  }
  // Unknown codes: only retry when the adapter did not flag them
  // deterministic. Defaulting to retryable keeps ordinary provider hiccups
  // from turning into user-visible failures.
  return { category: error.code, retryable: true };
}

export const MAX_PROVIDER_RETRIES = 5;

/** Clamp a configured retries value to the supported 0-5 range. */
export function clampProviderRetries(value: number | null | undefined): number {
  if (typeof value !== "number" || Number.isNaN(value)) return 2;
  return Math.min(MAX_PROVIDER_RETRIES, Math.max(0, Math.floor(value)));
}

/**
 * Backoff between retries: linear 500ms * attempt, capped. For HTTP 429 with a
 * Retry-After header the provider-supplied wait is respected within a safe
 * maximum (capped at RETRY_AFTER_MAX_MS).
 */
const BASE_RETRY_BACKOFF_MS = 500;
const MAX_RETRY_BACKOFF_MS = 4_000;
export const RETRY_AFTER_MAX_MS = 10_000;

export function retryBackoffMs(attempt: number): number {
  return Math.min(MAX_RETRY_BACKOFF_MS, BASE_RETRY_BACKOFF_MS * attempt);
}

/**
 * Parse a Retry-After header (seconds or HTTP-date) into a bounded wait in ms.
 * Returns null when absent, unparsable, or beyond the safe maximum.
 */
export function boundedRetryAfterMs(
  header: string | null | undefined,
  now = Date.now(),
): number | null {
  if (!header) return null;
  const trimmed = header.trim();
  const asSeconds = Number(trimmed);
  if (Number.isFinite(asSeconds) && asSeconds >= 0) {
    const ms = asSeconds * 1_000;
    return ms <= RETRY_AFTER_MAX_MS ? ms : RETRY_AFTER_MAX_MS;
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    const ms = asDate - now;
    if (ms <= 0) return 0;
    return Math.min(ms, RETRY_AFTER_MAX_MS);
  }
  return null;
}

/**
 * Cancellable wait used between provider retries. Resolves after `ms`, or
 * rejects immediately (AbortError) when the caller's abort signal fires —
 * cancellation must interrupt backoff and prevent the next request.
 */
export function waitWithCancellation(
  ms: number,
  signal?: AbortSignal,
): Promise<void> {
  if (ms <= 0) {
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    }
    return Promise.resolve();
  }
  return new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(
        signal?.reason ??
          new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    if (signal) {
      if (signal.aborted) {
        clearTimeout(timer);
        onAbort();
        return;
      }
      signal.addEventListener("abort", onAbort, { once: true });
    }
  });
}