import { type SerpLiveItem } from "@/server/lib/dataforseo";
import type { SerpResultItem } from "@/types/keywords";
import type { BillingCustomerContext } from "@/server/billing/subscription";
import { canonicalUrl } from "@/shared/intelligence";
import { getSeoDataRouter } from "@/server/lib/seo-data";
import {
  enrichCompetitiveMetrics,
  traceEnrichmentRun,
} from "@/server/features/serp/serpEnrichment";
import { normalizeKeyword } from "./helpers";

type SerpAnalysisReason = "no_organic_results";

type SerpAnalysisResult = {
  requestedKeyword: string;
  items: SerpResultItem[];
  reason?: SerpAnalysisReason;
};

function mapOrganicSerpItems(items: SerpLiveItem[]): SerpResultItem[] {
  return items
    .filter((item) => item.type === "organic")
    .map((item) => ({
      rank: item.rank_group ?? item.rank_absolute ?? 0,
      title: item.title ?? "",
      url: item.url ?? "",
      domain: item.domain ?? "",
      description: item.description ?? "",
      etv: item.etv ?? null,
      estimatedPaidTrafficCost: item.estimated_paid_traffic_cost ?? null,
      referringDomains: item.backlinks_info?.referring_domains ?? null,
      backlinks: item.backlinks_info?.backlinks ?? null,
      isNew: false,
      rankChange: null,
    }));
}

async function getSerpLiveAnalysis(
  input: {
    projectId: string;
    keyword: string;
    locationCode: number;
    languageCode: string;
    includeCompetitiveMetrics?: boolean;
  },
  billingCustomer: BillingCustomerContext,
): Promise<SerpAnalysisResult> {
  const keyword = normalizeKeyword(input.keyword);

  // Caching and single-flight live in the router; the trimmed organic-only
  // mapping below stays a cheap per-call transform.
  const { data, provider, fromCache, durationMs } =
    await getSeoDataRouter().route<SerpLiveItem[]>({
      dataType: "serp",
      keyword,
      locationCode: input.locationCode,
      languageCode: input.languageCode,
      billingCustomer,
    });
  traceEnrichmentRun({
    operation: "serp_analysis",
    provider,
    targetCount: data.filter((item) => item.type === "organic").length,
    cacheHits: fromCache ? 1 : 0,
    cacheMisses: fromCache ? 0 : 1,
    statusCounts: {},
    durationMs,
    accountBlocked: null,
  });

  const items = mapOrganicSerpItems(data);
  const result: SerpAnalysisResult = { requestedKeyword: keyword, items };
  if (items.length === 0) {
    result.reason = "no_organic_results";
    return result;
  }

  // Competitive enrichment (spec 007) runs only on the explicit enrichment
  // path and must never fail the base panel: any infrastructure-level
  // failure degrades to unenriched rows.
  if (input.includeCompetitiveMetrics === true) {
    try {
      const enriched = await enrichCompetitiveMetrics({
        results: items.map((item) => ({
          position: item.rank,
          url: item.url,
          domain: item.domain,
        })),
        billingCustomer,
      });
      const byIdentity = new Map(
        enriched.targets.map((entry) => [entry.target.identity, entry.metrics]),
      );
      result.items = items.map((item) => {
        const metrics = byIdentity.get(canonicalUrl(item.url));
        if (!metrics) return item;
        return {
          ...item,
          // Enriched values win where present; snapshot-embedded values
          // survive where enrichment is missing (never lose data).
          referringDomains: metrics.referringDomains ?? item.referringDomains,
          backlinks: metrics.backlinks ?? item.backlinks,
          domainRank: metrics.domainRank,
          pageRank: metrics.pageRank,
          metricStatus: metrics.status,
        };
      });
    } catch {
      // Base SERP stands as-is; enrichment stays unavailable for this run.
    }
  }

  return result;
}

export const getSerpAnalysis = getSerpLiveAnalysis;
