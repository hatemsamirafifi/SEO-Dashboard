import type { SEODataRequest } from "../types";
import {
  GoogleAdsPlannerKeywordRepository,
  type GoogleAdsPlannerKeywordMatches,
  type GoogleAdsPlannerStoredGroup,
} from "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository";
import { GOOGLE_ADS_PLANNER_CACHE_CONTRACT } from "./google-ads-planner-access";
import { GOOGLE_ADS_DEFAULT_PLANNER_NETWORK } from "@/server/lib/googleAdsPlanner";
import { getCacheTtl } from "../config";

/**
 * Read keyword metrics from the fresh Google Ads planner observation
 * tables and rebuild the first-party envelope over them. Returns null when
 * the planner path cannot serve (no fresh observation, nothing covered, or
 * an always-fresh request) so the caller falls through to the legacy DFS
 * table read.
 *
 * Freshness: maxAgeSeconds 0 means the caller wants a live answer — stored
 * observations never qualify. undefined falls back to the keyword_metrics
 * TTL. The bound is applied against the observation's `sourceFetchedAt`,
 * which only an actual fresh planner fetch advances.
 *
 * Coverage: the stored canonical groups plus variant memberships resolve
 * every keyword they cover; requested keywords neither are nor cover stay
 * in the envelope's `missingKeywords` — never fabricated per-variant rows.
 * An empty coverage (no record at all) cannot serve and falls through.
 */
export async function getInternalPlannerMetricsEnvelope(
  request: SEODataRequest,
  projectId: string,
  keywords: string[],
  locationCode: number,
  languageCode: string,
): Promise<unknown> {
  const maxAgeSeconds =
    request.maxAgeSeconds ?? (await getCacheTtl("keyword_metrics"));
  if (!Number.isFinite(maxAgeSeconds) || maxAgeSeconds <= 0) return null;
  const minSourceFetchedAt = new Date(
    Date.now() - maxAgeSeconds * 1000,
  ).toISOString();

  const network = GOOGLE_ADS_DEFAULT_PLANNER_NETWORK;

  const observation =
    await GoogleAdsPlannerKeywordRepository.getLatestMetricsObservation({
      projectId,
      organizationId: request.billingCustomer.organizationId,
      locationCode,
      languageCode,
      network,
      contractVersion: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
      minSourceFetchedAt,
    });
  if (!observation) return null;

  const matches: GoogleAdsPlannerKeywordMatches =
    await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(
      {
        projectId,
        customerId: observation.customerId,
        locationCode,
        languageCode,
        network,
        contractVersion: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
      },
      keywords,
      { minSourceFetchedAt: observation.sourceFetchedAt },
    );

  // Unique canonical groups covering the request: a keyword that is a
  // variant shares its canonical group's record — the record list stays one
  // per planning group, never one per requested literal.
  const covered = new Map<string, GoogleAdsPlannerStoredGroup>();
  for (const stored of matches.canonical.values())
    covered.set(stored.record.keyword, stored);
  for (const stored of matches.variants.values())
    covered.set(stored.record.keyword, stored);
  if (covered.size === 0) return null;

  const normalizedKeywords = new Set(
    keywords.map((k) => k.trim().toLowerCase()).filter(Boolean),
  );
  const missingKeywords = [...normalizedKeywords].filter(
    (keyword) =>
      !matches.canonical.has(keyword) && !matches.variants.has(keyword),
  );

  return {
    source: "google_ads",
    fetchedAt: observation.sourceFetchedAt,
    currencyCode: observation.currencyCode,
    network,
    customerId: observation.customerId,
    loginCustomerId: observation.loginCustomerId,
    missingKeywords,
    malformedKeywords: observation.malformedKeywordCount,
    duplicateKeywords: observation.duplicateKeywordCount,
    truncated: observation.truncated,
    partial: observation.partial,
    ideas: [],
    keywords: [...covered.values()].map((stored) => stored.record),
  };
}
