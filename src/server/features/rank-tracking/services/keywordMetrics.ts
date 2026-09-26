import type { BillingCustomerContext } from "@/server/billing/subscription";
import type { KeywordMetricRow } from "@/server/lib/dataforseo";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { AppError } from "@/server/lib/errors";

async function getValidatedConfig(configId: string, projectId: string) {
  const config = await RankTrackingRepository.getConfigById({
    configId,
    projectId,
  });
  if (!config) {
    throw new AppError("INTERNAL_ERROR", "Rank tracking config not found");
  }
  return config;
}

export async function refreshKeywordMetrics(
  configId: string,
  projectId: string,
  billingCustomer: BillingCustomerContext,
): Promise<{ updated: number }> {
  const [config, keywords] = await Promise.all([
    getValidatedConfig(configId, projectId),
    RankTrackingRepository.getKeywordsForConfig(configId),
  ]);
  if (keywords.length === 0) return { updated: 0 };

  const { data: metrics } = await getSeoDataRouter().route<KeywordMetricRow[]>({
    dataType: "keyword_metrics",
    keywords: keywords.map((kw) => kw.keyword),
    locationCode: config.locationCode,
    languageCode: config.languageCode,
    billingCustomer,
    creditFeature: "rank_tracking",
    constraints: {
      projectId,
      // Local configs must retain city-scoped volume/CPC semantics. Providers
      // that cannot honor this constraint report unsupported and fall through.
      ...(config.locationName ? { locationName: config.locationName } : {}),
    },
  });
  const byKeyword = new Map(
    metrics.map((metric) => [metric.keyword.toLowerCase(), metric]),
  );

  const now = new Date().toISOString();
  const updates = keywords
    .map((kw) => {
      const metric = byKeyword.get(kw.keyword.toLowerCase());
      if (!metric) return null;
      // Rank tracking only tracks volume / difficulty / CPC.
      return {
        id: kw.id,
        searchVolume: metric.searchVolume,
        keywordDifficulty: metric.keywordDifficulty,
        cpc: metric.cpc,
        metricsFetchedAt: now,
      };
    })
    .filter((u): u is NonNullable<typeof u> => u !== null);

  if (updates.length === 0) return { updated: 0 };
  await RankTrackingRepository.updateKeywordMetrics(updates);
  return { updated: updates.length };
}
