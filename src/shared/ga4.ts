export const GA4_OAUTH_PROVIDER_ID = "google-analytics";

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

/** R2 cache TTL for GA4 report results (final-plan §9.2: 24h ga4:* family). */
export const GA4_CACHE_TTL_SECONDS = 24 * 60 * 60;

/** Sentinel stored in canonical dimension columns instead of NULL so D1 and
 *  Postgres share identical uniqueness semantics (no NULLS NOT DISTINCT). */
export const GA4_NOT_SET_SENTINEL = "(not set)";

/** Long-tail aggregate marker for bounded grains (geo/technology). An
 *  "(other)" row holds summed metrics for every dimension value beyond the
 *  per-grain top-N — aggregated long-tail traffic, never missing data and
 *  never zero. The API may also return its own "(other)" row under extreme
 *  cardinality; sync folds it into the same tail aggregate. */
export const GA4_OTHER_DIMENSION = "(other)";

/** GA4 `sessionDefaultChannelGroup` value for organic traffic. The analytics
 *  Organic view is the acquisition reader filtered to this exact value
 *  (final-plan §9.6); no separate endpoint exists. */
export const ORGANIC_CHANNEL_GROUP = "Organic Search";

/** Canonical dimension form: trimmed verbatim value, sentinel when empty.
 *  Case is preserved for display fidelity. */
export function canonicalGa4Dimension(
  value: string | null | undefined,
): string {
  const trimmed = (value ?? "").trim();
  return trimmed === "" ? GA4_NOT_SET_SENTINEL : trimmed;
}

/** Shared landing-page normalizer (final-plan §9.3): sync, joins, and
 *  entityKey builders must agree on page identity. Strips query strings and
 *  fragments (UTM variants of one page collapse to one row); case and
 *  trailing slashes are preserved so genuinely different paths never merge. */
export function normalizeGa4LandingPage(
  value: string | null | undefined,
): string {
  const raw = (value ?? "").trim();
  if (raw === "") return GA4_NOT_SET_SENTINEL;
  const path = raw.split(/[?#]/, 1)[0].trim();
  if (path === "") return GA4_NOT_SET_SENTINEL;
  return path.startsWith("/") ? path : `/${path}`;
}
