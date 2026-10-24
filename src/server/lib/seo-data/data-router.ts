import { passthroughSchema } from "./cache-service";
import { SeoCacheService, isKeywordCacheDataType } from "./cache-service";
import { singleFlight } from "./single-flight";
import {
  assertDataforseoBudgetAvailable,
  recordCacheHit,
  recordCacheMiss,
  recordDataforseoCall,
  recordFreeProviderCall,
  logRequest,
} from "./cost-tracker";
import {
  BudgetExceededError,
  ProviderUnavailableError,
  ProviderUnsupportedError,
} from "./errors";
import { getProviderFeatureFlags } from "./config";
import { traceCacheDecision, traceProviderCall } from "./trace";
import type {
  SEODataProvider,
  SEODataRequest,
  SEODataResponse,
  SEODataType,
  SEOFirstPartyError,
} from "./types";
import type { ZodTypeAny } from "zod";

/** The serving provider's fetch timestamp when the payload itself carries
 *  one (planner envelopes do; legacy DFS wraps it under `_meta`). */
function payloadFetchedAt(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined;
  if ("fetchedAt" in data && typeof data.fetchedAt === "string") {
    return data.fetchedAt;
  }
  if (
    !("_meta" in data) ||
    typeof data._meta !== "object" ||
    data._meta === null ||
    !("fetchedAt" in data._meta) ||
    typeof data._meta.fetchedAt !== "string"
  ) {
    return undefined;
  }
  return data._meta.fetchedAt;
}

/** Structural guard for the sanitized first-party failure a provider
 *  attached to its own thrown error (drafted by the provider layer; the
 *  router never imports provider internals for this). */
function isSeoFirstPartyError(value: unknown): value is SEOFirstPartyError {
  return (
    typeof value === "object" &&
    value !== null &&
    "provider" in value &&
    typeof value.provider === "string" &&
    "errorClass" in value &&
    typeof value.errorClass === "string" &&
    "message" in value &&
    typeof value.message === "string" &&
    "retryable" in value &&
    typeof value.retryable === "boolean"
  );
}

/** Reads the sanitized first-party failure from a thrown error. Anything
 *  else returns null. */
function firstPartyMetaFromError(error: unknown): SEOFirstPartyError | null {
  if (
    typeof error !== "object" ||
    error === null ||
    !("firstPartyError" in error) ||
    !isSeoFirstPartyError(error.firstPartyError)
  ) {
    return null;
  }
  return error.firstPartyError;
}

/**
 * The priority order of providers for each data type. The first provider that
 * `supports()` the request and is enabled (feature flag) is tried first.
 *
 * TOOL-SPECIFIC EXCEPTION (get_domain_overview / DomainService.getOverview):
 * the order is DataForSEO → internal, the inverse of the free-first default.
 * Domain overview is a paid-intelligence product: when no fresh R2-cache entry
 * exists (the cache check above this walk still runs FIRST and avoids the
 * paid call on a hit), DataForSEO is the PRIMARY source and internal
 * snapshots serve only as the failure fallback. This is intentional and
 * scoped to this data type alone — every other type keeps the free-first
 * order below (do not "fix" this back to internal-first; see the
 * get_domain_overview tool description and its tests).
 *
 * This is the deterministic provider routing policy.
 */
const PROVIDER_PRIORITY: Record<SEODataType, string[]> = {
  keyword_ideas: ["google_ads", "internal", "dataforseo"],
  keyword_metrics: ["google_ads", "internal", "dataforseo"],
  serp: ["internal", "dataforseo"],
  domain_keywords: ["internal", "dataforseo"],
  domain_overview: ["dataforseo", "internal"],
  domain_pages: ["internal", "dataforseo"],
  competitors: ["internal", "dataforseo"],
  backlinks: ["internal", "dataforseo"],
  // Competitive enrichment targets are external competitor domains — never
  // internal data. DataForSEO is the sole source (spec 007); the internal
  // provider's own-domain snapshots must never answer for a competitor.
  competitive_metrics: ["dataforseo"],
  site_audit: ["local_crawler", "dataforseo"],
  search_console: ["gsc"],
  bing_search_performance: ["bing_webmaster"],
};

/**
 * The central data router. Every SEO data request goes through this layer.
 *
 * Flow:
 * 1. Check cache → return on hit
 * 2. Try free/internal providers in priority order
 * 3. Fall back to DataForSEO (paid) if no free provider succeeds
 * 4. Cache the result
 * 5. Log structured request entry
 *
 * Provider selection logic lives here and nowhere else.
 */
export class DataRouter {
  private providers: Map<string, SEODataProvider> = new Map();

  /** Register a provider by its `name`. */
  register(provider: SEODataProvider): void {
    this.providers.set(provider.name, provider);
  }

  /**
   * Route a data request through cache → free providers → DataForSEO fallback.
   * Returns a structured response with provider/cache metadata.
   */
  async route<T = unknown>(
    request: SEODataRequest,
    schema: ZodTypeAny = passthroughSchema,
  ): Promise<SEODataResponse<T>> {
    const startTime = Date.now();
    const requestId = crypto.randomUUID();
    const flags = await getProviderFeatureFlags();

    // If the router is disabled, find the DataForSEO provider and call it
    // directly (backward compatibility with the pre-router behavior).
    if (!flags.routerEnabled) {
      const dfs = this.providers.get("dataforseo");
      if (dfs && dfs.supports(request)) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- provider returns unknown; caller types it
        const data = (await dfs.get(request)) as T;
        return {
          dataType: request.dataType,
          provider: "dataforseo",
          data,
          fromCache: false,
          durationMs: Date.now() - startTime,
        };
      }
    }

    // 1. Cache check
    const isKeywordFlow = isKeywordCacheDataType(request.dataType);
    // Keyword flows keep provenance for their callers: the provider that
    // actually produced the fresh payload, and a sanitized first-party
    // failure to surface when the walk fell back after a first-party miss.
    // Boxed so control-flow analysis cannot narrow these to their
    // initializers — the fetcher closure below writes them invisibly to it.
    const serving: {
      provider: string | null;
      fetchedAt: string | undefined;
      firstPartyFailure: SEOFirstPartyError | null;
    } = { provider: null, fetchedAt: undefined, firstPartyFailure: null };

    const cacheResult = await SeoCacheService.getOrFetch<T>(
      request,
      schema,
      async (cacheKey) => {
        // 2. Try providers in priority order
        const priority = PROVIDER_PRIORITY[request.dataType] ?? [];
        let lastError: unknown = null;
        // The FIRST provider's real failure (402/429/5xx/network) must survive
        // the walk: when a later fallback provider merely has no data
        // (ProviderUnsupportedError), that "no data" signal must not mask
        // the primary's error — otherwise a DataForSEO 402 with an empty
        // internal snapshot would surface as a generic unavailable error
        // and break the recovery policy (no-retry on credits).
        let primaryError: unknown = null;

        for (const providerName of priority) {
          // Skip disabled providers
          if (!isProviderEnabled(providerName, flags)) continue;

          const provider = this.providers.get(providerName);
          if (!provider) continue;
          if (!provider.supports(request)) continue;

          try {
            const data = await traceProviderCall(providerName, () =>
              singleFlight(cacheKey, () => provider.get(request)),
            );

            if (providerName !== "dataforseo") {
              recordFreeProviderCall(providerName);
            }

            serving.provider = providerName;
            serving.fetchedAt = payloadFetchedAt(data);

            // Cache the result (fire-and-forget is the caller's job via
            // waitUntil; here we await to ensure persistence within the
            // request lifecycle).
            await SeoCacheService.set(request, cacheKey, data, {
              provider: providerName,
              fetchedAt: serving.fetchedAt,
            });

            // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- provider returns unknown; caller types it
            return data as T;
          } catch (error) {
            if (isKeywordFlow) {
              const meta = firstPartyMetaFromError(error);
              if (meta) serving.firstPartyFailure = meta;
            }
            if (error instanceof ProviderUnsupportedError) {
              // Expected — try the next provider
              if (primaryError === null) lastError = error;
              continue;
            }
            if (error instanceof ProviderUnavailableError) {
              // Expected — try the next provider, record reason
              if (primaryError === null) lastError = error;
              continue;
            }
            if (error instanceof BudgetExceededError) {
              // Budget exceeded — do NOT try DataForSEO, return structured error
              logRequest({
                requestId,
                dataType: request.dataType,
                provider: providerName,
                cacheStatus: "miss",
                fallback: false,
                fallbackReason: "budget_exceeded",
                durationMs: Date.now() - startTime,
                success: false,
              });
              throw error;
            }
            // A real provider failure (billing, rate limit, upstream). Record
            // it as the primary error the walk should surface if no fallback
            // succeeds; later "no data" misses never overwrite it.
            if (primaryError === null) {
              primaryError = error;
              lastError = error;
            }
            continue;
          }
        }

        // No provider succeeded
        if (lastError) {
          throw lastError;
        }
        throw new ProviderUnavailableError(
          "router",
          `No provider available for ${request.dataType}`,
        );
      },
    );

    if (cacheResult.fromCache) {
      recordCacheHit();
      traceCacheDecision(true);
    } else {
      recordCacheMiss();
      traceCacheDecision(false);
    }

    // Keyword flows declare the REAL serving provider (the planner that won
    // the walk, the cached provenance on a hit, or DataForSEO on fallback);
    // every other flow keeps the stable "provider" / "cache" literals their
    // consumers already depend on.
    const providerLabel = isKeywordFlow
      ? cacheResult.fromCache
        ? (cacheResult.cacheProvider ?? "cache")
        : (serving.provider ?? "provider")
      : cacheResult.fromCache
        ? "cache"
        : "provider";
    const fetchedAt = isKeywordFlow
      ? cacheResult.fromCache
        ? cacheResult.fetchedAt
        : serving.fetchedAt
      : undefined;
    const firstPartyError =
      !cacheResult.fromCache &&
      isKeywordFlow &&
      serving.firstPartyFailure !== null &&
      serving.provider !== null &&
      serving.provider !== serving.firstPartyFailure.provider
        ? serving.firstPartyFailure
        : undefined;

    const response: SEODataResponse<T> = {
      dataType: request.dataType,
      provider: providerLabel,
      data: cacheResult.data,
      fromCache: cacheResult.fromCache,
      durationMs: Date.now() - startTime,
      ...(fetchedAt !== undefined ? { fetchedAt } : {}),
      ...(firstPartyError !== undefined ? { firstPartyError } : {}),
    };

    logRequest({
      requestId,
      dataType: request.dataType,
      provider: providerLabel,
      cacheStatus: cacheResult.fromCache ? "hit" : "miss",
      fallback: !cacheResult.fromCache,
      durationMs: response.durationMs,
      success: true,
    });

    return response;
  }
}

function isProviderEnabled(
  name: string,
  flags: Awaited<ReturnType<typeof getProviderFeatureFlags>>,
): boolean {
  switch (name) {
    case "dataforseo":
      return flags.dataforseoEnabled;
    case "gsc":
      return flags.gscEnabled;
    case "google_ads":
      return flags.googleAdsEnabled;
    case "bing_webmaster":
      return flags.bingWebmasterEnabled;
    case "local_crawler":
      return flags.localCrawlerEnabled;
    case "internal":
      return true; // internal DB reads are always enabled
    default:
      return true;
  }
}

/**
 * Budget-guarded DataForSEO call wrapper. Used by the DataForSEO provider
 * implementation to enforce daily/monthly budget limits before making a call.
 */
export async function withBudgetGuard<T>(fn: () => Promise<T>): Promise<T> {
  await assertDataforseoBudgetAvailable();
  return fn();
}

export { recordDataforseoCall };
