import type { PageFetchClass } from "@/shared/audit-fetch-class";

// Challenge pages that can arrive with a 200, as heavy JS WAF suites serve
// them back: Cloudflare's interstitial, and SiteGround's sgcaptcha redirect.
const CHALLENGE_2XX =
  /<title>\s*(?:just a moment\.\.\.|attention required! \| cloudflare)\s*<\/title>|\/\.well-known\/sgcaptcha\//i;

/**
 * Markers of a bot-mitigation challenge page. We classify these honestly as
 * "blocked" instead of recording the challenge HTML as if it were the page.
 */
const CHALLENGE_BODY_MARKERS = [
  "just a moment...",
  "challenge-platform",
  "cf-browser-verification",
  "attention required! | cloudflare",
  "verifying you are human",
];

/**
 * Classify how a page fetch resolved.
 *
 * Order matters: a final 429 means rate limiting (checked first), and a
 * Cloudflare rate-limiting rule also sets the cf-mitigated header, so 429
 * must win before the challenge check.
 */
export function classifyFetch(
  statusCode: number,
  mitigated: boolean,
  bodySnippet: string,
): PageFetchClass {
  if (statusCode === 0) return "error";
  if (statusCode === 429) return "rate_limited";
  if (mitigated) return "blocked";
  if (statusCode === 401 || statusCode === 403) return "blocked";
  // Real pages aren't served as 202 Accepted; bot challenges are (SiteGround,
  // AWS WAF).
  if (statusCode === 202) return "blocked";
  if (statusCode >= 200 && statusCode < 300 && CHALLENGE_2XX.test(bodySnippet))
    return "blocked";
  if (statusCode === 503) {
    const snippet = bodySnippet.toLowerCase();
    if (CHALLENGE_BODY_MARKERS.some((marker) => snippet.includes(marker))) {
      return "blocked";
    }
  }
  return "ok";
}
