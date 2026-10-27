/** Mappers from the Google Ads planner record shape (v26 typed client, still
 *  fully Google-native: micros and a 0-100 competition index) into the
 *  keyword research consumers' row shapes. Conversion to USD floats and
 *  0-1 competition ratios happens here, at the consumer boundary — provider
 *  payloads stay raw.
 *
 *  Honesty rules carried over from the DFS mappers: absent upstream metrics
 *  stay null (never zero), keyword difficulty and search intent are Labs-only
 *  capabilities Google Ads simply does not provide, and malformed rows (no
 *  keyword) are skipped, not coerced.
 */
import type {
  GoogleAdsKeywordRecord,
  GoogleAdsMonthlySearchVolume,
} from "@/server/lib/googleAdsPlanner";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import { normalizeKeyword, type EnrichedKeyword } from "./helpers";

/** A planner record without an average is treated as a row with no metrics at
 *  all: Google returns every metric together, so a null average means the
 *  block is empty and every derived money/market field stays honestly null. */
function recordHasMetrics(record: GoogleAdsKeywordRecord): boolean {
  return record.avgMonthlySearches != null;
}

/** With a `is`-guard filter (no post-hoc cast): a missing month is never
 *  reported as zero — months without a volume are dropped from the history
 *  instead of being coerced to 0. */
function hasVolume(
  entry: GoogleAdsMonthlySearchVolume,
): entry is GoogleAdsMonthlySearchVolume & { volume: number } {
  return entry.volume != null;
}

function mapTrendVolumes(
  record: GoogleAdsKeywordRecord,
): { year: number; month: number; searchVolume: number }[] {
  return (record.monthlySearchVolumes ?? []).filter(hasVolume).map((entry) => ({
    year: entry.year,
    month: entry.month,
    searchVolume: entry.volume,
  }));
}

/** Adds the additive bid / competition-level annotations Google supplies and
 *  DFS rows lack. Present only when the metric exists — consumers detect
 *  availability with `in`, not with null fuzzing. */
function applyAdditiveResearchFields(
  row: EnrichedKeyword,
  record: GoogleAdsKeywordRecord,
): void {
  if (!recordHasMetrics(record)) return;
  if (record.lowTopOfPageBidMicros != null) {
    row.lowTopOfPageBid = record.lowTopOfPageBidMicros / 1_000_000;
  }
  if (record.highTopOfPageBidMicros != null) {
    row.highTopOfPageBid = record.highTopOfPageBidMicros / 1_000_000;
  }
  if (
    record.competition != null &&
    // Outer comparison is against the raw string: the generated enum union
    // omits "UNSPECIFIED" but the wire format can still carry it.
    String(record.competition) !== "UNSPECIFIED"
  ) {
    row.competitionLevel = record.competition;
  }
}

/**
 * Maps the first-party keyword_ideas payload (Google Ads planner records) into
 * the EnrichedKeyword[] row shape the research consumer renders.
 *
 * Close variants become additional canonical rows sharing the record's
 * metrics, deduplicated case-insensitively.
 */
export function mapGoogleResearchRecords(
  records: GoogleAdsKeywordRecord[],
): EnrichedKeyword[] {
  const rows = new Map<string, EnrichedKeyword>();

  for (const record of records) {
    const keywords = [record.keyword, ...(record.closeVariants ?? [])];
    for (const keyword of keywords) {
      if (typeof keyword !== "string" || keyword.trim() === "") continue;
      const normalized = normalizeKeyword(keyword);
      if (rows.has(normalized)) continue;

      const hasMetrics = recordHasMetrics(record);
      const row: EnrichedKeyword = {
        keyword: normalized,
        searchVolume: record.avgMonthlySearches ?? null,
        trend: mapTrendVolumes(record),
        cpc:
          hasMetrics && record.averageCpcMicros != null
            ? record.averageCpcMicros / 1_000_000
            : null,
        competition:
          hasMetrics && record.competitionIndex != null
            ? record.competitionIndex / 100
            : null,
        // Keyword Planner does not offer keyword difficulty or search-intent
        // classification: those are DataForSEO Labs capabilities.
        keywordDifficulty: null,
        intent: "unknown",
      };
      applyAdditiveResearchFields(row, record);
      rows.set(normalized, row);
    }
  }

  return [...rows.values()];
}

/**
 * Maps the first-party keyword_metrics payload (Google Ads planner historical
 * metrics) into KeywordMetricRow[] for the legacy upsert path.
 */
export function mapGoogleMetricRecords(
  records: GoogleAdsKeywordRecord[],
): KeywordMetricRow[] {
  const rows = new Map<string, KeywordMetricRow>();

  for (const record of records) {
    const keywords = [record.keyword, ...(record.closeVariants ?? [])];
    for (const keyword of keywords) {
      if (typeof keyword !== "string" || keyword.trim() === "") continue;
      const normalized = normalizeKeyword(keyword);
      if (rows.has(normalized)) continue;

      const hasMetrics = recordHasMetrics(record);
      rows.set(normalized, {
        keyword: normalized,
        searchVolume: record.avgMonthlySearches ?? null,
        cpc:
          hasMetrics && record.averageCpcMicros != null
            ? record.averageCpcMicros / 1_000_000
            : null,
        competition:
          hasMetrics && record.competitionIndex != null
            ? record.competitionIndex / 100
            : null,
        competitionLevel:
          record.competition != null &&
          // String comparison for the same reason as in
          // applyAdditiveResearchFields: the generated enum union omits
          // "UNSPECIFIED" but the wire format can still carry it.
          String(record.competition) !== "UNSPECIFIED"
            ? record.competition
            : null,
        keywordDifficulty: null,
        intent: "unknown",
        monthlySearches: mapTrendVolumes(record),
      });
    }
  }

  return [...rows.values()];
}
