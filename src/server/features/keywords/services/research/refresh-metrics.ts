import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { normalizeIntent } from "@/server/features/keywords/services/research/helpers";
import { mapGoogleMetricRecords } from "@/server/features/keywords/services/research/google-records";
import type { GoogleAdsKeywordRecord } from "@/server/lib/googleAdsPlanner";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import {
  getPlannerConnectionForBilling,
  GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
} from "@/server/lib/seo-data/providers/google-ads-planner-access";
import {
  parseStoredPlannerEnvelope,
  type ParsedPlannerEnvelope,
} from "@/server/lib/seo-data/providers/planner-envelope";
import { GoogleAdsPlannerKeywordRepository } from "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { RefreshSavedKeywordMetricsInput } from "@/types/schemas/keywords";

// Cap concurrent D1 upserts per group. A project can accumulate thousands of
// saved keywords in one location/language, and fanning out one promise each
// would flood D1/Worker resources; write in bounded chunks instead.
const REFRESH_UPSERT_BATCH_SIZE = 100;

/** First-party refresh: records the serving planner envelope as a normalized
 *  group observation instead of upserting planner metrics into the legacy
 *  DataForSEO-shaped `keyword_metrics` table (planner rows do not faithfully
 *  fit the DFS competition-space/keywordDifficulty columns).
 *
 *  Attribution follows the same identity rule as the research hook: the
 *  envelope's attached Ads customer when present, otherwise the project's
 *  CURRENT trusted connection. When neither resolves there is no
 *  observation to record — never a guessed scope. */
async function recordPlannerMetricsObservation(
  envelope: ParsedPlannerEnvelope,
  input: RefreshSavedKeywordMetricsInput,
  locationCode: number,
  languageCode: string,
  billingCustomer: BillingCustomerContext,
): Promise<void> {
  try {
    let customerId = envelope.customerId;
    let loginCustomerId = envelope.loginCustomerId;
    let currencyCode = envelope.currencyCode;
    if (!customerId) {
      const connection = await getPlannerConnectionForBilling({
        projectId: input.projectId,
        organizationId: billingCustomer.organizationId,
      });
      if (!connection) return;
      customerId = connection.customerId;
      loginCustomerId = connection.loginCustomerId;
      currencyCode = envelope.currencyCode ?? connection.currencyCode;
    }

    await GoogleAdsPlannerKeywordRepository.recordGroupObservation({
      scope: {
        projectId: input.projectId,
        organizationId: billingCustomer.organizationId,
        customerId,
        loginCustomerId,
        currencyCode,
        locationCode,
        languageCode,
        network: envelope.network,
        contractVersion: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
      },
      // Saved-keyword refreshes ask for historical metrics, never ideas.
      dataType: "keyword_metrics",
      seedKeyword: "",
      sourceFetchedAt: envelope.sourceFetchedAt,
      stats: {
        truncated: envelope.truncated,
        partial: envelope.partial,
        malformedKeywordCount: envelope.malformedKeywordCount,
        duplicateKeywordCount: envelope.duplicateKeywordCount,
        missingKeywordCount: envelope.missingKeywordCount,
      },
      records: envelope.records,
    });
  } catch (error) {
    // A recording failure must not break the refresh flow itself; the next
    // refresh re-records deterministically.
    console.error(
      "keywords.refreshSavedKeywordMetrics.record-first-party-observation:",
      error,
    );
  }
}

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
    // (an object with source "google_ads" plus a keywords array). The
    // first-party shape is validated as a whole (single object) and
    // recorded to the planner storage branch; the legacy array keeps the
    // DFS-shaped upsert.
    const plannerEnvelope: ParsedPlannerEnvelope | null =
      parseStoredPlannerEnvelope(metricsRaw);
    if (plannerEnvelope) {
      await recordPlannerMetricsObservation(
        plannerEnvelope,
        input,
        locationCode,
        languageCode,
        billingCustomer,
      );
      // Count the served canonical groups this refresh materialized.
      updated += plannerEnvelope.records.length;
      continue;
    }

    const metrics: KeywordMetricRow[] = mapLegacyMetricPayload(metricsRaw);
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

/** Maps the legacy DFS row array (or a legacy planner-record array a manual
 *  refresh may pass) into the DFS-shaped upsert rows. Neither shape —
 *  surface an explicit shape error instead of crashing downstream with
 *  "X.map is not a function" along the upsert fan-out. */
function mapLegacyMetricPayload(metricsRaw: unknown): KeywordMetricRow[] {
  if (Array.isArray(metricsRaw)) {
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- legacy DFS keyword_metrics rows from the router payload the call produced
    return metricsRaw as KeywordMetricRow[];
  }
  if (
    typeof metricsRaw === "object" &&
    metricsRaw !== null &&
    "keywords" in metricsRaw &&
    Array.isArray(metricsRaw.keywords)
  ) {
    return mapGoogleMetricRecords(
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- planner record rows are validated downstream by mapGoogleMetricRecords
      metricsRaw.keywords as GoogleAdsKeywordRecord[],
    );
  }
  throw new Error("Unsupported keyword_metrics payload shape");
}
