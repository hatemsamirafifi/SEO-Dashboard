import { useEffect, useMemo, useRef } from "react";
import { useQuery } from "@tanstack/react-query";
import { getStandardErrorMessage } from "@/client/lib/error-messages";
import { captureClientEvent } from "@/client/lib/posthog";
import { LOCATIONS } from "@/client/features/keywords/utils";
import { parseKeywordInput } from "@/client/features/keywords/state/keywordControllerActions";
import { researchKeywords } from "@/serverFunctions/keywords";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { recordKeywordResearchTraceFailure } from "./keywordResearchTraceHelper";
import type {
  KeywordMode,
  ResearchSource,
  ResultLimit,
} from "@/client/features/keywords/keywordResearchTypes";
import {
  KEYWORD_SOURCE_LABELS,
  KEYWORD_SOURCE_STATUS_LABELS,
} from "@/shared/keyword-research-sources";
import type { ResearchDiagnostics } from "@/server/features/keywords/services/research/research";
import type { GlobalTraceProviderCall } from "@/shared/globalTraceTypes";

type AddSearchFn = (
  keyword: string,
  locationCode: number,
  locationName: string,
) => void;

type KeywordResearchRequestInput = {
  projectId: string;
  keywordInput: string;
  locationCode: number | undefined;
  resultLimit: ResultLimit;
  mode: KeywordMode;
  clickstream: boolean;
};

type KeywordResearchQueryInput = KeywordResearchRequestInput & {
  displayedLocationCode: number;
};

type KeywordResearchRequest = {
  projectId: string;
  keywords: string[];
  seedKeyword: string;
  locationCode: number | undefined;
  resultLimit: ResultLimit;
  mode: KeywordMode;
  clickstream: boolean;
};

export const KEYWORD_RESEARCH_STALE_TIME_MS = 24 * 60 * 60 * 1000;
const PARTIAL_RESEARCH_STALE_TIME_MS = 5 * 60 * 1000;

function traceResearchSources(diagnostics: ResearchDiagnostics) {
  const counts = new Map<string, number>();
  const providers: GlobalTraceProviderCall[] = [];
  for (const attempt of diagnostics.sourceAttempts) {
    if (!attempt.provider || !attempt.status) continue;
    const provider = KEYWORD_SOURCE_LABELS[attempt.provider];
    const executed =
      attempt.attemptedProviders?.includes(attempt.provider) === true;
    if (executed) counts.set(provider, (counts.get(provider) ?? 0) + 1);
    providers.push({
      provider,
      endpoint: attempt.endpoint ?? undefined,
      statusMessage:
        KEYWORD_SOURCE_STATUS_LABELS[attempt.status] +
        (attempt.fromCache ? " · cached" : ""),
      skipReason: attempt.reason,
      resultCount: attempt.rowCount,
      dispatched: executed
        ? true
        : attempt.fromCache || attempt.status === "skipped"
          ? false
          : undefined,
      billing: attempt.provider === "seranking" ? "Paid" : "Free",
      metered: executed && attempt.provider === "seranking",
      budgetGuard: attempt.status === "credit_limit" ? "BLOCKED" : undefined,
    });
  }
  return {
    providers,
    providerBreakdown: Array.from(counts, ([provider, count]) => ({
      provider,
      count,
    })),
    providerCalls: [...counts.values()].reduce((sum, count) => sum + count, 0),
  };
}

export function buildKeywordResearchRequest(
  input: KeywordResearchRequestInput,
): KeywordResearchRequest | null {
  const keywords = parseKeywordInput(input.keywordInput);
  const seedKeyword = keywords[0] ?? "";
  if (!seedKeyword) return null;

  return {
    projectId: input.projectId,
    keywords,
    seedKeyword,
    locationCode: input.locationCode,
    resultLimit: input.resultLimit,
    mode: input.mode,
    clickstream: input.clickstream,
  };
}

export function buildKeywordResearchQueryKey(
  request: KeywordResearchRequest | null,
) {
  return request
    ? [
        "keywordResearch",
        request.projectId,
        request.keywords,
        request.locationCode,
        request.resultLimit,
        request.mode,
        request.clickstream,
      ]
    : ["keywordResearch", "idle"];
}

function formatServingProviderLabel(rawProvider?: string | null): string {
  if (!rawProvider) return "SE Ranking";
  const p = rawProvider.toLowerCase();
  if (p === "seranking" || p === "se ranking") return "SE Ranking";
  if (p === "google_ads" || p === "google ads") return "Google Ads";
  if (p === "dataforseo" || p === "data for seo") return "DataForSEO";
  if (p === "cache") return "Cache";
  return rawProvider;
}

function resolveServingProviderEndpoint(
  provider: string,
  source?: string,
): string {
  if (provider === "SE Ranking") {
    return source === "related"
      ? "/v1/keywords/related"
      : "/v1/keywords/similar";
  }
  if (provider === "Google Ads") {
    return "GenerateKeywordIdeas";
  }
  return "v3/dataforseo_labs/google/keyword_suggestions/live";
}

export async function keywordResearchQueryFn(request: KeywordResearchRequest) {
  const opId = globalTraceStore.startOperation({
    feature: "keyword_research",
    operation: "keyword_research.research",
    source: "Keyword Research page",
    projectId: request.projectId,
    status: "running",
    cache: "Not applicable",
    metadata: {
      keywords: request.keywords,
      mode: request.mode,
      locationCode: request.locationCode,
    },
  });

  try {
    const result = await researchKeywords({
      data: {
        projectId: request.projectId,
        keywords: request.keywords,
        locationCode: request.locationCode,
        resultLimit: request.resultLimit,
        mode: request.mode,
        clickstream: request.clickstream,
      },
    });

    if (result.diagnostics?.coverage) {
      const sources = traceResearchSources(result.diagnostics);
      const attempts = result.diagnostics.sourceAttempts;
      const blocked = attempts.some(({ status }) => status === "credit_limit");
      globalTraceStore.completeOperation(opId, {
        status: "success",
        httpStatus: 200,
        provider:
          result.diagnostics.servingProviders
            ?.map((name) => KEYWORD_SOURCE_LABELS[name])
            .join(", ") || undefined,
        ...sources,
        cache: attempts.some(({ fromCache }) => fromCache === false)
          ? "MISS"
          : attempts.some(({ fromCache }) => fromCache === true)
            ? "HIT"
            : "Not applicable",
        metered: sources.providers.some(({ metered }) => metered),
        budget: blocked ? "BLOCKED" : undefined,
        counters: { results: result.rows.length },
        metadata: {
          keywords: request.keywords,
          mode: request.mode,
          locationCode: request.locationCode,
          coverage: result.diagnostics.coverage,
          sourceAttempts: attempts,
          skippedProviders: result.diagnostics.skippedProviders,
          confirmedCreditsUsed: result.diagnostics.confirmedCreditsUsed,
        },
      });
      return result;
    }

    const resultObj =
      typeof result === "object" && result !== null
        ? (result as {
            provider?: string;
            diagnostics?: { servingProvider?: string };
          })
        : null;
    const providerLabel = formatServingProviderLabel(
      resultObj?.provider ?? resultObj?.diagnostics?.servingProvider,
    );
    const endpoint = resolveServingProviderEndpoint(
      providerLabel,
      result?.source,
    );

    globalTraceStore.completeOperation(opId, {
      status: "success",
      httpStatus: 200,
      provider: providerLabel,
      providerCalls: 1,
      providerBreakdown: [{ provider: providerLabel, count: 1 }],
      providers: [
        {
          provider: providerLabel,
          endpoint,
          httpStatus: 200,
          taskStatus: 20000,
          transport: "HTTP",
          billing: providerLabel === "Google Ads" ? "Free" : "Paid",
          metered: providerLabel !== "Google Ads",
          budgetGuard: "PASS",
        },
      ],
      counters: {
        results: result?.rows?.length ?? 0,
      },
    });

    return result;
  } catch (error) {
    recordKeywordResearchTraceFailure(opId, error, request);
    throw error;
  }
}

export function useKeywordResearchData(
  input: KeywordResearchQueryInput,
  addSearch: AddSearchFn,
) {
  const {
    clickstream,
    displayedLocationCode,
    keywordInput,
    locationCode,
    mode,
    projectId,
    resultLimit,
  } = input;
  const request = useMemo<KeywordResearchRequest | null>(
    () =>
      buildKeywordResearchRequest({
        keywordInput,
        locationCode,
        mode,
        projectId,
        resultLimit,
        clickstream,
      }),
    [clickstream, keywordInput, locationCode, mode, projectId, resultLimit],
  );
  const queryKey = useMemo(
    () => buildKeywordResearchQueryKey(request),
    [request],
  );
  const queryKeyString = JSON.stringify(queryKey);

  const researchQuery = useQuery({
    queryKey,
    queryFn: () => {
      if (!request) {
        throw new Error("Keyword research query ran without request params");
      }

      return keywordResearchQueryFn(request);
    },
    enabled: request !== null,
    staleTime: (query) => {
      const result = query.state.data;
      return result &&
        (result.rows.length === 0 ||
          result.usedFallback ||
          result.diagnostics?.coverage === "partial")
        ? PARTIAL_RESEARCH_STALE_TIME_MS
        : KEYWORD_RESEARCH_STALE_TIME_MS;
    },
    gcTime: KEYWORD_RESEARCH_STALE_TIME_MS,
    retry: false,
    refetchOnReconnect: false,
    refetchOnWindowFocus: false,
  });

  const handledSuccessKeyRef = useRef<string | null>(null);
  useEffect(() => {
    if (!request || !researchQuery.isSuccess || !researchQuery.data) return;
    if (handledSuccessKeyRef.current === queryKeyString) return;
    handledSuccessKeyRef.current = queryKeyString;

    captureClientEvent("keyword_research:search_complete", {
      location_code: displayedLocationCode,
      search_mode: request.mode,
      clickstream: request.clickstream,
      result_count: researchQuery.data.rows.length,
    });

    addSearch(
      request.seedKeyword,
      displayedLocationCode,
      LOCATIONS[displayedLocationCode] || "Unknown",
    );
  }, [
    addSearch,
    displayedLocationCode,
    queryKeyString,
    request,
    researchQuery.data,
    researchQuery.isSuccess,
  ]);

  const hasSearched = parseKeywordInput(keywordInput).length > 0;
  const rows = hasSearched ? (researchQuery.data?.rows ?? []) : [];
  const researchError =
    hasSearched && researchQuery.isError
      ? getStandardErrorMessage(researchQuery.error, "Research failed.")
      : null;

  return {
    rows,
    hasSearched,
    lastSearchError: hasSearched && researchQuery.isError,
    lastResultSource:
      researchQuery.data?.source ?? ("related" as ResearchSource),
    lastUsedFallback: researchQuery.data?.usedFallback ?? false,
    lastSearchKeyword: request?.seedKeyword ?? "",
    lastSearchLocationCode: displayedLocationCode,
    researchError,
    researchMutationError: researchQuery.error,
    searchedKeyword: request?.seedKeyword ?? "",
    isLoading: hasSearched && researchQuery.isPending,
    researchQuery,
    retryResearch: researchQuery.refetch,
  };
}
