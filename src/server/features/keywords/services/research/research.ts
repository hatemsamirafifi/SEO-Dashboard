import { AppError } from "@/server/lib/errors";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import type { KeywordResearchRow } from "@/types/keywords";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import { getKeywordDataProvider } from "@/shared/keyword-locations";
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

type SourceAttempt = {
  source: ResearchSource;
  rowCount: number;
  nonSeedCount: number;
};

type ResearchDiagnostics = {
  requestedMode: KeywordMode;
  threshold: number;
  sourceAttempts: SourceAttempt[];
};

type ResearchResult = {
  rows: KeywordResearchRow[];
  source: ResearchSource;
  usedFallback: boolean;
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
): Promise<EnrichedKeyword[]> {
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
): Promise<ResearchResult> {
  const attempts: SourceAttempt[] = [];
  let lastSource: KeywordSource = AUTO_KEYWORD_SOURCES[0];
  const accumulatedRows: EnrichedKeyword[] = [];
  const seenKeywords = new Set<string>();

  for (const source of AUTO_KEYWORD_SOURCES) {
    const rows = await fetchRowsFromSource(
      source,
      input,
      seedKeyword,
      billingCustomer,
      creditFeature,
    );
    for (const row of rows) {
      if (accumulatedRows.length >= input.resultLimit) break;
      if (seenKeywords.has(row.keyword)) continue;
      seenKeywords.add(row.keyword);
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
        rows: accumulatedRows,
        source,
        usedFallback: source !== AUTO_KEYWORD_SOURCES[0],
        diagnostics: {
          requestedMode: "auto",
          threshold: MIN_NON_SEED_FOR_AUTO,
          sourceAttempts: attempts,
        },
      };
    }
  }

  return {
    rows: accumulatedRows,
    source: lastSource,
    usedFallback: true,
    diagnostics: {
      requestedMode: "auto",
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: attempts,
    },
  };
}

async function fetchGoogleAdsRows(
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<ResearchResult> {
  const { rows, servedFirstParty, plannerEnvelope } =
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
      requestedMode,
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: [
        {
          source: "google_ads",
          rowCount: rows.length,
          nonSeedCount: countNonSeedKeywords(rows, seedKeyword),
        },
      ],
    },
  };
}

async function fetchManualRows(
  mode: Exclude<KeywordMode, "auto">,
  input: ResolvedResearchKeywordsInput,
  seedKeyword: string,
  billingCustomer: BillingCustomerContext,
  creditFeature?: CreditFeature,
): Promise<ResearchResult> {
  const rows = await fetchRowsFromSource(
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
    rows,
    source: mode,
    usedFallback: false,
    diagnostics: {
      requestedMode: mode,
      threshold: MIN_NON_SEED_FOR_AUTO,
      sourceAttempts: [attempt],
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
        )
      : mode === "auto"
        ? await fetchAutoRows(
            effectiveInput,
            seedKeyword,
            billingCustomer,
            creditFeature,
          )
        : await fetchManualRows(
            mode,
            effectiveInput,
            seedKeyword,
            billingCustomer,
            creditFeature,
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

  return result;
}
