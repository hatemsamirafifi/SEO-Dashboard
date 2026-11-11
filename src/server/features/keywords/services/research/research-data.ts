/* eslint-disable eslint/max-lines, eslint/complexity */
import {
  type AdsKeywordIdeaItem,
  type LabsKeywordDataItem,
} from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import {
  parseStoredPlannerEnvelope,
  type ParsedPlannerEnvelope,
} from "@/server/lib/seo-data/providers/planner-envelope";
import type { KeywordIdeasSource } from "@/server/lib/seo-data/providers/dataforseo-provider";
import type { MonthlySearch } from "@/types/keywords";
import {
  normalizeIntent,
  normalizeKeyword,
  type EnrichedKeyword,
} from "./helpers";
import { mapGoogleResearchRecords } from "./google-records";
import type { KeywordSource } from "./selection";
import type { GoogleAdsKeywordRecord } from "@/server/lib/googleAdsPlanner";

type FetchResearchRowsParams = {
  seedKeyword: string;
  locationCode: number;
  languageCode: string;
  resultLimit: number;
  source: KeywordSource;
  includeClickstreamData?: boolean;
  // Attribute the DataForSEO spend to a specific feature (e.g. "onboarding");
  // defaults to the path-derived feature when omitted.
  creditFeature?: CreditFeature;
};

export function mapKeywordDataItems(
  items: LabsKeywordDataItem[],
): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // The clickstream-normalized block only exists when the caller opted into
    // clickstream data (it doubles the request cost); prefer it when present.
    const keywordInfo = item.keyword_info_normalized_with_clickstream
      ?.search_volume
      ? item.keyword_info_normalized_with_clickstream
      : item.keyword_info;

    rows.push({
      keyword: normalized,
      searchVolume: keywordInfo?.search_volume ?? null,
      trend: (keywordInfo?.monthly_searches ?? []).map((entry) => ({
        year: entry.year ?? 0,
        month: entry.month ?? 0,
        searchVolume: entry.search_volume ?? 0,
      })),
      cpc: item.keyword_info?.cpc ?? null,
      competition: item.keyword_info?.competition ?? null,
      keywordDifficulty: item.keyword_properties?.keyword_difficulty ?? null,
      intent: normalizeIntent(item.search_intent_info?.main_intent),
    });
  }

  return rows;
}

/**
 * Google Ads items carry volume / CPC / paid competition but no keyword
 * difficulty or search intent (those are Labs-only).
 */
export function mapAdsKeywordItems(
  items: AdsKeywordIdeaItem[],
): EnrichedKeyword[] {
  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const item of items) {
    const keyword = item.keyword;
    if (!keyword) continue;

    const normalized = normalizeKeyword(keyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    rows.push({
      keyword: normalized,
      searchVolume: item.search_volume ?? null,
      trend: (item.monthly_searches ?? []).map((entry) => ({
        year: entry.year ?? 0,
        month: entry.month ?? 0,
        searchVolume: entry.search_volume ?? 0,
      })),
      cpc: item.cpc ?? null,
      competition:
        item.competition_index != null ? item.competition_index / 100 : null,
      keywordDifficulty: null,
      intent: "unknown",
    });
  }

  return rows;
}

/** The router serves keyword_ideas from two payload shapes:
 *  - legacy `AdsKeywordIdeaItem[]` / `LabsKeywordDataItem[]` arrays
 *    (DataForSEO), and
 *  - the first-party Google Ads planner envelope (an object with
 *    `source: "google_ads"` plus `ideas` / `keywords` record arrays).
 *  Discriminate structurally — never by trusting the typed response body
 *  against the runtime reality.
 */
function asRecordRows(value: unknown): GoogleAdsKeywordRecord[] {
  return Array.isArray(value)
    ? // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- planner record rows are validated downstream by the google-records mappers
      (value as GoogleAdsKeywordRecord[])
    : [];
}

/** Splits a keyword_ideas payload into its two shapes:
 *  - legacy `AdsKeywordIdeaItem[]` / `LabsKeywordDataItem[]` arrays
 *    (DataForSEO), and
 *  - the first-party Google Ads planner envelope (an object with
 *    `source: "google_ads"` plus `ideas` / `keywords` record arrays).
 *  Discriminate structurally — never by trusting the typed response body
 *  against the runtime reality. */
function isLabsKeywordDataItems(
  value: unknown,
): value is LabsKeywordDataItem[] {
  if (!Array.isArray(value)) return false;
  if (value.length === 0) return true;
  const first = value[0];
  return (
    typeof first === "object" &&
    first !== null &&
    ("keyword_info" in first ||
      "keyword_properties" in first ||
      "search_intent_info" in first ||
      "keyword_data" in first)
  );
}

function isAdsKeywordIdeaItems(value: unknown): value is AdsKeywordIdeaItem[] {
  return Array.isArray(value);
}

function mapResearchIdeasPayload(data: unknown): {
  rows: EnrichedKeyword[];
  records: GoogleAdsKeywordRecord[];
} {
  if (isLabsKeywordDataItems(data)) {
    return {
      rows: mapKeywordDataItems(data),
      records: [],
    };
  }
  if (isAdsKeywordIdeaItems(data)) {
    return {
      rows: mapAdsKeywordItems(data),
      records: [],
    };
  }
  if (typeof data === "object" && data !== null) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- envelope handling: data is only known to be an object here
    const envelope = data as { ideas?: unknown; keywords?: unknown };
    const records = [
      ...asRecordRows(envelope.ideas),
      ...asRecordRows(envelope.keywords),
    ];
    return { rows: mapGoogleResearchRecords(records), records };
  }
  // Neither shape — surface an explicit shape error instead of crashing
  // downstream with "items is not iterable".
  throw new Error("Unsupported keyword_ideas payload shape");
}

/** Research rows for countries DataForSEO Labs doesn't support, plus the
 *  provenance signals the consumer needs to route persistence honestly:
 *  `servedFirstParty` is true only when the payload was the first-party
 *  planner envelope (an object), never for the legacy DFS item array, and
 *  `rawPlannerRecords` carries the unflattened canonical keyword-group
 *  records the persistence hook needs (the rows array alone has already
 *  flattened close variants). */
export type GoogleAdsResearchRows = {
  rows: EnrichedKeyword[];
  provider: string;
  servedFirstParty: boolean;
  rawPlannerRecords: GoogleAdsKeywordRecord[];
  /** The R2-validated first-party envelope for the persistence hook; null
   *  for DFS-served payloads and for envelopes that fail cache re-parse. */
  plannerEnvelope: ParsedPlannerEnvelope | null;
};

export type FetchResearchRowsResult = {
  rows: EnrichedKeyword[];
  provider: string;
};

export function mapGenericKeywordItems(items: unknown): EnrichedKeyword[] {
  if (!items) return [];
  const array: unknown[] = Array.isArray(items)
    ? items
    : typeof items === "object" &&
        items !== null &&
        "data" in items &&
        Array.isArray((items as { data: unknown }).data)
      ? (items as { data: unknown[] }).data
      : typeof items === "object" &&
          items !== null &&
          "items" in items &&
          Array.isArray((items as { items: unknown }).items)
        ? (items as { items: unknown[] }).items
        : [];

  const rows: EnrichedKeyword[] = [];
  const seen = new Set<string>();

  for (const raw of array) {
    if (!raw || typeof raw !== "object") continue;
    // Unwrap if wrapped under keyword_data
    const item =
      "keyword_data" in raw &&
      raw.keyword_data &&
      typeof raw.keyword_data === "object"
        ? (raw as { keyword_data: Record<string, unknown> }).keyword_data
        : (raw as Record<string, unknown>);

    const rawKeyword = typeof item.keyword === "string" ? item.keyword : null;
    if (!rawKeyword) continue;
    const normalized = normalizeKeyword(rawKeyword);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    // 1. Direct EnrichedKeyword shape
    if ("searchVolume" in item && "keywordDifficulty" in item) {
      rows.push({
        keyword: normalized,
        searchVolume:
          typeof item.searchVolume === "number" ? item.searchVolume : null,
        trend: Array.isArray(item.trend) ? (item.trend as MonthlySearch[]) : [],
        cpc: typeof item.cpc === "number" ? item.cpc : null,
        competition:
          typeof item.competition === "number" ? item.competition : null,
        keywordDifficulty:
          typeof item.keywordDifficulty === "number"
            ? item.keywordDifficulty
            : null,
        intent: normalizeIntent(
          typeof item.intent === "string" ? item.intent : null,
        ),
      });
      continue;
    }

    // 2. SE Ranking Suggestion Item or Export Item shape (has volume or difficulty or history_trend)
    if ("volume" in item || "difficulty" in item || "history_trend" in item) {
      const historyTrend = Array.isArray(item.history_trend)
        ? (item.history_trend as Array<{ date?: string; volume?: number }>)
        : [];
      const trend: MonthlySearch[] = historyTrend.map((t) => {
        const parts = String(t?.date ?? "")
          .split("-")
          .map(Number);
        return {
          year: parts[0] || 0,
          month: parts[1] || 0,
          searchVolume: Number(t?.volume) || 0,
        };
      });
      const rawIntent =
        typeof item.intent === "string"
          ? item.intent
          : Array.isArray(item.intents) && item.intents.length > 0
            ? String(item.intents[0])
            : null;
      rows.push({
        keyword: normalized,
        searchVolume: typeof item.volume === "number" ? item.volume : null,
        trend,
        cpc: typeof item.cpc === "number" ? item.cpc : null,
        competition:
          typeof item.competition === "number" ? item.competition : null,
        keywordDifficulty:
          typeof item.difficulty === "number" ? item.difficulty : null,
        intent: normalizeIntent(rawIntent),
      });
      continue;
    }

    // 3. LabsKeywordDataItem shape (DataForSEO)
    const labsItem = item as LabsKeywordDataItem;
    const keywordInfo = labsItem.keyword_info_normalized_with_clickstream
      ?.search_volume
      ? labsItem.keyword_info_normalized_with_clickstream
      : labsItem.keyword_info;

    rows.push({
      keyword: normalized,
      searchVolume: keywordInfo?.search_volume ?? null,
      trend: (keywordInfo?.monthly_searches ?? []).map((entry) => ({
        year: entry.year ?? 0,
        month: entry.month ?? 0,
        searchVolume: entry.search_volume ?? 0,
      })),
      cpc: labsItem.keyword_info?.cpc ?? null,
      competition: labsItem.keyword_info?.competition ?? null,
      keywordDifficulty:
        labsItem.keyword_properties?.keyword_difficulty ?? null,
      intent: normalizeIntent(labsItem.search_intent_info?.main_intent),
    });
  }

  return rows;
}

export async function fetchGoogleAdsResearchRows(
  params: Omit<FetchResearchRowsParams, "source">,
  billingCustomer: BillingCustomerContext,
): Promise<GoogleAdsResearchRows> {
  const response = await getSeoDataRouter().route({
    dataType: "keyword_ideas",
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    billingCustomer,
    creditFeature: params.creditFeature,
    constraints: {
      source: "google_ads" satisfies KeywordIdeasSource,
      limit: params.resultLimit,
      projectId: billingCustomer.projectId,
    },
  });
  const data = response.data;
  const payload = mapResearchIdeasPayload(data);
  const servedFirstParty =
    typeof data === "object" && data !== null && !Array.isArray(data);
  return {
    rows: payload.rows,
    provider: response.provider,
    rawPlannerRecords: payload.records,
    servedFirstParty,
    plannerEnvelope: parseStoredPlannerEnvelope(data),
  };
}

export async function fetchResearchRowsBySource(
  params: FetchResearchRowsParams,
  billingCustomer: BillingCustomerContext,
): Promise<FetchResearchRowsResult> {
  const constraints = {
    source: params.source satisfies KeywordIdeasSource,
    limit: params.resultLimit,
    ...(params.source === "related" ? { depth: 1 } : {}),
    includeClickstreamData: params.includeClickstreamData,
    projectId: billingCustomer.projectId,
  };
  const request = {
    dataType: "keyword_ideas" as const,
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    billingCustomer,
    creditFeature: params.creditFeature,
    constraints,
  };

  const response = await getSeoDataRouter().route(request);
  const rawData = response.data !== undefined ? response.data : response;
  const provider = response.provider ?? "seranking";

  if (params.source === "ideas") {
    // Check if it's first-party Google Ads envelope
    if (
      typeof rawData === "object" &&
      rawData !== null &&
      !Array.isArray(rawData) &&
      ("ideas" in rawData || "keywords" in rawData)
    ) {
      return {
        rows: mapResearchIdeasPayload(rawData).rows,
        provider,
      };
    }
  }

  return {
    rows: mapGenericKeywordItems(rawData),
    provider,
  };
}
