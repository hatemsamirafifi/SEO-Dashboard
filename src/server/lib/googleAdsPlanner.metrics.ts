import { z } from "zod";

import type {
  GoogleAdsKeywordCompetition,
  GoogleAdsKeywordMetrics,
  GoogleAdsKeywordRecord,
  GoogleAdsMonthlySearchVolume,
  GoogleAdsParseResult,
} from "./googleAdsPlanner";

/** Google Ads v26 Keyword Planner payload parsing.
 *
 * The request builders and the public result types live in googleAdsPlanner;
 * this module owns the narrowing of upstream payloads. Splitting them keeps
 * both files inside the repository's file-size budget without a lint
 * exemption.
 *
 * Contracts:
 *  - https://developers.google.com/google-ads/api/reference/rpc/v26/KeywordPlanHistoricalMetrics
 *  - https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordIdeasRequest
 *  - https://developers.google.com/google-ads/api/reference/rpc/v26/GenerateKeywordHistoricalMetricsRequest
 *
 * Invariants:
 *  - An absent metric is null. A real zero stays zero.
 *  - int64 fields arrive as JSON strings and are only accepted when they are
 *    finite, non-negative and inside the safe-integer range.
 *  - A metric that cannot be trusted is never presented: the row is dropped
 *    and counted, so the caller can report a partial result.
 *  - ProtoJSON omits empty repeated fields and treats null like absence
 *    (protobuf.dev/programming-guides/json, Presence/default-values and
 *    Null values): an absent or null `results` list is an empty successful
 *    page, never an error. A present non-array value stays malformed.
 */

/** Narrowing schemas for the upstream payloads. */
const jsonObjectSchema = z.record(z.string(), z.unknown());
const unknownListSchema = z.array(z.unknown());
const stringListSchema = z.array(z.string());
const nonEmptyStringSchema = z
  .string()
  .refine((value) => value.trim().length > 0, { message: "empty string" });
const int64Schema = z
  .union([z.string().regex(/^\d+$/), z.number().int().nonnegative()])
  .transform((value) => Number(value))
  .refine((value) => Number.isSafeInteger(value) && value >= 0);

const MONTH_BY_NAME: Record<string, number | undefined> = {
  JANUARY: 1,
  FEBRUARY: 2,
  MARCH: 3,
  APRIL: 4,
  MAY: 5,
  JUNE: 6,
  JULY: 7,
  AUGUST: 8,
  SEPTEMBER: 9,
  OCTOBER: 10,
  NOVEMBER: 11,
  DECEMBER: 12,
};

function readObject(value: unknown): Record<string, unknown> | null {
  const parsed = jsonObjectSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

/** ProtoJSON serializers omit empty repeated fields, and a null value for a
 *  repeated field behaves the same as absence. That absence is protocol
 *  structure: it is an empty list, not a failed parse. A present non-array
 *  value is malformed and still rejected. */
function readRepeatedList(
  value: unknown,
): { ok: true; value: unknown[] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const list = unknownListSchema.safeParse(value);
  if (!list.success) return { ok: false };
  return { ok: true, value: list.data };
}

/** protobuf int64 fields arrive as JSON strings in REST. Only finite,
 *  non-negative values inside the safe-integer range are accepted; an absent
 *  value is null and a real zero stays zero. */
function readInt64(
  value: unknown,
): { ok: true; value: number | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = int64Schema.safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, value: parsed.data };
}

function readCompetition(
  value: unknown,
): { ok: true; value: GoogleAdsKeywordCompetition | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = z.string().safeParse(value);
  if (!parsed.success) return { ok: false };
  const level = parsed.data;
  // UNSPECIFIED and UNKNOWN mean "no level reported", not a level.
  if (level === "UNSPECIFIED" || level === "UNKNOWN") {
    return { ok: true, value: null };
  }
  if (level === "LOW" || level === "MEDIUM" || level === "HIGH") {
    return { ok: true, value: level };
  }
  return { ok: false };
}

function readMonthlySearchVolumes(
  value: unknown,
): { ok: true; value: GoogleAdsMonthlySearchVolume[] } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: [] };
  const list = unknownListSchema.safeParse(value);
  if (!list.success) return { ok: false };
  const volumes: GoogleAdsMonthlySearchVolume[] = [];
  for (const entry of list.data) {
    const row = readObject(entry);
    if (!row) return { ok: false };
    const year = readInt64(row.year);
    if (!year.ok || year.value === null) return { ok: false };
    if (year.value < 1000 || year.value > 9999) return { ok: false };
    const monthName = z.string().safeParse(row.month);
    if (!monthName.success) return { ok: false };
    const month = MONTH_BY_NAME[monthName.data];
    if (month === undefined) return { ok: false };
    const volume = readInt64(row.monthlySearches);
    if (!volume.ok) return { ok: false };
    volumes.push({ year: year.value, month, volume: volume.value });
  }
  return { ok: true, value: volumes };
}

function readMetrics(
  payload: unknown,
): { ok: true; value: GoogleAdsKeywordMetrics } | { ok: false } {
  if (payload === undefined || payload === null) {
    // No metrics at all: every metric is absent, not zero.
    return {
      ok: true,
      value: {
        avgMonthlySearches: null,
        monthlySearchVolumes: [],
        competition: null,
        competitionIndex: null,
        averageCpcMicros: null,
        lowTopOfPageBidMicros: null,
        highTopOfPageBidMicros: null,
      },
    };
  }
  const row = readObject(payload);
  if (!row) return { ok: false };
  const avgMonthlySearches = readInt64(row.avgMonthlySearches);
  if (!avgMonthlySearches.ok) return { ok: false };
  const monthlySearchVolumes = readMonthlySearchVolumes(
    row.monthlySearchVolumes,
  );
  if (!monthlySearchVolumes.ok) return { ok: false };
  const competition = readCompetition(row.competition);
  if (!competition.ok) return { ok: false };
  const competitionIndex = readInt64(row.competitionIndex);
  if (!competitionIndex.ok) return { ok: false };
  if (
    competitionIndex.value !== null &&
    (competitionIndex.value < 0 || competitionIndex.value > 100)
  ) {
    return { ok: false };
  }
  const averageCpcMicros = readInt64(row.averageCpcMicros);
  if (!averageCpcMicros.ok) return { ok: false };
  const lowTopOfPageBidMicros = readInt64(row.lowTopOfPageBidMicros);
  if (!lowTopOfPageBidMicros.ok) return { ok: false };
  const highTopOfPageBidMicros = readInt64(row.highTopOfPageBidMicros);
  if (!highTopOfPageBidMicros.ok) return { ok: false };
  return {
    ok: true,
    value: {
      avgMonthlySearches: avgMonthlySearches.value,
      monthlySearchVolumes: monthlySearchVolumes.value,
      competition: competition.value,
      competitionIndex: competitionIndex.value,
      averageCpcMicros: averageCpcMicros.value,
      lowTopOfPageBidMicros: lowTopOfPageBidMicros.value,
      highTopOfPageBidMicros: highTopOfPageBidMicros.value,
    },
  };
}

function readRecord(
  payload: unknown,
  metricsKey: "keywordIdeaMetrics" | "keywordMetrics",
): { ok: true; value: GoogleAdsKeywordRecord } | { ok: false } {
  const row = readObject(payload);
  if (!row) return { ok: false };
  const text = nonEmptyStringSchema.safeParse(row.text);
  if (!text.success) return { ok: false };
  let closeVariants: string[] = [];
  if (row.closeVariants !== undefined && row.closeVariants !== null) {
    const variants = stringListSchema.safeParse(row.closeVariants);
    if (!variants.success) return { ok: false };
    closeVariants = [...variants.data];
  }
  const metrics = readMetrics(row[metricsKey]);
  if (!metrics.ok) return { ok: false };
  return {
    ok: true,
    value: { keyword: text.data, closeVariants, ...metrics.value },
  };
}

function readNextPageToken(
  value: unknown,
): { ok: true; value: string | null } | { ok: false } {
  if (value === undefined || value === null) return { ok: true, value: null };
  const parsed = z.string().min(1).safeParse(value);
  if (!parsed.success) return { ok: false };
  return { ok: true, value: parsed.data };
}

export type GoogleAdsIdeasPage = {
  records: GoogleAdsKeywordRecord[];
  malformedRecords: number;
  totalResults: number | null;
  nextPageToken: string | null;
};

/** Parses one `generateKeywordIdeas` page. Rows that cannot be parsed are
 *  skipped and counted, never silently dropped: the caller reports a partial
 *  result instead of a complete one. */
export function parseIdeasPage(
  payload: unknown,
): GoogleAdsParseResult<GoogleAdsIdeasPage> {
  const body = readObject(payload);
  if (!body) return { ok: false };
  const results = readRepeatedList(body.results);
  if (!results.ok) return { ok: false };
  const records: GoogleAdsKeywordRecord[] = [];
  let malformedRecords = 0;
  for (const row of results.value) {
    const parsed = readRecord(row, "keywordIdeaMetrics");
    if (!parsed.ok) {
      malformedRecords += 1;
      continue;
    }
    records.push(parsed.value);
  }
  const totalResults = readInt64(body.totalSize);
  if (!totalResults.ok) return { ok: false };
  const nextPageToken = readNextPageToken(body.nextPageToken);
  if (!nextPageToken.ok) return { ok: false };
  return {
    ok: true,
    value: {
      records,
      malformedRecords,
      totalResults: totalResults.value,
      nextPageToken: nextPageToken.value,
    },
  };
}

export type GoogleAdsHistoricalPage = {
  records: GoogleAdsKeywordRecord[];
  malformedRecords: number;
  duplicateRecords: number;
};

/** Parses one `generateKeywordHistoricalMetrics` response. Close variants stay
 *  one record with membership: the grouped metrics are never presented as
 *  independent keywords. */
export function parseHistoricalPage(
  payload: unknown,
): GoogleAdsParseResult<GoogleAdsHistoricalPage> {
  const body = readObject(payload);
  if (!body) return { ok: false };
  const results = readRepeatedList(body.results);
  if (!results.ok) return { ok: false };
  const records: GoogleAdsKeywordRecord[] = [];
  const indexByKeyword = new Map<string, number>();
  let malformedRecords = 0;
  let duplicateRecords = 0;
  for (const row of results.value) {
    const parsed = readRecord(row, "keywordMetrics");
    if (!parsed.ok) {
      malformedRecords += 1;
      continue;
    }
    const existingIndex = indexByKeyword.get(parsed.value.keyword);
    if (existingIndex === undefined) {
      indexByKeyword.set(parsed.value.keyword, records.length);
      records.push(parsed.value);
      continue;
    }
    duplicateRecords += 1;
    const existing = records[existingIndex];
    for (const variant of parsed.value.closeVariants) {
      if (!existing.closeVariants.includes(variant)) {
        existing.closeVariants.push(variant);
      }
    }
  }
  return {
    ok: true,
    value: { records, malformedRecords, duplicateRecords },
  };
}

export type GoogleAdsCollectedRecords = {
  records: GoogleAdsKeywordRecord[];
  malformedRecords: number;
  totalResults: number | null;
  truncated: boolean;
};

/** Walks the Planner pages under explicit ceilings. A repeated page token is
 *  detected before the same page is requested twice, and any ceiling that
 *  stops the walk marks the result as truncated instead of complete. */
export async function collectKeywordRecords(input: {
  fetchPage: (
    pageToken: string | null,
  ) => Promise<GoogleAdsParseResult<GoogleAdsIdeasPage>>;
  maxResults: number;
  maxPages: number;
}): Promise<GoogleAdsParseResult<GoogleAdsCollectedRecords>> {
  const records: GoogleAdsKeywordRecord[] = [];
  const requestedTokens = new Set<string>();
  let pageToken: string | null = null;
  let totalResults: number | null = null;
  let malformedRecords = 0;
  let truncated = false;
  let finished = false;

  for (let page = 0; page < input.maxPages; page += 1) {
    const fetched = await input.fetchPage(pageToken);
    if (!fetched.ok) return { ok: false };
    const current = fetched.value;
    if (totalResults === null && current.totalResults !== null) {
      totalResults = current.totalResults;
    }
    malformedRecords += current.malformedRecords;
    for (const record of current.records) {
      if (records.length >= input.maxResults) {
        truncated = true;
        break;
      }
      records.push(record);
    }
    if (records.length >= input.maxResults) {
      truncated = truncated || current.nextPageToken !== null;
      finished = true;
      break;
    }
    if (current.nextPageToken === null) {
      finished = true;
      break;
    }
    if (requestedTokens.has(current.nextPageToken)) {
      // The upstream handed back a token we already used: requesting it again
      // would replay the same page.
      truncated = true;
      finished = true;
      break;
    }
    requestedTokens.add(current.nextPageToken);
    pageToken = current.nextPageToken;
  }

  if (!finished && pageToken !== null) {
    // The page ceiling stopped the walk while more data was available.
    truncated = true;
  }

  return {
    ok: true,
    value: { records, malformedRecords, totalResults, truncated },
  };
}
