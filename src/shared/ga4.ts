export const GA4_OAUTH_PROVIDER_ID = "google-analytics";

export const GA4_OAUTH_SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/analytics.readonly",
] as const;

/** R2 cache TTL for GA4 report results (final-plan §9.2: 24h ga4:* family). */
export const GA4_CACHE_TTL_SECONDS = 24 * 60 * 60;
