import type { BillingCustomerContext } from "@/server/billing/subscription";
import { GscService } from "@/server/features/gsc/services/GscService";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import { authorizePlannerResearchFallback } from "@/server/lib/seo-data/providers/google-ads-planner-fallback";
import { parseStoredPlannerEnvelope } from "@/server/lib/seo-data/providers/planner-envelope";
import { keywordOpportunityKey } from "@/shared/keyword-relevance";
import { getKeywordResearchCountry } from "@/shared/keyword-research-sources";
import type {
  KeywordOpportunitySource,
  KeywordResearchAttribution,
  KeywordResearchRow,
  KeywordResearchSourceStatus,
} from "@/types/keywords";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { mapGoogleResearchRecords } from "./google-records";

export const ARABIC_LETTER = /(?=\p{Script=Arabic})\p{Letter}/u;
export const MAX_LOCAL_CANDIDATES = 1000;

export type Observation = {
  row: KeywordResearchRow;
  attribution: KeywordResearchAttribution;
};

export function observe(
  row: KeywordResearchRow,
  source: KeywordOpportunitySource,
  observedAt: string | null,
  cacheStatus: KeywordResearchAttribution["cacheStatus"],
): Observation {
  return {
    row,
    attribution: {
      keyword: row.keyword,
      source,
      observedAt,
      cacheStatus,
      confidence:
        source === "gsc"
          ? "observed"
          : source === "internal"
            ? "stored_keyword"
            : "provider_estimate",
    },
  };
}

export function opportunity(keyword: string): KeywordResearchRow {
  return {
    keyword,
    searchVolume: null,
    trend: [],
    cpc: null,
    competition: null,
    keywordDifficulty: null,
    intent: null,
  };
}

export function addObservations(
  destination: Map<string, KeywordResearchRow>,
  observations: Observation[],
  limit: number,
): void {
  for (const { row, attribution } of observations) {
    if (!ARABIC_LETTER.test(row.keyword)) continue;
    const key = keywordOpportunityKey(row.keyword);
    const previous = destination.get(key);
    if (previous) {
      if (
        !previous.attribution?.some(
          (entry) => entry.source === attribution.source,
        )
      ) {
        previous.attribution?.push(attribution);
      }
      continue;
    }
    if (destination.size >= limit) continue;

    const intent = row.intent === "unknown" ? null : row.intent;
    destination.set(key, {
      ...row,
      intent,
      attribution: [attribution],
      metricAvailability: {
        searchVolume: row.searchVolume !== null,
        cpc: row.cpc !== null,
        keywordDifficulty: row.keywordDifficulty !== null,
        competition: row.competition !== null,
        intent: intent !== null,
        trend: row.trend.length > 0,
      },
    });
  }
}

export function classifyFailure(error: unknown): KeywordResearchSourceStatus {
  if (!(error instanceof Error)) return "unavailable";
  const code = "code" in error ? error.code : undefined;
  const status =
    "status" in error
      ? error.status
      : "statusCode" in error
        ? error.statusCode
        : undefined;
  const ads =
    "firstPartyError" in error &&
    typeof error.firstPartyError === "object" &&
    error.firstPartyError !== null &&
    "errorClass" in error.firstPartyError
      ? error.firstPartyError.errorClass
      : undefined;
  if (
    status === 429 ||
    code === "RATE_LIMITED" ||
    error.name === "RateLimitError" ||
    ads === "QUOTA_EXHAUSTED" ||
    ads === "QUOTA_TEMPORARILY_EXHAUSTED"
  )
    return "rate_limited";
  if (
    status === 402 ||
    code === "PAYMENT_REQUIRED" ||
    code === "INSUFFICIENT_CREDITS" ||
    code === "BUDGET_EXCEEDED" ||
    error.name === "BudgetExceededError" ||
    error.name === "SeRankingCreditExhaustedError"
  )
    return "credit_limit";
  if (error.name === "ProviderUnsupportedError") return "no_coverage";
  if (
    error.name === "GscApiError" &&
    "apiDisabled" in error &&
    error.apiDisabled === true
  )
    return "unavailable";
  if (
    status === 401 ||
    status === 403 ||
    code === "FORBIDDEN" ||
    code === "UNAUTHENTICATED" ||
    error.name === "AuthenticationError" ||
    error.name === "GscTokenError" ||
    ads === "PERMISSION_DENIED" ||
    ads === "API_ACCESS_RESTRICTED" ||
    ads === "OAUTH_TOKEN_FAILURE" ||
    ads === "OAUTH_TOKEN_INVALID"
  )
    return "permission_denied";
  if (
    code === "VALIDATION_ERROR" ||
    error.name === "SeRankingValidationError" ||
    ads === "MALFORMED_RESPONSE" ||
    ads === "INVALID_REQUEST"
  )
    return "invalid_response";
  return "unavailable";
}

export async function googleAdsOpportunities(
  input: ResolvedResearchKeywordsInput,
  seed: string,
  billingCustomer: BillingCustomerContext,
) {
  const { scope } = await authorizePlannerResearchFallback(billingCustomer);
  // A single bounded page keeps fallback quota independent of the open-ended
  // Planner result set. The requested result limit also caps its page size.
  const response = await getSeoDataRouter().route({
    dataType: "keyword_ideas",
    keyword: seed,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
    onlyProvider: "google_ads",
    billingCustomer,
    constraints: {
      source: "ideas",
      limit: Math.min(input.resultLimit, 500),
      plannerScope: scope,
    },
  });
  const envelope = parseStoredPlannerEnvelope(response.data);
  if (!envelope || envelope.dataType !== "keyword_ideas") {
    throw new ProviderUnavailableError(
      "google_ads",
      "Keyword Planner response could not be read.",
    );
  }
  // The estimate belongs to the canonical group. Rendering each close variant
  // with the same numbers would give the appearance of independent estimates.
  const canonical = mapGoogleResearchRecords(
    envelope.records.map((record) => ({
      ...record,
      closeVariants: [],
    })),
  );
  const variants = envelope.records.flatMap(({ closeVariants }) =>
    closeVariants.map(opportunity),
  );
  return {
    envelope,
    observations: [...canonical, ...variants].map((row) =>
      observe(
        { ...row, cpcCurrencyCode: envelope.currencyCode },
        "google_ads",
        envelope.sourceFetchedAt,
        response.fromCache ? "hit" : "miss",
      ),
    ),
    fromCache: response.fromCache,
    attemptedProviders: response.attemptedProviders ?? [],
  };
}

export async function gscOpportunities(
  input: ResolvedResearchKeywordsInput,
  organizationId: string,
  isRelevant: (keyword: string) => boolean,
): Promise<Observation[]> {
  const country = getKeywordResearchCountry(
    input.locationCode,
    input.languageCode,
  );
  if (!country) return [];
  const result = await GscService.getPerformance({
    projectId: input.projectId,
    organizationId,
    dimensions: ["query"],
    dateRange: "last_90_days",
    dataState: "final",
    filters: [
      { dimension: "country", operator: "equals", expression: country },
    ],
    rowLimit: MAX_LOCAL_CANDIDATES,
  });
  const observedAt = new Date().toISOString();
  return result.rows.flatMap((record) => {
    const keyword = record.keys?.[0]?.trim();
    if (!keyword || !isRelevant(keyword)) return [];
    const entry = observe(opportunity(keyword), "gsc", observedAt, "miss");
    entry.attribution.sitePerformance = {
      impressions: Number.isFinite(record.impressions)
        ? record.impressions
        : null,
      clicks: Number.isFinite(record.clicks) ? record.clicks : null,
      startDate: result.request.startDate,
      endDate: result.request.endDate,
    };
    return [entry];
  });
}
