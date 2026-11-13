/* eslint-disable eslint/max-lines, eslint/max-params */
import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import type { KeywordResearchRow, SeedOverviewInfo } from "@/types/keywords";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { getKeywordDataProvider } from "@/shared/keyword-locations";
import {
  annotateAndSortKeywordRows,
  isExactKeywordMatch,
  normalizeArabicKeyword,
} from "@/shared/keyword-relevance";
import {
  getPlannerConnectionForBilling,
  GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
} from "@/server/lib/seo-data/providers/google-ads-planner-access";
import type { ParsedPlannerEnvelope } from "@/server/lib/seo-data/providers/planner-envelope";
import { GoogleAdsPlannerKeywordRepository } from "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository";
import { type EnrichedKeyword, normalizeKeyword } from "./helpers";
import {
  fetchGoogleAdsResearchRows,
  fetchResearchRowsBySource,
} from "./research-data";
import {
  AUTO_KEYWORD_SOURCES,
  MIN_NON_SEED_FOR_AUTO,
  countNonSeedKeywords,
  hasSufficientCoverage,
  type KeywordMode,
  type KeywordSource,
  type ResearchSource,
} from "./selection";
import { getProviderFeatureFlags } from "@/server/lib/seo-data/config";

export type SourceAttempt = {
  source: ResearchSource;
  rowCount: number;
  nonSeedCount: number;
};

export type ResearchDiagnostics = {
  requestedMode: KeywordMode;
  threshold: number;
  sourceAttempts: SourceAttempt[];
  registeredProviders?: string[];
  enabledProviders?: string[];
  attemptedProvider?: string | null;
  servingProvider?: string | null;
  skippedProviders?: { provider: string; reason: string }[];
  effectiveConfig?: {
    serankingConfigured: boolean;
    serankingEnabled: boolean;
    dataforseoConfigured: boolean;
    dataforseoEnabled: boolean;
  };
  keywordSourceRequested?: string;
  providerReturnedData?: string | null;
  errorStage?: string | null;
  confirmedCreditsUsed?: number | null;
};

export type ResearchResult = {
  provider: string;
  rows: KeywordResearchRow[];
  source: ResearchSource;
  usedFallback: boolean;
  seedOverview?: SeedOverviewInfo;
  // Set by the Google-Ads-served path: true when the payload was the
  // first-party planner envelope, so persistence skips the legacy DFS
  // upsert and the follow-up storage hook records the rows instead.
  firstParty?: boolean;
  // The R2-validated planner envelope (null for DFS-served research).
  plannerEnvelope?: ParsedPlannerEnvelope | null;
  diagnostics: ResearchDiagnostics;
};

async function fetchRowsFromSource(
  source: KeywordSource,
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<{ rows: EnrichedKeyword[]; provider: string }> {
  return fetchResearchRowsBySource(
    {
      source,
      seedKeyword,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      resultLimit: input.resultLimit,
      includeClickstreamData: input.clickstream,
      creditFeature,
    },
    billingCustomer,
  );
}

async function fetchAutoRows(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
  baseDiagnostics?: Partial<ResearchDiagnostics>,
): Promise<ResearchResult> {
  const attempts: SourceAttempt[] = [];
  let lastSource: KeywordSource = AUTO_KEYWORD_SOURCES[0];
  let servingProvider: string | null = null;
  const accumulatedRows: EnrichedKeyword[] = [];
  const seenKeywords = new Set<string>();
  let lastError: unknown = null;

  for (const source of AUTO_KEYWORD_SOURCES) {
    // In SE Ranking, both "suggestions" and "ideas" map to /v1/keywords/similar.
    // Never fire a duplicate paid call to /v1/keywords/similar when SE Ranking
    // already served "suggestions".
    if (source === "ideas" && servingProvider === "seranking") {
      continue;
    }

    let sourceResult: { rows: EnrichedKeyword[]; provider: string } = {
      rows: [],
      provider: "unknown",
    };
    try {
      sourceResult = await fetchRowsFromSource(
        source,
        input,
        seedKeyword,
        billingCustomer,
        creditFeature,
      );
    } catch (error) {
      lastError = error;
      attempts.push({
        source,
        rowCount: 0,
        nonSeedCount: 0,
      });

      // Task 6: Prevent failed validation, auth, or credit errors from triggering repeated paid calls
      const errorObj =
        typeof error === "object" && error !== null
          ? (error as { name?: unknown; code?: unknown })
          : null;
      const errorName = typeof errorObj?.name === "string" ? errorObj.name : "";
      const errorCode = typeof errorObj?.code === "string" ? errorObj.code : "";
      const isUnrecoverable =
        errorName === "SeRankingValidationError" ||
        errorCode === "VALIDATION_ERROR" ||
        errorName === "SeRankingAuthError" ||
        errorCode === "UNAUTHENTICATED" ||
        errorName === "SeRankingCreditExhaustedError" ||
        errorCode === "PAYMENT_REQUIRED" ||
        errorCode === "INSUFFICIENT_CREDITS" ||
        errorCode === "BUDGET_EXCEEDED";

      if (isUnrecoverable) {
        break;
      }

      continue;
    }

    const { rows, provider } = sourceResult;
    if (provider && provider !== "unknown") {
      servingProvider = provider;
    }

    for (const row of rows) {
      if (accumulatedRows.length >= input.resultLimit) break;
      const dedupeKey = normalizeArabicKeyword(row.keyword);
      if (seenKeywords.has(dedupeKey)) continue;
      seenKeywords.add(dedupeKey);
      accumulatedRows.push(row);
    }

    attempts.push({
      source,
      rowCount: rows.length,
      nonSeedCount: countNonSeedKeywords(rows, seedKeyword),
    });

    lastSource = source;

    if (
      hasSufficientCoverage(accumulatedRows, seedKeyword, MIN_NON_SEED_FOR_AUTO)
    ) {
      return {
        provider: servingProvider ?? "seranking",
        rows: accumulatedRows,
        source,
        usedFallback: source !== AUTO_KEYWORD_SOURCES[0],
        diagnostics: {
          ...baseDiagnostics,
          requestedMode: "auto",
          threshold: MIN_NON_SEED_FOR_AUTO,
          sourceAttempts: attempts,
          servingProvider: servingProvider ?? "seranking",
          providerReturnedData: servingProvider ?? "seranking",
        },
      };
    }
  }

  if (accumulatedRows.length > 0) {
    return {
      provider: servingProvider ?? "seranking",
      rows: accumulatedRows,
      source: lastSource,
      usedFallback: true,
      diagnostics: {
        ...baseDiagnostics,
        requestedMode: "auto",
        threshold: MIN_NON_SEED_FOR_AUTO,
        sourceAttempts: attempts,
        servingProvider: servingProvider ?? "seranking",
        providerReturnedData: servingProvider ?? "seranking",
      },
    };
  }

  if (lastError) {
    throw lastError;
  }

  return {
    provider: servingProvider ?? "seranking",
    rows: accumulatedRows,
    source: lastSource,
    usedFallback: true,
    diagnostics: {
      ...baseDiagnostics,
      requestedMode: "auto",
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: attempts,
      servingProvider: servingProvider ?? "seranking",
      providerReturnedData: servingProvider ?? null,
    },
  };
}

async function fetchGoogleAdsRows(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
  baseDiagnostics?: Partial<ResearchDiagnostics>,
): Promise<ResearchResult> {
  const { rows, provider, servedFirstParty, plannerEnvelope } =
    await fetchGoogleAdsResearchRows(
      {
        seedKeyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        resultLimit: input.resultLimit,
        creditFeature,
      },
      billingCustomer,
    );
  const requestedMode = input.mode ?? "auto";

  return {
    provider: provider ?? "google_ads",
    rows,
    source: "google_ads",
    firstParty: servedFirstParty,
    plannerEnvelope,
    // Honesty: the DataForSEO keywords_for_keywords endpoint IS a fallback
    // for Google-Ads-served markets, but only relative to what the user
    // asked for. A user who picked an explicit mode and got DFS rows
    // "fell back"; the auto waterfall treats that endpoint as one of its
    // normal steps, so an auto request that ends up there is not a
    // fallback. First-party planner payloads are never a fallback.
    usedFallback: !servedFirstParty && requestedMode !== "auto",
    diagnostics: {
      ...baseDiagnostics,
      requestedMode,
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: [
        {
          source: "google_ads",
          rowCount: rows.length,
          nonSeedCount: countNonSeedKeywords(rows, seedKeyword),
        },
      ],
      servingProvider: provider ?? "google_ads",
      providerReturnedData: provider ?? "google_ads",
    },
  };
}

async function fetchManualRows(
  mode: Exclude<KeywordMode, "auto">,
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
  baseDiagnostics?: Partial<ResearchDiagnostics>,
): Promise<ResearchResult> {
  const { rows, provider } = await fetchRowsFromSource(
    mode,
    input,
    seedKeyword,
    billingCustomer,
    creditFeature,
  );
  const attempt: SourceAttempt = {
    source: mode,
    rowCount: rows.length,
    nonSeedCount: countNonSeedKeywords(rows, seedKeyword),
  };

  return {
    provider: provider ?? "provider",
    rows,
    source: mode,
    usedFallback: false,
    diagnostics: {
      ...baseDiagnostics,
      requestedMode: mode,
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: [attempt],
      servingProvider: provider ?? "provider",
      providerReturnedData: provider ?? "provider",
    },
  };
}

function persistRows(
  input: ResolvedResearchKeywordsInput,
  rows: EnrichedKeyword[],
) {
  void Promise.all(
    rows.map((row) =>
      KeywordResearchRepository.upsertKeywordMetric({
        projectId: input.projectId,
        keyword: row.keyword,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        searchVolume: row.searchVolume,
        cpc: row.cpc,
        competition: row.competition,
        keywordDifficulty: row.keywordDifficulty,
        intent: row.intent,
        monthlySearchesJson: JSON.stringify(row.trend),
      }),
    ),
  ).catch((error) => {
    console.error("keywords.research.persist-metrics failed:", error);
  });
}

/** First-party persistence hook: records the serving planner envelope as a
 *  normalized group observation (observation ledger + canonical groups +
 *  variant memberships + monthly histories) instead of shaping planner rows
 *  into the DFS-shaped legacy `upsertKeywordMetric` path.
 *
 *  The observation is attributed to the Ads identity the payload was
 *  produced under. The planner access layer attaches it to every fresh
 *  envelope; a cache-replayed envelope without that identity falls back to
 *  the project's CURRENT trusted connection (the router cache key is built
 *  from that identity, so a replay only ever serves the producing account).
 *  When no connection can be resolved, nothing is recorded — never a guess.
 */
export function recordFirstPartyResearchRows(
  envelope: ParsedPlannerEnvelope | null,
  seedKeyword: string,
  input: ResolvedResearchKeywordsInput,
  billingCustomer: BillingCustomerContext,
): void {
  if (!envelope) return;

  void (async () => {
    let customerId = envelope.customerId;
    let loginCustomerId = envelope.loginCustomerId;
    let currencyCode = envelope.currencyCode;
    if (!customerId) {
      const connection = await getPlannerConnectionForBilling({
        projectId: input.projectId,
        organizationId: billingCustomer.organizationId,
      });
      if (!connection) return;
      customerId = connection.customerId;
      loginCustomerId = connection.loginCustomerId;
      currencyCode = envelope.currencyCode ?? connection.currencyCode;
    }

    await GoogleAdsPlannerKeywordRepository.recordGroupObservation({
      scope: {
        projectId: input.projectId,
        organizationId: billingCustomer.organizationId,
        customerId,
        loginCustomerId,
        currencyCode,
        locationCode: input.locationCode,
        languageCode: input.languageCode,
        network: envelope.network,
        contractVersion: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
      },
      dataType: envelope.dataType,
      seedKeyword: envelope.dataType === "keyword_ideas" ? seedKeyword : "",
      sourceFetchedAt: envelope.sourceFetchedAt,
      stats: {
        truncated: envelope.truncated,
        partial: envelope.partial,
        malformedKeywordCount: envelope.malformedKeywordCount,
        duplicateKeywordCount: envelope.duplicateKeywordCount,
        missingKeywordCount: envelope.missingKeywordCount,
      },
      records: envelope.records,
    });
  })().catch((error) => {
    console.error("keywords.research.record-first-party-observation:", error);
  });
}

export async function research(
  input: ResolvedResearchKeywordsInput,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<ResearchResult> {
  const uniqueKeywords = [
    ...new Set(input.keywords.map(normalizeKeyword)),
  ].filter((keyword) => keyword.length > 0);

  if (uniqueKeywords.length === 0) {
    throw new AppError("VALIDATION_ERROR");
  }

  const seedKeyword = uniqueKeywords[0];
  const provider = getKeywordDataProvider(input.locationCode);
  // Clickstream refinement is a DataForSEO Labs capability and doesn't exist
  // for Google-Ads-served countries; drop it so equivalent requests share one
  // cache entry. The user's mode is PRESERVED (not collapsed to "auto"): the
  // diagnostics must report the mode the user actually chose, and an explicit
  // mode — unlike the auto waterfall — turns a DataForSEO-served response
  // into an honest fallback.
  const effectiveInput: ResolvedResearchKeywordsInput =
    provider === "google_ads" ? { ...input, clickstream: false } : input;
  const mode = effectiveInput.mode ?? "auto";

  const flags = await getProviderFeatureFlags();
  const serankingConfig = {
    configured: true,
    enabled: flags.serankingEnabled,
    priority: 1,
  };
  const dataforseoConfig = {
    configured: false,
    enabled: flags.dataforseoEnabled,
    priority: 1,
  };

  const registeredProviders = [
    "google_ads",
    "seranking",
    "internal",
    "dataforseo",
  ];
  const enabledProviders = registeredProviders.filter((p) => {
    if (p === "seranking")
      return flags.serankingEnabled && serankingConfig.enabled;
    if (p === "dataforseo")
      return flags.dataforseoEnabled && dataforseoConfig.enabled;
    if (p === "google_ads") return flags.googleAdsEnabled;
    return true;
  });

  const skippedProviders: { provider: string; reason: string }[] = [];
  if (!flags.serankingEnabled || !serankingConfig.enabled) {
    skippedProviders.push({
      provider: "seranking",
      reason: !flags.serankingEnabled
        ? "SERANKING_ENABLED is false"
        : "disabled in settings",
    });
  }
  if (!flags.dataforseoEnabled || !dataforseoConfig.enabled) {
    skippedProviders.push({
      provider: "dataforseo",
      reason: !flags.dataforseoEnabled
        ? "DATAFORSEO_ENABLED is false"
        : "disabled in settings",
    });
  }
  if (!flags.googleAdsEnabled) {
    skippedProviders.push({
      provider: "google_ads",
      reason: "GOOGLE_ADS_ENABLED is false",
    });
  }

  const baseDiagnostics: Partial<ResearchDiagnostics> = {
    registeredProviders,
    enabledProviders,
    attemptedProvider:
      provider === "google_ads" ? "google_ads" : (enabledProviders[0] ?? null),
    skippedProviders,
    effectiveConfig: {
      serankingConfigured: serankingConfig.configured,
      serankingEnabled: serankingConfig.enabled,
      dataforseoConfigured: dataforseoConfig.configured,
      dataforseoEnabled: dataforseoConfig.enabled,
    },
    keywordSourceRequested: mode,
  };

  try {
    // No outer kw:research cache: the DataRouter caches each per-source call
    // (keyed by dataType + keyword + market + constraints) and single-flight
    // coalesces concurrent requests, so a repeat research() run re-reads the
    // per-source router cache entries instead of re-calling providers.
    const result =
      provider === "google_ads"
        ? await fetchGoogleAdsRows(
            effectiveInput,
            seedKeyword,
            billingCustomer,
            creditFeature,
            baseDiagnostics,
          )
        : mode === "auto"
          ? await fetchAutoRows(
              effectiveInput,
              seedKeyword,
              billingCustomer,
              creditFeature,
              baseDiagnostics,
            )
          : await fetchManualRows(
              mode,
              effectiveInput,
              seedKeyword,
              billingCustomer,
              creditFeature,
              baseDiagnostics,
            );

    if (result.firstParty) {
      recordFirstPartyResearchRows(
        result.plannerEnvelope ?? null,
        seedKeyword,
        effectiveInput,
        billingCustomer,
      );
    } else {
      persistRows(effectiveInput, result.rows);
    }

    result.rows = annotateAndSortKeywordRows(
      result.rows,
      seedKeyword,
      effectiveInput.languageCode,
    );

    const exactRow =
      result.rows.find((row) =>
        isExactKeywordMatch(row.keyword, seedKeyword),
      ) ?? null;
    if (exactRow) {
      const hasAnyMetric =
        exactRow.searchVolume !== null ||
        exactRow.cpc !== null ||
        exactRow.keywordDifficulty !== null;
      result.seedOverview = {
        keyword: exactRow.keyword,
        exactMatchFound: true,
        metricsStatus: hasAnyMetric ? "available" : "unavailable",
        row: exactRow,
      };
    } else {
      result.seedOverview = {
        keyword: seedKeyword,
        exactMatchFound: false,
        metricsStatus: "missing_from_provider",
        row: {
          keyword: seedKeyword,
          searchVolume: null,
          trend: [],
          keywordDifficulty: null,
          cpc: null,
          competition: null,
          intent: "unknown",
          matchType: "exact",
          relevanceScore: 100,
          relevanceTier: "high",
          isWeaklyRelated: false,
        },
      };
    }

    if (result.provider === "seranking") {
      result.diagnostics.confirmedCreditsUsed = result.rows.length * 10;
    } else if (result.provider === "cache") {
      result.diagnostics.confirmedCreditsUsed = 0;
    }

    console.info(
      "keyword_research.routing-diagnostics:",
      JSON.stringify({
        ...result.diagnostics,
        servingProvider: result.provider,
        keyword: seedKeyword,
        location: input.locationCode,
      }),
    );

    return result;
  } catch (error) {
    console.error(
      "keyword_research.routing-error:",
      JSON.stringify({
        error: error instanceof Error ? error.message : String(error),
        errorStage: "research",
        diagnostics: baseDiagnostics,
      }),
    );
    throw error;
  }
}
