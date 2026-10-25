// Normalization of the fixed daily reporting reads (client row shapes → the
// staged fact-row shapes the analytics repository publishes). No I/O and no
// provider calls: rows are already schema-validated by the transport, and the
// storage boundary revalidates every staged row a second time. Absent metric
// cells stay ABSENT (null), never zero — the zero-metrics contract makes
// absence "not reported", and rates derived from incompatible sums must stay
// null downstream.

import type { GoogleAdsReportingGrain } from "@/server/lib/googleAdsReporting";
import type {
  GoogleAdsAdGroupDimensionInput,
  GoogleAdsCampaignDimensionInput,
  GoogleAdsKeywordDimensionInput,
} from "../repositories/GoogleAdsAnalyticsRepository";

const SAFE_INTEGER = Number.MAX_SAFE_INTEGER;
const RESOURCE_ID_MAX = 512;
const TEXT_MAX = 255;
const URL_MAX = 2048;

export type GoogleAdsStagedMetrics = {
  impressions: number | null;
  clicks: number | null;
  costMicros: number | null;
  conversions: number | null;
  conversionsValue: number | null;
};

function cellNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) && value >= 0 && value <= SAFE_INTEGER
      ? value
      : null;
  }
  // int64 cells arrive as digits text; a lossy float is REJECTED, not
  // rounded, so the total stays "not reported" instead of imprecise.
  if (typeof value !== "string" || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function decimalNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number") return null;
  return Number.isFinite(value) && value >= 0 ? value : null;
}

/** Reads a property from an unknown-shaped object without any type
 *  assertion — this is deliberately cast-free: staged rows only ever get
 *  values the runtime checks already narrowed to a concrete type. */
function fieldOf(value: unknown, key: string): unknown {
  if (typeof value !== "object" || value === null) return undefined;
  for (const [entryKey, entryValue] of Object.entries(value)) {
    if (entryKey === key) return entryValue as unknown;
  }
  return undefined;
}

function metricsFromCells(cells: {
  impressions: unknown;
  clicks: unknown;
  costMicros: unknown;
  conversions: unknown;
  conversionsValue: unknown;
}): GoogleAdsStagedMetrics {
  return {
    impressions: cellNumber(cells.impressions),
    clicks: cellNumber(cells.clicks),
    costMicros: cellNumber(cells.costMicros),
    conversions: decimalNumber(cells.conversions),
    conversionsValue: decimalNumber(cells.conversionsValue),
  };
}

export function stagedMetricsFromDaily(metrics: {
  impressions: number | string | null;
  clicks: number | string | null;
  costMicros: number | string | null;
  conversions: number | null;
  conversionsValue: number | null;
}): GoogleAdsStagedMetrics {
  return metricsFromCells(metrics);
}

function stagedMetricsFromCell(value: unknown): GoogleAdsStagedMetrics | null {
  if (typeof value !== "object" || value === null) return null;
  return metricsFromCells({
    impressions: fieldOf(value, "impressions"),
    clicks: fieldOf(value, "clicks"),
    costMicros: fieldOf(value, "costMicros"),
    conversions: fieldOf(value, "conversions"),
    conversionsValue: fieldOf(value, "conversionsValue"),
  });
}

function boundedText(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length >= 1 && value.length <= max
    ? value
    : null;
}

function nonEmpty(value: unknown): string | null {
  return boundedText(typeof value === "string" ? value.trim() : null, TEXT_MAX);
}

/** Maps one grain's parsed transport rows into the staged rows for a single
 *  date, counting date-mismatched, metricless and dimensionless rows as
 *  malformed. A row that cannot key its grain cannot publish — it never
 *  silently changes grain identity, and the unit is then marked partial,
 *  never complete. */
export function normalizedUnitRows(
  grain: GoogleAdsReportingGrain,
  date: string,
  rows: readonly Record<string, unknown>[],
): { rows: Array<Record<string, unknown>>; malformedRows: number } {
  const staged: Array<Record<string, unknown>> = [];
  let malformedRows = 0;
  for (const row of rows) {
    const rowDate = row.date;
    if (typeof rowDate !== "string" || rowDate !== date) {
      malformedRows += 1;
      continue;
    }
    const metrics = stagedMetricsFromCell(row["metrics"]);
    if (metrics === null) {
      malformedRows += 1;
      continue;
    }
    switch (grain) {
      case "account": {
        staged.push({ metrics });
        break;
      }
      case "campaign": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const campaignId = boundedText(row["campaignId"], RESOURCE_ID_MAX);
        if (!campaignResourceId || !campaignId) {
          malformedRows += 1;
          break;
        }
        staged.push({ metrics, campaignResourceId });
        break;
      }
      case "ad_group": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const adGroupResourceId = boundedText(
          row["adGroupResourceId"],
          RESOURCE_ID_MAX,
        );
        if (!campaignResourceId || !adGroupResourceId) {
          malformedRows += 1;
          break;
        }
        staged.push({ metrics, campaignResourceId, adGroupResourceId });
        break;
      }
      case "keyword": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const adGroupResourceId = boundedText(
          row["adGroupResourceId"],
          RESOURCE_ID_MAX,
        );
        const keywordResourceId = boundedText(
          row["keywordResourceId"],
          RESOURCE_ID_MAX,
        );
        if (!campaignResourceId || !adGroupResourceId || !keywordResourceId) {
          malformedRows += 1;
          break;
        }
        staged.push({
          metrics,
          campaignResourceId,
          adGroupResourceId,
          keywordResourceId,
        });
        break;
      }
      case "search_term": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const adGroupResourceId = boundedText(
          row["adGroupResourceId"],
          RESOURCE_ID_MAX,
        );
        const searchText = boundedText(row["searchText"], TEXT_MAX);
        if (!campaignResourceId || !adGroupResourceId || !searchText) {
          malformedRows += 1;
          break;
        }
        staged.push({
          metrics,
          campaignResourceId,
          adGroupResourceId,
          searchText,
        });
        break;
      }
      case "device": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const device = boundedText(row["device"], TEXT_MAX);
        if (!campaignResourceId || !device) {
          malformedRows += 1;
          break;
        }
        staged.push({ metrics, campaignResourceId, device });
        break;
      }
      case "landing_page": {
        const campaignResourceId = boundedText(
          row["campaignResourceId"],
          RESOURCE_ID_MAX,
        );
        const landingPageUrl = boundedText(row["landingPageUrl"], URL_MAX);
        if (!campaignResourceId || !landingPageUrl) {
          malformedRows += 1;
          break;
        }
        staged.push({ metrics, campaignResourceId, landingPageUrl });
        break;
      }
    }
  }
  return { rows: staged, malformedRows };
}

/** Dimension rows referenced by one date's facts. Rows lacking a full human
 *  identity are skipped: dimension enrichment only — the published facts
 *  never depend on it, and the repository reasserts non-empty text. */
export function campaignDimensionsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): GoogleAdsCampaignDimensionInput[] {
  const seen = new Map<string, GoogleAdsCampaignDimensionInput>();
  for (const row of rows) {
    const name = nonEmpty(row["campaignName"]);
    const status = nonEmpty(row["campaignStatus"]);
    const campaignId = boundedText(row["campaignId"], RESOURCE_ID_MAX);
    const campaignResourceId = boundedText(
      row["campaignResourceId"],
      RESOURCE_ID_MAX,
    );
    if (!campaignResourceId || !campaignId || !name || !status) {
      continue;
    }
    seen.set(campaignResourceId, {
      campaignResourceId,
      campaignId,
      name,
      status,
      servingStatus: nonEmpty(row["servingStatus"]),
      advertisingChannelType: nonEmpty(row["advertisingChannelType"]),
    });
  }
  return [...seen.values()];
}

export function adGroupDimensionsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): GoogleAdsAdGroupDimensionInput[] {
  const seen = new Map<string, GoogleAdsAdGroupDimensionInput>();
  for (const row of rows) {
    const name = nonEmpty(row["adGroupName"]);
    const status = nonEmpty(row["adGroupStatus"]);
    const campaignResourceId = boundedText(
      row["campaignResourceId"],
      RESOURCE_ID_MAX,
    );
    const adGroupResourceId = boundedText(
      row["adGroupResourceId"],
      RESOURCE_ID_MAX,
    );
    if (!campaignResourceId || !adGroupResourceId || !name || !status) {
      continue;
    }
    seen.set(adGroupResourceId, {
      adGroupResourceId,
      campaignResourceId,
      name,
      status,
    });
  }
  return [...seen.values()];
}

export function keywordDimensionsFromRows(
  rows: ReadonlyArray<Record<string, unknown>>,
): GoogleAdsKeywordDimensionInput[] {
  const seen = new Map<string, GoogleAdsKeywordDimensionInput>();
  for (const row of rows) {
    const text = nonEmpty(row["keywordText"]);
    const campaignResourceId = boundedText(
      row["campaignResourceId"],
      RESOURCE_ID_MAX,
    );
    const adGroupResourceId = boundedText(
      row["adGroupResourceId"],
      RESOURCE_ID_MAX,
    );
    const keywordResourceId = boundedText(
      row["keywordResourceId"],
      RESOURCE_ID_MAX,
    );
    if (
      !campaignResourceId ||
      !adGroupResourceId ||
      !keywordResourceId ||
      !text
    ) {
      continue;
    }
    seen.set(keywordResourceId, {
      keywordResourceId,
      campaignResourceId,
      adGroupResourceId,
      keywordText: text,
      keywordMatchType: boundedText(row["keywordMatchType"], TEXT_MAX),
    });
  }
  return [...seen.values()];
}
