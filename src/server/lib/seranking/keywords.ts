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

export type SeRankingKeywordDiscoveryMeta = {
  endpoint: string;
  upstreamTotal: number | null;
  rawItemCount: number;
  parsedItemCount: number;
};

const keywordDiscoveryMetaMap = new WeakMap<
  SeRankingKeywordSuggestionItem[],
  SeRankingKeywordDiscoveryMeta
>();

export function getKeywordDiscoveryMeta(
  items: SeRankingKeywordSuggestionItem[],
): SeRankingKeywordDiscoveryMeta | undefined {
  return keywordDiscoveryMetaMap.get(items);
}

function extractUpstreamTotal(raw: unknown): number | null {
  if (typeof raw !== "object" || raw === null || !("total" in raw)) {
    return null;
  }
  const value = (raw as { total?: unknown }).total;
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

export function extractKeywordDiscoveryPayload(
  raw: unknown,
  endpoint: string,
): { items: unknown[]; upstreamTotal: number | null } {
  if (Array.isArray(raw)) {
    return { items: raw, upstreamTotal: null };
  }
  if (typeof raw === "object" && raw !== null) {
    const upstreamTotal = extractUpstreamTotal(raw);
    if ("keywords" in raw && Array.isArray(raw.keywords)) {
      return { items: raw.keywords, upstreamTotal };
    }
    if ("data" in raw && Array.isArray(raw.data)) {
      return { items: raw.data, upstreamTotal };
    }
    if ("items" in raw && Array.isArray(raw.items)) {
      return { items: raw.items, upstreamTotal };
    }
    const keys = Object.keys(raw).slice(0, 10).join(", ");
    throw new SeRankingValidationError(
      `SE Ranking ${endpoint} returned an unexpected response shape (object with keys: [${keys}])`,
      undefined,
      200,
      0,
    );
  }
  const receivedType = raw === null ? "null" : typeof raw;
  throw new SeRankingValidationError(
    `SE Ranking ${endpoint} returned an unexpected response shape (${receivedType})`,
    undefined,
    200,
    0,
  );
}

function extractArrayData(
  raw: unknown,
  endpoint = "/keywords/export",
): unknown[] {
  return extractKeywordDiscoveryPayload(raw, endpoint).items;
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

async function fetchKeywordDiscovery(
  client: SeRankingClient,
  endpoint: string,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  const source = options.source ?? "us";
  const raw = await client.request<unknown>(endpoint, {
    method: "GET",
    params: {
      keyword: options.keyword,
      source,
      limit: options.limit,
      offset: options.offset,
      sort: options.sort,
      sort_order: options.sortOrder,
    },
  });

  const { items: array, upstreamTotal } = extractKeywordDiscoveryPayload(
    raw,
    endpoint,
  );
  if (
    array.length === 0 &&
    upstreamTotal !== null &&
    upstreamTotal > (options.offset ?? 0)
  ) {
    throw new SeRankingValidationError(
      `SE Ranking ${endpoint} reported keyword results but returned no items.`,
      undefined,
      200,
      0,
    );
  }
  const parsed = parseKeywordSuggestionItems(array, endpoint);
  const meta: SeRankingKeywordDiscoveryMeta = {
    endpoint: `/v1${endpoint}`,
    upstreamTotal,
    rawItemCount: array.length,
    parsedItemCount: parsed.length,
  };
  keywordDiscoveryMetaMap.set(parsed, meta);

  console.info(
    "[seranking] keyword-discovery-diagnostics:",
    JSON.stringify({
      endpoint: meta.endpoint,
      source,
      keyword: options.keyword,
      limit: options.limit ?? null,
      upstreamTotal: meta.upstreamTotal,
      rawItemCount: meta.rawItemCount,
      parsedItemCount: meta.parsedItemCount,
    }),
  );

  return parsed;
}

export async function getSimilarKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  return fetchKeywordDiscovery(client, "/keywords/similar", options);
}

export async function getRelatedKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  return fetchKeywordDiscovery(client, "/keywords/related", options);
}

export async function getQuestionKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  return fetchKeywordDiscovery(client, "/keywords/questions", options);
}

export async function getLongTailKeywords(
  client: SeRankingClient,
  options: KeywordDiscoveryOptions,
): Promise<SeRankingKeywordSuggestionItem[]> {
  return fetchKeywordDiscovery(client, "/keywords/longtail", options);
}
