import {
  type AdsKeywordIdeaItem,
  type LabsKeywordDataItem,
} from "@/server/lib/dataforseo";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { CreditFeature } from "@/shared/billing-credit-features";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import type { KeywordIdeasSource } from "@/server/lib/seo-data/providers/dataforseo-provider";
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

// `related` items wrap the keyword payload one level deeper than the
// suggestions/ideas items; providers return raw SDK items so the mappers below
// stay in this module.
type RelatedKeywordResultItem = {
  keyword_data?: LabsKeywordDataItem | null;
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

function mapResearchIdeasPayload(data: unknown): EnrichedKeyword[] {
  if (Array.isArray(data)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the array branch is the DFS keywords_for_keywords item shape routed by this call
    return mapAdsKeywordItems(data as AdsKeywordIdeaItem[]);
  }
  if (typeof data === "object" && data !== null) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- envelope handling: data is only known to be an object here
    const envelope = data as { ideas?: unknown; keywords?: unknown };
    return mapGoogleResearchRecords([
      ...asRecordRows(envelope.ideas),
      ...asRecordRows(envelope.keywords),
    ]);
  }
  // Neither shape — surface an explicit shape error instead of crashing
  // downstream with "items is not iterable".
  throw new Error("Unsupported keyword_ideas payload shape");
}

/** Research rows for countries DataForSEO Labs doesn't support, plus the
 *  provenance signal the consumer needs to route persistence honestly:
 *  `servedFirstParty` is true only when the payload was the first-party
 *  planner envelope (an object), never for the legacy DFS item array. */
export type GoogleAdsResearchRows = {
  rows: EnrichedKeyword[];
  servedFirstParty: boolean;
};

export async function fetchGoogleAdsResearchRows(
  params: Omit<FetchResearchRowsParams, "source">,
  billingCustomer: BillingCustomerContext,
): Promise<GoogleAdsResearchRows> {
  // DataForSEO's keywords_for_keywords (Google Ads) endpoint. The router's
  // google_ads API provider does not apply this source (see the adsIdeas
  // branch in the DataForSEO provider), so the DFS provider serves it —
  // unless the project runs first-party, in which case the google_ads
  // provider wins the walk and answers with its planner envelope instead.
  const { data } = await getSeoDataRouter().route({
    dataType: "keyword_ideas",
    keyword: params.seedKeyword,
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    billingCustomer,
    creditFeature: params.creditFeature,
    constraints: {
      source: "google_ads" satisfies KeywordIdeasSource,
      limit: params.resultLimit,
    },
  });
  return {
    rows: mapResearchIdeasPayload(data),
    servedFirstParty:
      typeof data === "object" && data !== null && !Array.isArray(data),
  };
}

export async function fetchResearchRowsBySource(
  params: FetchResearchRowsParams,
  billingCustomer: BillingCustomerContext,
): Promise<EnrichedKeyword[]> {
  const constraints = {
    source: params.source satisfies KeywordIdeasSource,
    limit: params.resultLimit,
    ...(params.source === "related" ? { depth: 1 } : {}),
    includeClickstreamData: params.includeClickstreamData,
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

  if (params.source === "related") {
    // Related items wrap the keyword payload one level deeper; unwrap and
    // reuse the same mapper as suggestions/ideas.
    const { data: relatedItems } =
      await getSeoDataRouter().route<RelatedKeywordResultItem[]>(request);
    return mapKeywordDataItems(
      relatedItems
        .map((item) => item.keyword_data)
        .filter((data): data is NonNullable<typeof data> => data != null),
    );
  }

  if (params.source !== "ideas") {
    // `suggestions` stays on the Labs item mapper: DataForSEO serves this
    // mode and the planner never claims it.
    const { data } =
      await getSeoDataRouter().route<LabsKeywordDataItem[]>(request);
    return mapKeywordDataItems(data);
  }

  // The "ideas" mode is the only one the first-party provider claims, so the
  // payload may legitimately arrive in either shape here.
  const { data } = await getSeoDataRouter().route(request);
  return mapResearchIdeasPayload(data);
}
