/** Google Ads integration constants (Phase 1: OAuth + account discovery).
 *  Mirrors @/shared/ga4 — kept in `shared` so server (auth config, Ads client)
 *  and (later) client-side connect UI can reference them without pulling in
 *  server-only modules. */

export const GOOGLE_ADS_OAUTH_PROVIDER_ID = "google-ads";

/** Google Ads API uses the full `adwords` scope: no read-only variant exists.
 *  Read-only behavior is enforced at the client layer (bounded, explicit
 *  discovery/report reads; no mutation methods are offered at all). */
export const GOOGLE_ADS_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/adwords",
] as const;

/** Pinned API version for every REST call (googleads.googleapis.com). */
export const GOOGLE_ADS_API_VERSION = "v26";

export const GOOGLE_ADS_API_HOST = "googleads.googleapis.com";

/** Google Ads customer IDs are exactly ten digits (e.g. "1234567890").
 *  The `customerId` field is a protobuf int64 rendered as a string; Google
 *  never issues values outside the ten-digit MCC range. */
export const GOOGLE_ADS_CUSTOMER_ID_PATTERN = /^\d{10}$/;

/** Resource-name forms returned by listAccessibleCustomers and the
 *  customer.client_customer field. */
export const GOOGLE_ADS_CUSTOMER_RESOURCE_PATTERN =
  /^customers\/\d{10}(?:\/customerClients\/\d{10})?$/;

/** Display formatting only: 123-456-7890. */
export function formatGoogleAdsCustomerId(customerId: string): string {
  return `${customerId.slice(0, 3)}-${customerId.slice(3, 6)}-${customerId.slice(6)}`;
}

/** Strictly normalizes user-facing customer-ID input to the bare ten-digit
 *  form. Hyphens and whitespace are accepted as separators ("123 456 7890",
 *  "123-456-7890"); any other character (letters, dots, punctuation) makes the
 *  whole value invalid — never silently dropped. Returns null when invalid. */
export function normalizeGoogleAdsCustomerId(value: string): string | null {
  const trimmed = value.trim();
  if (!/^[\d\s-]+$/.test(trimmed)) return null;
  const digits = trimmed.replace(/\s|-/g, "");
  return GOOGLE_ADS_CUSTOMER_ID_PATTERN.test(digits) ? digits : null;
}
