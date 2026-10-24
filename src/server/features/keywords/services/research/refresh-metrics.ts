import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { normalizeIntent } from "@/server/features/keywords/services/research/helpers";
import { mapGoogleMetricRecords } from "@/server/features/keywords/services/research/google-records";
import type { GoogleAdsKeywordRecord } from "@/server/lib/googleAdsPlanner";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { RefreshSavedKeywordMetricsInput } from "@/types/schemas/keywords";

// Cap concurrent D1 upserts per group. A project can accumulate thousands of
// saved keywords in one location/language, and fanning out one promise each
// would flood D1/Worker resources; write in bounded chunks instead.
const REFRESH_UPSERT_BATCH_SIZE = 100;

export async function refreshSavedKeywordMetrics(
  input: RefreshSavedKeywordMetricsInput,
  billingCustomer: BillingCustomerContext,
): Promise<{ updated: number }> {
  const { rows } = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId: input.projectId,
  });

  if (rows.length === 0) return { updated: 0 };

  let updated = 0;

  // Group by (locationCode, languageCode) so each provider call is homogeneous.
  const groups = new Map<string, typeof rows>();
  for (const row of rows) {
    const key = `${row.row.locationCode}:${row.row.languageCode}`;
    const group = groups.get(key) ?? [];
    group.push(row);
    groups.set(key, group);
  }

  for (const groupRows of groups.values()) {
    const { locationCode, languageCode } = groupRows[0].row;
    // projectId scopes the internal provider's D1 read to this project's
    // previously persisted metrics before any paid fallback.
    const { data: metricsRaw } = await getSeoDataRouter().route({
      dataType: "keyword_metrics",
      keywords: groupRows.map((r) => r.row.keyword),
      locationCode,
      languageCode,
      billingCustomer,
      creditFeature: "keyword_research",
      constraints: { projectId: input.projectId },
    });
    // The keyword_metrics router walk may answer with either the legacy
    // DataForSEO row array or the first-party Google Ads planner envelope
    // (an object with source "google_ads" plus a keywords array). Map the
    // envelope into the same legacy upsert rows so saved-keyword refresh
    // keeps working either way.
    let metrics: KeywordMetricRow[];
    if (Array.isArray(metricsRaw)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- legacy DFS keyword_metrics rows from the router payload the call produced
      metrics = metricsRaw as KeywordMetricRow[];
    } else if (
      typeof metricsRaw === "object" &&
      metricsRaw !== null &&
      "keywords" in metricsRaw &&
      Array.isArray(metricsRaw.keywords)
    ) {
      metrics = mapGoogleMetricRecords(
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- planner record rows are validated downstream by mapGoogleMetricRecords
        metricsRaw.keywords as GoogleAdsKeywordRecord[],
      );
    } else {
      // Neither shape — surface an explicit shape error instead of crashing
      // downstream with "X.map is not a function" along the upsert fan-out.
      throw new Error("Unsupported keyword_metrics payload shape");
    }
    const byKeyword = new Map(
      metrics.map((metric) => [metric.keyword.toLowerCase(), metric]),
    );

    for (let i = 0; i < groupRows.length; i += REFRESH_UPSERT_BATCH_SIZE) {
      const chunk = groupRows.slice(i, i + REFRESH_UPSERT_BATCH_SIZE);
      await Promise.all(
        chunk.map((r) => {
          const metric = byKeyword.get(r.row.keyword.toLowerCase());
          if (!metric) return Promise.resolve();
          return KeywordResearchRepository.upsertKeywordMetric({
            projectId: input.projectId,
            keyword: r.row.keyword,
            locationCode,
            languageCode,
            searchVolume: metric.searchVolume,
            cpc: metric.cpc,
            competition: metric.competition,
            keywordDifficulty: metric.keywordDifficulty,
            intent: normalizeIntent(metric.intent),
            monthlySearchesJson: JSON.stringify(metric.monthlySearches),
          });
        }),
      );
    }

    updated += byKeyword.size;
  }

  return { updated };
}
