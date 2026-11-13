import type { SeRankingClient } from "./client";
import { SeRankingValidationError } from "./errors";
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

export function parseKeywordSuggestionItems(
  array: unknown[],
  endpoint = "/keywords/similar",
): SeRankingKeywordSuggestionItem[] {
  const result: SeRankingKeywordSuggestionItem[] = [];
  const errors: Array<{
    index: number;
    issues: Array<{
      path: string;
      expected?: string;
      received?: string;
      message: string;
    }>;
  }> = [];

  for (let i = 0; i < array.length; i++) {
    const parsed = seRankingKeywordSuggestionItemSchema.safeParse(array[i]);
    if (parsed.success) {
      result.push(parsed.data);
    } else {
      const issues = parsed.error.issues.map((issue) => {
        const expected =
          "expected" in issue ? String(issue.expected) : undefined;
        const received =
          "received" in issue ? String(issue.received) : undefined;
        return {
          path: issue.path.join("."),
          expected,
          received,
          message: issue.message,
        };
      });
      errors.push({ index: i, issues });
    }
  }

  if (errors.length > 0) {
    console.warn(
      `[seranking] Validation issues on ${endpoint}: ${errors.length}/${array.length} items failed validation:`,
      JSON.stringify(errors.slice(0, 5)),
    );
  }

  if (array.length > 0 && result.length === 0) {
    throw new SeRankingValidationError(
      `SE Ranking ${endpoint} returned ${array.length} items, but none matched the expected keyword schema. Validation issues: ${JSON.stringify(errors.slice(0, 3))}`,
      undefined,
      200,
      array.length,
    );
  }

  return result;
}

export function parseKeywordExportItems(
  array: unknown[],
  endpoint = "/keywords/export",
): SeRankingKeywordExportItem[] {
  const result: SeRankingKeywordExportItem[] = [];
  const errors: Array<{
    index: number;
    issues: Array<{
      path: string;
      expected?: string;
      received?: string;
      message: string;
    }>;
  }> = [];

  for (let i = 0; i < array.length; i++) {
    const parsed = seRankingKeywordExportItemSchema.safeParse(array[i]);
    if (parsed.success) {
      result.push(parsed.data);
    } else {
      const issues = parsed.error.issues.map((issue) => {
        const expected =
          "expected" in issue ? String(issue.expected) : undefined;
        const received =
          "received" in issue ? String(issue.received) : undefined;
        return {
          path: issue.path.join("."),
          expected,
          received,
          message: issue.message,
        };
      });
      errors.push({ index: i, issues });
    }
  }

  if (errors.length > 0) {
    console.warn(
      `[seranking] Validation issues on ${endpoint}: ${errors.length}/${array.length} items failed validation:`,
      JSON.stringify(errors.slice(0, 5)),
    );
  }

  if (array.length > 0 && result.length === 0) {
    throw new SeRankingValidationError(
      `SE Ranking ${endpoint} returned ${array.length} items, but none matched the expected keyword schema. Validation issues: ${JSON.stringify(errors.slice(0, 3))}`,
      undefined,
      200,
      array.length,
    );
  }

  return result;
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
  return parseKeywordExportItems(array, "/keywords/export");
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
  return parseKeywordSuggestionItems(array, "/keywords/similar");
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
  return parseKeywordSuggestionItems(array, "/keywords/related");
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
  return parseKeywordSuggestionItems(array, "/keywords/questions");
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
  return parseKeywordSuggestionItems(array, "/keywords/longtail");
}
