import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import { isPlannerResearchFallbackEnabled } from "@/server/lib/seo-data/providers/google-ads-planner-fallback";
import {
  keywordOpportunityKey,
  scoreKeywordRelevance,
} from "@/shared/keyword-relevance";
import type { KeywordResearchRow } from "@/types/keywords";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import type {
  ResearchDiagnostics,
  ResearchResult,
  SourceAttempt,
} from "./research";
import { fetchResearchRowsBySource } from "./research-data";
import {
  MIN_NON_SEED_FOR_AUTO,
  type KeywordSource,
  type KeywordMode,
} from "./selection";
import {
  addObservations,
  classifyFailure,
  googleAdsOpportunities,
  gscOpportunities,
  observe,
  opportunity,
  type Observation,
  ARABIC_LETTER,
  MAX_LOCAL_CANDIDATES,
} from "./fallback-opportunities";

export async function researchMultipleSources(
  input: ResolvedResearchKeywordsInput,
  seed: string,
  billingCustomer: BillingCustomerContext,
  creditFeature: CreditFeature | undefined,
  base: Partial<ResearchDiagnostics>,
): Promise<ResearchResult> {
  const requestedMode = input.mode ?? "auto";
  const threshold = Math.min(input.resultLimit, MIN_NON_SEED_FOR_AUTO);
  const attempts: SourceAttempt[] = [];
  const rows = new Map<string, KeywordResearchRow>();
  const seedKey = keywordOpportunityKey(seed);
  const nonSeedCount = () => rows.size - Number(rows.has(seedKey));
  const firstSource: KeywordSource =
    requestedMode === "auto" ? "suggestions" : requestedMode;
  const primarySources: KeywordSource[] =
    requestedMode === "auto" ? ["suggestions", "related"] : [firstSource];
  const isRelevant = (keyword: string) =>
    ARABIC_LETTER.test(keyword) &&
    scoreKeywordRelevance(keyword, seed, input.languageCode).relevanceTier ===
      "high";
  let validPrimary = false;
  let primaryFailed = false;
  let plannerEnvelope: ResearchResult["plannerEnvelope"];

  for (const source of primarySources) {
    try {
      const result = await fetchResearchRowsBySource(
        {
          source,
          seedKeyword: seed,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          resultLimit: input.resultLimit,
          creditFeature,
          onlyProvider: "seranking",
        },
        billingCustomer,
      );
      const diagnostics = result.diagnostics;
      const accepted = result.rows.filter((row) =>
        ARABIC_LETTER.test(row.keyword),
      );
      const malformed =
        result.rows.length === 0 && (diagnostics?.rawItemCount ?? 0) > 0;
      attempts.push({
        ...diagnostics,
        source,
        provider: "seranking",
        status: malformed
          ? "invalid_response"
          : accepted.length > 0
            ? "available"
            : "no_coverage",
        rowCount: accepted.length,
        nonSeedCount: accepted.filter(
          (row) => keywordOpportunityKey(row.keyword) !== seedKey,
        ).length,
      });
      addObservations(
        rows,
        accepted.map((row) =>
          observe(
            row,
            "seranking",
            diagnostics?.fetchedAt ?? null,
            diagnostics?.fromCache ? "hit" : "miss",
          ),
        ),
        input.resultLimit,
      );
      if (malformed) {
        primaryFailed = true;
        break;
      }
      validPrimary = true;
      if (nonSeedCount() >= threshold || rows.size >= input.resultLimit) break;
    } catch (error) {
      attempts.push({
        source,
        provider: "seranking",
        status: classifyFailure(error),
        rowCount: 0,
        nonSeedCount: 0,
        endpoint:
          source === "related"
            ? "/v1/keywords/related"
            : "/v1/keywords/similar",
        ...(error instanceof ProviderUnavailableError
          ? { reason: error.message }
          : {}),
      });
      primaryFailed = true;
      // Suggestions and ideas share an endpoint. No additional paid SE request
      // follows an error, including credit, quota, validation and auth errors.
      break;
    }
  }

  function recordFallback(
    source: "google_ads" | "gsc" | "internal",
    observations: Observation[],
    details: Partial<SourceAttempt> = {},
  ) {
    const accepted = observations.filter(({ row }) =>
      ARABIC_LETTER.test(row.keyword),
    );
    attempts.push({
      source,
      provider: source,
      status: accepted.length ? "available" : "no_coverage",
      rowCount: accepted.length,
      nonSeedCount: accepted.filter(
        ({ row }) => keywordOpportunityKey(row.keyword) !== seedKey,
      ).length,
      ...details,
    });
    addObservations(rows, accepted, input.resultLimit);
  }

  if (nonSeedCount() < threshold && rows.size < input.resultLimit) {
    const adsEnabled =
      base.enabledProviders?.includes("google_ads") &&
      (await isPlannerResearchFallbackEnabled());
    if (validPrimary && !primaryFailed && adsEnabled) {
      try {
        const planner = await googleAdsOpportunities(
          input,
          seed,
          billingCustomer,
        );
        plannerEnvelope = planner.envelope;
        recordFallback("google_ads", planner.observations, {
          endpoint: "GenerateKeywordIdeas",
          fromCache: planner.fromCache,
          attemptedProviders: planner.attemptedProviders,
        });
      } catch (error) {
        recordFallback("google_ads", [], {
          status: classifyFailure(error),
          ...(error instanceof ProviderUnavailableError
            ? { reason: error.message }
            : {}),
        });
      }
    } else {
      recordFallback("google_ads", [], {
        status: "skipped",
        reason: primaryFailed
          ? "SE Ranking did not confirm insufficient coverage"
          : "Automatic Keyword Planner fallback is disabled",
      });
    }

    if (base.enabledProviders?.includes("gsc")) {
      try {
        const observations = await gscOpportunities(
          input,
          billingCustomer.organizationId,
          isRelevant,
        );
        recordFallback("gsc", observations, {
          endpoint: "searchAnalytics.query",
          attemptedProviders: ["gsc"],
          fromCache: false,
        });
      } catch (error) {
        recordFallback("gsc", [], {
          status: classifyFailure(error),
          ...(error instanceof Error && error.name === "GscNotConnectedError"
            ? { reason: "No verified property is connected to this project" }
            : {}),
        });
      }
    } else {
      recordFallback("gsc", [], {
        status: "skipped",
        reason: "Search Console is disabled",
      });
    }

    try {
      const local = await KeywordResearchRepository.listResearchOpportunities({
        ...input,
        organizationId: billingCustomer.organizationId,
        limit: MAX_LOCAL_CANDIDATES,
      });
      recordFallback(
        "internal",
        local
          .filter(({ keyword }) => isRelevant(keyword))
          .map(({ keyword, observedAt }) =>
            observe(opportunity(keyword), "internal", observedAt, "stored"),
          ),
      );
    } catch (error) {
      recordFallback("internal", [], { status: classifyFailure(error) });
    }
  }

  return buildResearchResult({
    resultRows: [...rows.values()],
    attempts,
    firstSource,
    base,
    requestedMode,
    threshold,
    nonSeedCount: nonSeedCount(),
    plannerEnvelope,
    primaryFailed,
  });
}

function buildResearchResult({
  resultRows,
  attempts,
  firstSource,
  base,
  requestedMode,
  threshold,
  nonSeedCount,
  plannerEnvelope,
  primaryFailed,
}: {
  resultRows: KeywordResearchRow[];
  attempts: SourceAttempt[];
  firstSource: KeywordSource;
  base: Partial<ResearchDiagnostics>;
  requestedMode: KeywordMode;
  threshold: number;
  nonSeedCount: number;
  plannerEnvelope: ResearchResult["plannerEnvelope"];
  primaryFailed: boolean;
}): ResearchResult {
  const servingProviders = [
    ...new Set(
      resultRows.flatMap((row) =>
        (row.attribution ?? []).map(({ source }) => source),
      ),
    ),
  ];
  const provider =
    servingProviders.length > 1 ? "multiple" : (servingProviders[0] ?? "none");
  const attemptedProviders = [
    ...new Set(attempts.flatMap((attempt) => attempt.attemptedProviders ?? [])),
  ];
  return {
    provider,
    rows: resultRows,
    source:
      attempts.find((attempt) => attempt.rowCount > 0)?.source ?? firstSource,
    usedFallback:
      servingProviders.some((name) => name !== "seranking") ||
      (resultRows.length > 0 &&
        attempts
          .slice(1)
          .some(
            (attempt) =>
              attempt.provider === "seranking" && attempt.rowCount > 0,
          )),
    plannerEnvelope,
    diagnostics: {
      ...base,
      requestedMode,
      threshold,
      sourceAttempts: attempts,
      attemptedProviders,
      attemptedProvider: attemptedProviders[0] ?? null,
      servingProviders,
      servingProvider: resultRows.length ? provider : null,
      providerReturnedData: resultRows.length ? provider : null,
      fromCache:
        attempts.some(({ fromCache }) => fromCache === true) &&
        attempts.every(
          ({ fromCache, rowCount }) =>
            fromCache === true || (fromCache === undefined && rowCount === 0),
        ),
      coverage:
        nonSeedCount >= threshold
          ? "sufficient"
          : resultRows.length
            ? "partial"
            : "empty",
      confirmedCreditsUsed: primaryFailed
        ? null
        : attempts
            .filter(
              (attempt) =>
                attempt.provider === "seranking" &&
                attempt.attemptedProviders?.includes("seranking"),
            )
            .reduce(
              (total, attempt) =>
                total +
                (attempt.parsedItemCount ?? attempt.mappedRowCount ?? 0) * 10,
              0,
            ),
    },
  };
}
