import { z } from "zod";
import type { SeRankingClient } from "./client";
import {
  seRankingKeywordExportItemSchema,
  seRankingKeywordSuggestionItemSchema,
} from "./schemas";
import type {
  SeRankingKeywordExportItem,
  SeRankingKeywordSuggestionItem,
} from "./types";

function extractArrayData(raw: unknown): unknown[] {
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object" && raw !== null) {
    if ("data" in raw && Array.isArray(raw.data)) return raw.data;
    if ("items" in raw && Array.isArray(raw.items)) return raw.items;
    if ("keywords" in raw && Array.isArray(raw.keywords)) return raw.keywords;
  }
  return [];
}

export type KeywordExportOptions = {
  keywords: string[];
  source?: string;
  sort?: "volume" | "cpc" | "difficulty" | "competition";
  sortOrder?: "asc" | "desc";
  historyFrom?: string;
  historyTo?: string;
};

export async function getExportKeywords(
  client: SeRankingClient,
  options: KeywordExportOptions,
): Promise<SeRankingKeywordExportItem[]> {
  const source = options.source ?? "us";
  const raw = await client.request<unknown>("/keywords/export", {
    method: "POST",
    params: { source },
    body: {
      keywords: options.keywords,
      sort: options.sort,
      sort_order: options.sortOrder,
      history_from: options.historyFrom,
      history_to: options.historyTo,
    },
  });

  const array = extractArrayData(raw);
  return z.array(seRankingKeywordExportItemSchema).parse(array);
}

export type KeywordDiscoveryOptions = {
  keyword: string;
  source?: string;
  limit?: number;
  offset?: number;
  sort?: string;
  sortOrder?: "asc" | "desc";
};

export async function getSimilarKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  const raw = await client.request<unknown>("/keywords/similar", {
    method: "GET",
    params: {
      keyword: options.keyword,
      source: options.source ?? "us",
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  return z.array(seRankingKeywordSuggestionItemSchema).parse(array);
}

export async function getRelatedKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  const raw = await client.request<unknown>("/keywords/related", {
    method: "GET",
    params: {
      keyword: options.keyword,
      source: options.source ?? "us",
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  return z.array(seRankingKeywordSuggestionItemSchema).parse(array);
}

export async function getQuestionKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  const raw = await client.request<unknown>("/keywords/questions", {
    method: "GET",
    params: {
      keyword: options.keyword,
      source: options.source ?? "us",
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  return z.array(seRankingKeywordSuggestionItemSchema).parse(array);
}

export async function getLongTailKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  const raw = await client.request<unknown>("/keywords/longtail", {
    method: "GET",
    params: {
      keyword: options.keyword,
      source: options.source ?? "us",
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const array = extractArrayData(raw);
  return z.array(seRankingKeywordSuggestionItemSchema).parse(array);
}
