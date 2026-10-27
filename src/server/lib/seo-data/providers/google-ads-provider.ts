/** Google Ads Keyword Planner provider — first-party keyword data through the
 *  connected project's Google Ads account (Phase 2 master plan).
 *
 *  This module is intentionally thin:
 *  - `supports()` is a synchronous market/claim gate (location-based, no
 *    connection I/O).
 *  - `get()` delegates to the per-project planner access layer, which owns
 *    connection resolution, targeting and the typed v26 client, and attaches
 *    `firstPartyError` provenance metadata to every error so the router can
 *    document a successful DataForSEO fallback without importing client
 *    internals.
 *
 *  Failure policy: no connection, a disabled flag or a market the planner
 *  cannot serve resolve to `ProviderUnavailableError` / `ProviderUnsupportedError`
 *  so the router keeps serving keyword flows through the fallback chain
 *  instead of breaking research.
 */
import type { SEODataProvider, SEODataRequest } from "../types";
import { getProviderFeatureFlags } from "../config";
import { ProviderUnavailableError, ProviderUnsupportedError } from "../errors";
import { LOCATION_OPTIONS } from "@/shared/keyword-locations";
import {
  fetchPlannerHistoricalMetrics,
  fetchPlannerKeywordIdeas,
  attachFirstPartyMeta,
} from "./google-ads-planner-access";

export type { GoogleAdsPlannerCacheIdentity } from "./google-ads-planner-access";
export {
  GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
  fetchPlannerHistoricalMetrics,
  fetchPlannerKeywordIdeas,
  getPlannerConnectionForBilling,
  resolvePlannerCacheIdentity,
  resetPlannerTargetMemoForTests,
} from "./google-ads-planner-access";

/** The country catalog is small and immutable; the claim gate runs on every
 *  request, so hash it once. */
const SUPPORTED_LOCATION_CODES = new Set(LOCATION_OPTIONS.map((o) => o.code));

/** The DFS keyword_ideas sources that stay DFS-owned even in supported
 *  markets: `related` and `suggestions` wrap keyword_data payloads the Ads
 *  planner cannot produce, `google_ads` is the DFS keywords_for_keywords
 *  contract for Google-Ads-only markets, and clickstream refinement is a
 *  DFS-only volume normalization. */
const DFS_KEYWORD_IDEAS_SOURCES = new Set([
  "related",
  "suggestions",
  "clickstream",
  "google_ads",
]);

/**
 * Google Ads Keyword Planner provider — free keyword research and historical
 * search volume via the per-project Google Ads connection.
 */
export function createGoogleAdsProvider(): SEODataProvider {
  return {
    name: "google_ads",

    supports(request: SEODataRequest): boolean {
      const isKeywordType =
        request.dataType === "keyword_ideas" ||
        request.dataType === "keyword_metrics";
      if (!isKeywordType) return false;

      // The claim gate is location-based: an unknown or missing location
      // code means the planner's geo target could never match the request's
      // market, so the enabled-flag default is NOT claimed silently.
      if (
        request.locationCode === undefined ||
        !SUPPORTED_LOCATION_CODES.has(request.locationCode)
      ) {
        return false;
      }

      const constraints = request.constraints ?? {};
      if (request.dataType === "keyword_ideas") {
        // The planner only serves seeded keyword ideas: DFS-owned sources and
        // clickstream refinement stay DFS.
        if (
          typeof constraints.source === "string" &&
          DFS_KEYWORD_IDEAS_SOURCES.has(constraints.source)
        ) {
          return false;
        }
        if (constraints.includeClickstreamData === true) return false;
      }
      if (
        request.dataType === "keyword_metrics" &&
        typeof constraints.locationName === "string"
      ) {
        // Location-name targeting is a DataForSEO capability; the planner
        // answers exact geo target constants only.
        return false;
      }
      return true;
    },

    async get(request: SEODataRequest): Promise<unknown> {
      const flags = await getProviderFeatureFlags();
      if (!flags.googleAdsEnabled) {
        throw attachFirstPartyMeta(
          new ProviderUnavailableError(
            "google_ads",
            "Google Ads is not enabled (GOOGLE_ADS_ENABLED=false)",
          ),
        );
      }

      switch (request.dataType) {
        case "keyword_ideas":
          return fetchPlannerKeywordIdeas(request);
        case "keyword_metrics":
          return fetchPlannerHistoricalMetrics(request);
        default:
          throw new ProviderUnsupportedError("google_ads", request.dataType);
      }
    },
  };
}
