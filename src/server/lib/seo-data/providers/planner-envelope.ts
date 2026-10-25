import { z } from "zod";
import type { GoogleAdsKeywordRecord } from "@/server/lib/googleAdsPlanner";

/** Planner envelope validation for the router-cache replay trust boundary.
 *
 *  The Google Ads planner access layer produces first-party envelopes (an
 *  object with source "google_ads" plus ideas/keywords record arrays) which
 *  get cached in R2 and replayed to keyword consumers. Those replays are
 *  cache data, not trusted upstream types: this module re-validates them
 *  with a schema that mirrors the produced shape exactly and normalizes
 *  them to the fields every first-party consumer needs.
 *
 *  This file is intentionally dependency-light (zod + the typed planner
 *  record contract only): keyword consumer tests mock their providers with
 *  narrow module graphs and must not transitively pull the database or the
 *  Ads client through this validation.
 */

const monthlyVolumeSchema = z.object({
  year: z.number().int().nonnegative(),
  month: z.number().int().nonnegative(),
  volume: z.number().int().nonnegative().nullable(),
});

// The normalized record shape the planner envelopes produce. The raw
// competition wire value can carry "UNSPECIFIED"; downstream mappers guard
// it, so validation accepts it here and the normalizer folds it into null.
const plannerRecordSchema = z.object({
  keyword: z.string().min(1),
  closeVariants: z.array(z.string()),
  avgMonthlySearches: z.number().int().nonnegative().nullable(),
  monthlySearchVolumes: z.array(monthlyVolumeSchema),
  competition: z.enum(["LOW", "MEDIUM", "HIGH", "UNSPECIFIED"]).nullable(),
  competitionIndex: z.number().int().nonnegative().nullable(),
  averageCpcMicros: z.number().int().nonnegative().nullable(),
  lowTopOfPageBidMicros: z.number().int().nonnegative().nullable(),
  highTopOfPageBidMicros: z.number().int().nonnegative().nullable(),
});

const plannerEnvelopeSchema = z.object({
  source: z.literal("google_ads"),
  fetchedAt: z.string().min(1),
  currencyCode: z.string().nullable(),
  network: z.string().min(1),
  // Attached at fetch time by the planner access layer. An optional field
  // keeps older (pre-identity) cache entries parseable; first-party
  // persistence that needs the Ads identity resolves the current
  // connection instead.
  customerId: z.string().min(1).optional(),
  loginCustomerId: z.string().min(1).nullish(),
  missingKeywords: z.array(z.string()),
  malformedKeywords: z.number().int().nonnegative(),
  duplicateKeywords: z.number().int().nonnegative(),
  truncated: z.boolean(),
  partial: z.boolean(),
  // Individual records are validated below, so a single malformed record
  // never invalidates the whole cached envelope.
  ideas: z.array(z.unknown()).optional(),
  keywords: z.array(z.unknown()).optional(),
});

/** A R2-cached planner payload re-validated and normalized to the fields
 *  every first-party consumer needs. `null` means the payload is NOT a
 *  first-party planner envelope. */
export type ParsedPlannerEnvelope = {
  dataType: "keyword_ideas" | "keyword_metrics";
  sourceFetchedAt: string;
  currencyCode: string | null;
  network: string;
  customerId: string | null;
  loginCustomerId: string | null;
  records: GoogleAdsKeywordRecord[];
  missingKeywordCount: number;
  malformedKeywordCount: number;
  duplicateKeywordCount: number;
  truncated: boolean;
  partial: boolean;
};

/** Parses an unknown router-cached payload as a planner envelope. The
 *  endpoint's record array (`ideas` vs `keywords`) decides the data type.
 *  Individual malformed records are skipped and counted — the envelope's
 *  honesty flags stay intact, the payload itself is never fabricated. */
export function parseStoredPlannerEnvelope(
  payload: unknown,
): ParsedPlannerEnvelope | null {
  const parsed = plannerEnvelopeSchema.safeParse(payload);
  if (!parsed.success) return null;
  const envelope = parsed.data;
  const isIdeas = Array.isArray(envelope.ideas) && envelope.ideas.length > 0;
  const isMetrics = Array.isArray(envelope.keywords);
  if (!isIdeas && !isMetrics) return null;

  const records: GoogleAdsKeywordRecord[] = [];
  let malformedKeywordCount = envelope.malformedKeywords;
  // The ideas array shadows the metrics array even when empty — pick the
  // array the branch above discriminated.
  const rawRecords = isIdeas
    ? (envelope.ideas ?? [])
    : (envelope.keywords ?? []);
  for (const record of rawRecords) {
    const candidate = plannerRecordSchema.safeParse(record);
    if (!candidate.success) {
      malformedKeywordCount += 1;
      continue;
    }
    // The raw wire value can carry "UNSPECIFIED"; absent and UNSPECIFIED
    // both mean "no competition value".
    const { keyword, closeVariants, competition, ...metricFields } =
      candidate.data;
    records.push({
      keyword,
      closeVariants,
      ...metricFields,
      competition: competition === "UNSPECIFIED" ? null : competition,
    });
  }
  return {
    dataType: isIdeas ? "keyword_ideas" : "keyword_metrics",
    sourceFetchedAt: envelope.fetchedAt,
    currencyCode: envelope.currencyCode,
    network: envelope.network,
    customerId: envelope.customerId ?? null,
    loginCustomerId: envelope.loginCustomerId ?? null,
    records,
    missingKeywordCount: envelope.missingKeywords.length,
    malformedKeywordCount,
    duplicateKeywordCount: envelope.duplicateKeywords,
    truncated: envelope.truncated,
    partial: envelope.partial,
  };
}
