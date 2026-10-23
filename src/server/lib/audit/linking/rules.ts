import { normalizeUrl } from "@/server/lib/audit/url-utils";
import type { LinkingPage } from "./types";

export const DEEP_PAGE_DEPTH = 5;
export const MIN_PAGES_FOR_STRUCTURE = 10;

const UTILITY_PATH_PATTERN =
  /(?:^|\/)(?:cart|checkout|account|login|signin|signup|register|search|wishlist|compare|orders?|profile|logout|password|address|payment|thank-you|thankyou|admin|wp-admin)(?:\/|$)/i;

export function isOkHtmlPage(page: LinkingPage): boolean {
  return (
    page.fetchClass === "ok" &&
    page.statusCode !== null &&
    page.statusCode >= 200 &&
    page.statusCode < 300 &&
    page.extractionState !== "NOT_EXTRACTED"
  );
}

function effectiveCanonical(page: LinkingPage): string | null {
  return page.canonicalUrl ?? page.headerCanonicalUrl;
}

function isCanonicalSelf(page: LinkingPage): boolean {
  const canonical = effectiveCanonical(page);
  return !canonical || canonical === page.url;
}

export function isIndexablePage(page: LinkingPage): boolean {
  return isOkHtmlPage(page) && page.isIndexable && isCanonicalSelf(page);
}

export function isUtilityUrl(url: string): boolean {
  try {
    return UTILITY_PATH_PATTERN.test(new URL(url).pathname);
  } catch {
    return false;
  }
}

export function isStartUrl(url: string, startUrl: string): boolean {
  return url === (normalizeUrl(startUrl) ?? startUrl);
}
