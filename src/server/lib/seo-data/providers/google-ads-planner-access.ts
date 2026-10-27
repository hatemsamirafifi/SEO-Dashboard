/** Per-project Google Ads Planner access for the seo-data google_ads provider.
 *
 *  The worker-owned master plan splits the v18 env-credential transport out of
 *  the provider: identity comes ONLY from the per-project Ads connection row,
 *  resolved through the request's billing context (projectId +
 *  organizationId). Every fetch runs through the typed Phase 1 client, and
 *  targeting (geo/language) is resolved through Google's own lookups â€” never
 *  defaulted to US/English â€” so an unsupported market fails into a
 *  DataForSEO fallback instead of a wrong first-party answer.
 *
 *  This module never throws unclassified errors forward: everything leaving
 *  the fetch boundary carries `firstPartyError` provenance metadata
 *  ({provider, errorClass, message, retryable}) that the data router can
 *  attach to a successful fallback response. Upstream text never leaks into
 *  those fields.
 */
import {
  createGoogleAdsClient,
  classifyGoogleAdsError,
} from "@/server/lib/googleAdsClient";
import {
  GoogleAdsConnectionRepository,
  type GoogleAdsConnection,
} from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";
import {
  LOCATION_OPTIONS,
  getIsoCountryCode,
} from "@/shared/keyword-locations";
import type { SEODataRequest, SEOFirstPartyError } from "../types";
import { ProviderUnavailableError, ProviderUnsupportedError } from "../errors";

const PROVIDER_NAME = "google_ads";

/** Bumped whenever the normalized planner payload shape changes so cache
 *  entries written by an older mapping self-heal to a miss. */
export const GOOGLE_ADS_PLANNER_CACHE_CONTRACT = "v26-planner";

/** The planner scope a cache entry was produced under: two requests share a
 *  cache entry only when the identity matches exactly (customer + login
 *  customer + account currency + payload contract). */
export type GoogleAdsPlannerCacheIdentity = {
  /** 10-digit customer id of the connected Ads account. */
  customer: string | null;
  /** Manager id used as the login customer, when the connection rides a
   *  manager hierarchy. */
  loginCustomer: string | null;
  /** Account currency the micros and CPC figures are denominated in. */
  currencyCode: string | null;
  contract: string;
};

export type PlannerBillingContext = {
  projectId?: string;
  organizationId: string;
};

type PlannerClient = ReturnType<typeof createGoogleAdsClient>;

/** Connection lookup that can never throw: a billing context without a
 *  projectId and any repository failure resolve to "no planner identity".
 *  Callers distinguish only "connected" vs "not connected" â€” internal
 *  connection errors must not break the first-party walk, they surface the
 *  DataForSEO fallback. */
export async function getPlannerConnectionForBilling(
  context: PlannerBillingContext,
): Promise<GoogleAdsConnection | null> {
  try {
    if (!context.projectId) return null;
    return await GoogleAdsConnectionRepository.getByProjectId(
      context.projectId,
      context.organizationId,
    );
  } catch {
    return null;
  }
}

/** Pure mapping from a connection row to its cache identity; null becomes
 *  the `{customer: null, ...}` identity so unconnected requests still get a
 *  deterministic cache key that never collides with connected ones. */
export function describePlannerCacheIdentity(
  connection: GoogleAdsConnection | null,
): GoogleAdsPlannerCacheIdentity {
  return {
    customer: connection?.customerId ?? null,
    loginCustomer: connection?.loginCustomerId ?? null,
    currencyCode: connection?.currencyCode ?? null,
    contract: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
  };
}

export async function resolvePlannerCacheIdentity(
  context: PlannerBillingContext,
): Promise<GoogleAdsPlannerCacheIdentity> {
  return describePlannerCacheIdentity(
    await getPlannerConnectionForBilling(context),
  );
}

function buildClient(connection: GoogleAdsConnection): PlannerClient {
  return createGoogleAdsClient({
    userId: connection.connectedByUserId,
    grantAccountId: connection.grantAccountId,
  });
}

/** Geo and language constants resolved through Google's own lookups are
 *  stable resources, so they are memoized briefly per worker to avoid
 *  re-paying the two resolution round trips for every keyword request. */
const TARGET_MEMO_TTL_MS = 24 * 60 * 60 * 1000;

type GeoTargetResolution = { constant: string; countryCode: string };

const geoTargetMemo = new Map<
  number,
  { value: GeoTargetResolution; expiresAt: number }
>();
const languageMemo = new Map<string, { value: string; expiresAt: number }>();

/** Test seam: clears the geo/language resolution memo. */
export function resetPlannerTargetMemoForTests(): void {
  geoTargetMemo.clear();
  languageMemo.clear();
}

/** The SEO catalog's country location (code + label) for the planner ask.
 *  Same-origin mapping with getKeywordDataProvider: the connection-scoped
 *  planner only answers for markets the product already qualifies as
 *  keyword-data-ready. */
function locationOption(locationCode: number | undefined): {
  code: number;
  label: string;
} {
  if (locationCode === undefined) {
    throw new ProviderUnsupportedError(
      PROVIDER_NAME,
      "keyword_ideas",
      "Google Ads planner needs an explicit location code.",
    );
  }
  const option = LOCATION_OPTIONS.find((entry) => entry.code === locationCode);
  if (!option) {
    throw new ProviderUnsupportedError(
      PROVIDER_NAME,
      "keyword_ideas",
      "Unknown or unsupported keyword research location.",
    );
  }
  return option;
}

async function resolveGeoTarget(
  client: PlannerClient,
  connection: GoogleAdsConnection,
  locationCode: number | undefined,
): Promise<GeoTargetResolution> {
  const option = locationOption(locationCode);
  const memoEntry = geoTargetMemo.get(option.code);
  if (memoEntry && memoEntry.expiresAt > Date.now()) return memoEntry.value;

  let constant;
  try {
    constant = await client.resolveCountryGeoTargetConstant({
      countryCode: getIsoCountryCode(option.code).toUpperCase(),
      countryName: option.label,
    });
  } catch {
    // Ambiguous/unknown/absent geo resolution is a market this project's
    // planner cannot serve â€” fail into a fallback with a clear reason
    // instead of researching a silently substituted geo.
    throw new ProviderUnsupportedError(
      PROVIDER_NAME,
      "keyword_ideas",
      `Google Ads could not resolve a unique geo target for ${option.label}.`,
    );
  }
  const value: GeoTargetResolution = {
    constant: constant.resourceName,
    countryCode: constant.countryCode?.toUpperCase() ?? "",
  };
  geoTargetMemo.set(option.code, {
    value,
    expiresAt: Date.now() + TARGET_MEMO_TTL_MS,
  });
  return value;
}

/** The language constant for the requested language code. Unknown, missing
 *  or non-targetable codes reject â€” the planner never researches a language
 *  silently substituted with English. */
async function resolveLanguage(
  client: PlannerClient,
  connection: GoogleAdsConnection,
  languageCode: string | undefined,
): Promise<string> {
  if (!languageCode) {
    throw new ProviderUnsupportedError(
      PROVIDER_NAME,
      "keyword_metrics",
      "Google Ads planner needs an explicit language code.",
    );
  }
  const memoEntry = languageMemo.get(languageCode);
  if (memoEntry && memoEntry.expiresAt > Date.now()) return memoEntry.value;

  let constant;
  try {
    constant = await client.resolveLanguageConstant({
      customerId: connection.customerId,
      languageCode,
      loginCustomerId: connection.loginCustomerId,
    });
  } catch {
    // Unknown or non-targetable language: the planner never researches a
    // language silently substituted with English, so this market framing
    // cannot be served first-party.
    throw new ProviderUnsupportedError(
      PROVIDER_NAME,
      "keyword_ideas",
      `Google Ads has no targetable language constant for "${languageCode}".`,
    );
  }
  languageMemo.set(languageCode, {
    value: constant.resourceName,
    expiresAt: Date.now() + TARGET_MEMO_TTL_MS,
  });
  return constant.resourceName;
}

/** Bounded list of planner keyword seeds per request: the v26 documented
 *  seed ceiling. Anything more must be batched by the caller. */
const GOOGLE_ADS_PLANNER_SEED_LIMIT = 20;

export type GoogleAdsPlannerIdeaEnvelope = {
  source: "google_ads";
  fetchedAt: string;
  currencyCode: string | null;
  network: string;
  // The Ads customer identity this payload was produced under, attached at
  // fetch time so first-party persistence attributes the observation to the
  // account that actually served it (also on router cache replays).
  customerId: string;
  loginCustomerId: string | null;
  ideas: Awaited<ReturnType<PlannerClient["generateKeywordIdeas"]>>["ideas"];
  keywords: [];
  missingKeywords: [];
  malformedKeywords: number;
  duplicateKeywords: 0;
  truncated: boolean;
  partial: boolean;
};

export type GoogleAdsPlannerMetricsEnvelope = {
  source: "google_ads";
  fetchedAt: string;
  currencyCode: string | null;
  network: string;
  // See the ideas envelope: the Ads identity this payload was produced under.
  customerId: string;
  loginCustomerId: string | null;
  keywords: Awaited<
    ReturnType<PlannerClient["generateKeywordHistoricalMetrics"]>
  >["keywords"];
  missingKeywords: string[];
  malformedKeywords: number;
  duplicateKeywords: number;
  // The historical-metrics endpoint has no paging contract, so the envelope stays a
  // literal-false field rather than a boolean that invites `true`.
  truncated: false;
  partial: boolean;
};

/** Attaches sanitized first-party provenance to any error leaving the
 *  planner access layer. The classification is always built from our own
 *  error taxonomy â€” never from upstream response bodies. Exported so the
 *  provider's own pre-flight gates (feature flag) can leave provenance
 *  without duplicating the taxonomy. */
export function attachFirstPartyMeta(error: unknown): unknown {
  let classification: SEOFirstPartyError;
  if (
    error instanceof ProviderUnavailableError ||
    error instanceof ProviderUnsupportedError
  ) {
    classification = {
      provider: PROVIDER_NAME,
      // The two router-class signalling names describe *why* the first-party
      // walk skipped this provider, not an upstream status.
      errorClass:
        error instanceof ProviderUnavailableError
          ? "PROVIDER_UNAVAILABLE"
          : "PROVIDER_UNSUPPORTED",
      message: error.message,
      retryable: false,
    };
  } else {
    classification = {
      provider: PROVIDER_NAME,
      ...classifyGoogleAdsError(error),
    };
  }
  if (typeof error === "object" && error !== null) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- first-party provenance is attached dynamically to arbitrarily thrown errors (the provider contract)
    (error as { firstPartyError?: SEOFirstPartyError }).firstPartyError =
      classification;
    return error;
  }
  const wrapped = new Error("Google Ads planner request failed.");
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion â€” first-party provenance is attached dynamically (the provider contract)
  (wrapped as { firstPartyError?: SEOFirstPartyError }).firstPartyError =
    classification;
  return wrapped;
}

/** Wraps a planner call so every error path (connection resolution,
 *  targeting resolution, transport, parse) leaves with attached provenance
 *  metadata. */
async function withFirstPartyMeta<T>(call: () => Promise<T>): Promise<T> {
  try {
    return await call();
  } catch (error) {
    throw attachFirstPartyMeta(error);
  }
}

/** Seeded keyword ideas from the connected account's planner. Resolves the
 *  geo target and language constant before the ideas call so a market the
 *  Google planner does not recognize fails fast into a fallback instead of
 *  researching a silently substituted geo. */
export async function fetchPlannerKeywordIdeas(
  request: SEODataRequest,
): Promise<GoogleAdsPlannerIdeaEnvelope> {
  return withFirstPartyMeta(async () => {
    const connection = await getPlannerConnectionForBilling(
      request.billingCustomer,
    );
    if (!connection) {
      throw new ProviderUnavailableError(
        PROVIDER_NAME,
        "Google Ads is not connected to this project.",
      );
    }

    const seed = request.keyword?.trim();
    if (!seed) {
      throw new ProviderUnsupportedError(
        PROVIDER_NAME,
        request.dataType,
        "keyword_ideas requires a seed keyword for the Google Ads planner.",
      );
    }

    const client = buildClient(connection);
    const geo = await resolveGeoTarget(
      client,
      connection,
      request.locationCode,
    );
    const language = await resolveLanguage(
      client,
      connection,
      request.languageCode,
    );

    const limit = request.constraints?.limit;
    const result = await client.generateKeywordIdeas({
      customerId: connection.customerId,
      keywords: [seed].slice(0, GOOGLE_ADS_PLANNER_SEED_LIMIT),
      geoTargetConstants: [geo.constant],
      language,
      currencyCode: connection.currencyCode,
      loginCustomerId: connection.loginCustomerId,
      maxResults:
        typeof limit === "number" && Number.isInteger(limit) && limit > 0
          ? limit
          : undefined,
    });

    return {
      source: result.source,
      fetchedAt: result.fetchedAt,
      currencyCode: result.currencyCode ?? connection.currencyCode,
      network: result.network,
      customerId: connection.customerId,
      loginCustomerId: connection.loginCustomerId,
      ideas: result.ideas,
      keywords: [],
      missingKeywords: [],
      malformedKeywords: result.malformedIdeas,
      duplicateKeywords: 0,
      truncated: result.truncated,
      partial: result.partial,
    };
  });
}

export async function fetchPlannerHistoricalMetrics(
  request: SEODataRequest,
): Promise<GoogleAdsPlannerMetricsEnvelope> {
  return withFirstPartyMeta(async () => {
    if (request.constraints?.locationName) {
      // Location-name targeting is a DataForSEO capability; the planner
      // answers exact geotarget constants only. Unclaiming here keeps the
      // paid provider serving its own market honestly.
      throw new ProviderUnsupportedError(
        PROVIDER_NAME,
        "keyword_metrics",
        "Google Ads planner metric calls support location codes only.",
      );
    }
    const connection = await getPlannerConnectionForBilling(
      request.billingCustomer,
    );
    if (!connection) {
      throw new ProviderUnavailableError(
        PROVIDER_NAME,
        "Google Ads is not connected to this project.",
      );
    }

    if (!Array.isArray(request.keywords) || request.keywords.length === 0) {
      throw new ProviderUnsupportedError(
        PROVIDER_NAME,
        request.dataType,
        "keyword_metrics requires a keyword list for the Google Ads planner.",
      );
    }

    const client = buildClient(connection);
    const geo = await resolveGeoTarget(
      client,
      connection,
      request.locationCode,
    );
    const language = await resolveLanguage(
      client,
      connection,
      request.languageCode,
    );

    const result = await client.generateKeywordHistoricalMetrics({
      customerId: connection.customerId,
      keywords: request.keywords,
      geoTargetConstants: [geo.constant],
      language,
      currencyCode: connection.currencyCode,
      loginCustomerId: connection.loginCustomerId,
    });

    return {
      source: result.source,
      fetchedAt: result.fetchedAt,
      currencyCode: result.currencyCode ?? connection.currencyCode,
      network: result.network,
      customerId: connection.customerId,
      loginCustomerId: connection.loginCustomerId,
      keywords: result.keywords,
      missingKeywords: result.missingKeywords,
      malformedKeywords: result.malformedKeywords,
      duplicateKeywords: result.duplicateKeywords,
      // The v26 historical-metrics endpoint has no paging contract, so the
      // result is never truncated; the literal keeps the envelope contract
      // honest without widening the field back to a plain boolean.
      truncated: false,
      partial: result.partial,
    };
  });
}
