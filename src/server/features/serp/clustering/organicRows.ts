import { canonicalUrl } from "@/shared/intelligence";
import type { SerpOrganicSnapshotRow } from "./SerpOrganicSnapshotRepository";

/**
 * Observed organic results of one rank-check call, mapped to storage rows
 * (spec 019). The rows carry what the provider returned - no enrichment, no
 * inference.
 */

type ObservedOrganicEntry = {
  position: number;
  title?: string | null;
  url: string;
  domain?: string | null;
};

/** The most organic rows kept per keyword and device. */
const MAX_ORGANIC_ROWS = 10;

export function organicRowsForResult(input: {
  projectId: string;
  configId: string;
  runId: string;
  trackingKeywordId: string;
  keyword: string;
  device: "desktop" | "mobile";
  provider: string;
  searchEngine?: string;
  locationCode: number;
  locationName: string | null;
  languageCode: string;
  observedAt: string;
  inspectedDepth: number;
  organicResults: ObservedOrganicEntry[];
}): SerpOrganicSnapshotRow[] {
  const entries = input.organicResults
    .filter((entry) => entry.url.length > 0)
    .slice(0, MAX_ORGANIC_ROWS);
  // "full" means the provider returned the whole inspected top-10 set; a
  // shorter set is recorded as partial instead of pretending it is a page.
  const expected = Math.min(
    Math.max(input.inspectedDepth, 1),
    MAX_ORGANIC_ROWS,
  );
  const coverageStatus =
    entries.length >= expected ? ("full" as const) : ("partial" as const);
  return entries.map((entry) => ({
    projectId: input.projectId,
    configId: input.configId,
    runId: input.runId,
    trackingKeywordId: input.trackingKeywordId,
    keyword: input.keyword,
    searchEngine: input.searchEngine ?? "google",
    locationCode: input.locationCode,
    locationName: input.locationName,
    languageCode: input.languageCode,
    device: input.device,
    position: entry.position,
    url: entry.url,
    normalizedUrl: canonicalUrl(entry.url),
    title: entry.title ?? null,
    domain: entry.domain ?? null,
    provider: input.provider,
    coverageStatus,
    observedAt: input.observedAt,
  }));
}
