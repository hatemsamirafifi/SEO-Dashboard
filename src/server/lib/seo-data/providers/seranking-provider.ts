/* eslint-disable eslint/max-lines */
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import {
  createSeRankingClient,
  resolveSeRankingSource,
  getExportKeywords,
  getSimilarKeywords,
  getRelatedKeywords,
  getLongTailKeywords,
  getDomainOverview,
  getDomainKeywords,
  getDomainPages,
  getDomainCompetitors,
  getBacklinksSummary,
  getReferringDomains,
  getBacklinks,
  getBacklinkPages,
  getBacklinksHistory,
  reserveSeRankingCredits,
  type SeRankingOperation,
  type SeRankingClient,
} from "@/server/lib/seranking";
import {
  ProviderUnavailableError,
  ProviderUnsupportedError,
  AuthenticationError,
  RateLimitError,
} from "../errors";
import { persistCompetitorSnapshot } from "../competitor-snapshot-repository";
import { DomainOverviewSnapshotRepository } from "../domain-overview-snapshot-repository";
import type { SEODataProvider, SEODataRequest } from "../types";
import type { BacklinkCall, KeywordIdeasSource } from "./dataforseo-provider";
import type { KeywordMetricRow } from "@/server/lib/dataforseo/keyword-metrics";

export function createSerankingProvider(): SEODataProvider {
  return {
    name: "seranking",

    supports(request: SEODataRequest): boolean {
      switch (request.dataType) {
        case "keyword_ideas":
          return Boolean(request.keyword && request.keyword.trim().length > 0);
        case "keyword_metrics": {
          const keywords =
            request.keywords ?? (request.keyword ? [request.keyword] : []);
          return keywords.length > 0;
        }
        case "domain_overview":
        case "domain_keywords":
        case "domain_pages":
          return Boolean(request.domain && request.domain.trim().length > 0);
        case "competitors": {
          const hasKeywords = Boolean(
            (request.keywords && request.keywords.length > 0) ||
            (request.keyword && request.keyword.trim().length > 0),
          );
          const hasDomain = Boolean(
            request.domain && request.domain.trim().length > 0,
          );
          return hasDomain || hasKeywords;
        }
        case "backlinks":
        case "competitive_metrics":
          return Boolean(request.domain && request.domain.trim().length > 0);
        default:
          return false;
      }
    },

    async get(request: SEODataRequest): Promise<unknown> {
      const organizationId = request.billingCustomer.organizationId;
      const projectId =
        typeof request.constraints?.projectId === "string"
          ? request.constraints.projectId
          : request.billingCustomer?.projectId;

      const config = await resolveEffectiveSeRankingConfig({
        organizationId,
        projectId,
      });

      if (!config.configured || !config.apiKey) {
        throw new ProviderUnavailableError(
          "seranking",
          "SE Ranking is not configured (missing API key)",
        );
      }

      if (!config.enabled) {
        throw new ProviderUnavailableError(
          "seranking",
          "SE Ranking is disabled for this organization or project",
        );
      }

      const client = createSeRankingClient({
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
        maxRetries: config.maxRetries,
      });

      const source = resolveSeRankingSource({
        locationCode: request.locationCode,
      });

      const operation = mapRequestToSeRankingOperation(request);
      const count = mapRequestToCount(request);
      const reservation = await reserveSeRankingCredits({
        organizationId,
        operation,
        count,
        client,
      });

      let httpBilled = false;
      let actualUnits: number | undefined;

      try {
        let result: unknown;
        switch (request.dataType) {
          case "keyword_ideas": {
            result = await routeKeywordIdeas(client, request, source);
            const returnedCount = Array.isArray(result) ? result.length : 0;
            actualUnits = returnedCount * 10;
            httpBilled = true;
            break;
          }
          case "keyword_metrics": {
            result = await routeKeywordMetrics(client, request, source);
            const returnedCount = Array.isArray(result) ? result.length : count;
            actualUnits = Math.max(1, returnedCount);
            httpBilled = true;
            break;
          }
          case "domain_overview":
            result = await routeDomainOverview(
              client,
              request,
              source,
              organizationId,
            );
            httpBilled = true;
            break;
          case "domain_keywords":
            result = await routeDomainKeywords(client, request, source);
            httpBilled = true;
            break;
          case "domain_pages":
            result = await routeDomainPages(client, request, source);
            httpBilled = true;
            break;
          case "competitors":
            result = await routeCompetitors(client, request, source, projectId);
            httpBilled = true;
            break;
          case "backlinks":
          case "competitive_metrics":
            result = await routeBacklinks(client, request);
            httpBilled = true;
            break;
          default:
            throw new ProviderUnsupportedError("seranking", request.dataType);
        }
        await reservation.commit(actualUnits);
        return result;
      } catch (error) {
        const errorObj =
          typeof error === "object" && error !== null
            ? (error as {
                upstreamStatus?: unknown;
                rawItemCount?: unknown;
                name?: unknown;
                message?: unknown;
              })
            : null;
        const upstreamStatus =
          typeof errorObj?.upstreamStatus === "number"
            ? errorObj.upstreamStatus
            : undefined;
        const rawItemCount =
          typeof errorObj?.rawItemCount === "number"
            ? errorObj.rawItemCount
            : undefined;
        if (httpBilled || upstreamStatus === 200) {
          const reconciledUnits =
            actualUnits ??
            (rawItemCount !== undefined
              ? request.dataType === "keyword_ideas"
                ? rawItemCount * 10
                : Math.max(1, rawItemCount)
              : undefined);
          await reservation.commit(reconciledUnits);
        } else {
          await reservation.release();
        }
        if (errorObj?.name === "SeRankingAuthError") {
          throw new AuthenticationError(
            "seranking",
            typeof errorObj.message === "string"
              ? errorObj.message
              : "Authentication failed",
          );
        }
        if (errorObj?.name === "SeRankingRateLimitError") {
          throw new RateLimitError(
            "seranking",
            typeof errorObj.message === "string"
              ? errorObj.message
              : "Rate limit exceeded",
          );
        }
        throw error;
      }
    },
  };
}

function mapRequestToSeRankingOperation(
  request: SEODataRequest,
): SeRankingOperation {
  switch (request.dataType) {
    case "keyword_ideas":
      return "keyword_ideas";
    case "keyword_metrics":
      return "keyword_metrics";
    case "domain_overview":
      return "domain_overview";
    case "domain_keywords":
      return "domain_keywords";
    case "domain_pages":
      return "domain_pages";
    case "competitors":
      return "domain_competitors";
    case "backlinks":
    case "competitive_metrics": {
      const mode =
        (request.constraints?.backlinkCall as string | undefined) ?? "summary";
      if (mode === "refdomains") return "backlinks_refdomains";
      if (mode === "pages") return "backlinks_pages";
      if (mode === "history") return "backlinks_history";
      if (mode === "backlinks") return "backlinks_rows";
      return "backlinks_summary";
    }
    default:
      return "domain_overview";
  }
}

function mapRequestToCount(request: SEODataRequest): number {
  if (request.dataType === "keyword_metrics") {
    const kws = request.keywords ?? (request.keyword ? [request.keyword] : []);
    return Math.max(1, kws.length);
  }
  if (request.dataType === "keyword_ideas") {
    const limit = (request.constraints?.limit as number | undefined) ?? 100;
    return Math.min(limit, 200);
  }
  return 1;
}

async function routeKeywordIdeas(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
): Promise<unknown> {
  const keyword = request.keyword!;
  const c = request.constraints ?? {};
  const ideaSource = (c.source as KeywordIdeasSource | undefined) ?? "ideas";
  const limit = (c.limit as number | undefined) ?? 100;

  let rawItems;
  if (ideaSource === "related") {
    rawItems = await getRelatedKeywords(client, { keyword, source, limit });
  } else if (ideaSource === "suggestions") {
    rawItems = await getSimilarKeywords(client, { keyword, source, limit });
  } else if (ideaSource === "google_ads") {
    // SE Ranking long-tail / similar
    rawItems = await getLongTailKeywords(client, { keyword, source, limit });
  } else {
    // Default "ideas": combine similar and related or similar
    rawItems = await getSimilarKeywords(client, { keyword, source, limit });
  }

  // Normalize into LabsKeywordDataItem shape so existing downstream consumers and mappers work seamlessly
  return rawItems.map((item) => {
    const dataItem = {
      keyword: item.keyword,
      keyword_info: {
        search_volume: item.volume,
        cpc: item.cpc,
        competition: item.competition,
        monthly_searches: (item.history_trend ?? []).map((t) => {
          const [year, month] = t.date.split("-").map(Number);
          return {
            year: year || 0,
            month: month || 0,
            search_volume: t.volume,
          };
        }),
      },
      keyword_properties: {
        keyword_difficulty: item.difficulty,
      },
      search_intent_info: {
        main_intent: item.intent ?? null,
      },
    };
    return {
      ...dataItem,
      keyword_data: dataItem,
    };
  });
}

async function routeKeywordMetrics(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
): Promise<KeywordMetricRow[]> {
  const keywords =
    request.keywords ?? (request.keyword ? [request.keyword] : []);
  if (keywords.length === 0) return [];

  const items = await getExportKeywords(client, {
    keywords,
    source,
  });

  return items.map((item) => {
    const monthlySearches = (item.history_trend ?? []).map((t) => {
      const [year, month] = t.date.split("-").map(Number);
      return {
        year: year || 0,
        month: month || 0,
        searchVolume: t.volume,
      };
    });

    const comp = item.competition;
    const compLevel =
      comp != null
        ? comp >= 0.66
          ? "HIGH"
          : comp >= 0.33
            ? "MEDIUM"
            : "LOW"
        : null;

    return {
      keyword: item.keyword,
      searchVolume: item.volume,
      cpc: item.cpc,
      competition: comp,
      competitionLevel: compLevel,
      keywordDifficulty: item.difficulty,
      intent: item.intent,
      monthlySearches,
    };
  });
}

async function routeDomainOverview(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
  organizationId: string,
): Promise<unknown> {
  const domain = request.domain!;
  const withSubdomains = Boolean(request.constraints?.includeSubdomains);

  const overview = await getDomainOverview(client, {
    domain,
    source,
    withSubdomains,
  });

  const organicTraffic = overview.organic?.traffic_sum ?? null;
  const organicKeywords = overview.organic?.keywords_count ?? null;

  // Write-through to D1 snapshot repository so future reads are instant and free
  try {
    await DomainOverviewSnapshotRepository.insert({
      organizationId,
      domain,
      locationCode: request.locationCode ?? 2840,
      languageCode: request.languageCode ?? "en",
      organicTraffic,
      organicKeywords,
    });
  } catch (err) {
    console.error("seo-data.seranking.domain-overview.write-through:", err);
  }

  // Canonical domain overview shape expected by DomainService
  return [
    {
      metrics: {
        organic: {
          etv: organicTraffic,
          count: organicKeywords,
        },
      },
    },
  ];
}

async function routeDomainKeywords(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
): Promise<unknown> {
  const domain = request.domain!;
  const c = request.constraints ?? {};
  const limit = (c.limit as number | undefined) ?? 50;
  const offset = (c.offset as number | undefined) ?? 0;

  const result = await getDomainKeywords(client, {
    domain,
    source,
    limit,
    offset,
    type: "organic",
  });

  return {
    items: result.items.map((item) => ({
      keyword: item.keyword,
      position: item.position,
      rank_absolute: item.position,
      volume: item.volume,
      cpc: item.cpc,
      url: item.url,
      difficulty: item.difficulty,
      traffic: item.traffic,
      intent: item.intent,
      keyword_data: {
        keyword: item.keyword,
        keyword_info: {
          search_volume: item.volume,
          cpc: item.cpc,
        },
        keyword_properties: {
          keyword_difficulty: item.difficulty,
        },
      },
      ranked_serp_element: {
        serp_item: {
          rank_absolute: item.position,
          etv: item.traffic,
          url: item.url,
        },
      },
    })),
    totalCount: result.totalCount,
  };
}

async function routeDomainPages(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
): Promise<unknown> {
  const domain = request.domain!;
  const c = request.constraints ?? {};
  const limit = (c.limit as number | undefined) ?? 50;
  const offset = (c.offset as number | undefined) ?? 0;

  const result = await getDomainPages(client, {
    domain,
    source,
    limit,
    offset,
  });

  return {
    items: result.items.map((item) => ({
      url: item.url,
      traffic: item.traffic,
      keywords_count: item.keywords_count,
    })),
    totalCount: result.totalCount,
  };
}

async function routeCompetitors(
  client: SeRankingClient,
  request: SEODataRequest,
  source: string,
  projectId?: string,
): Promise<unknown> {
  const targetDomain = request.domain || "example.com";
  const c = request.constraints ?? {};
  const limit = (c.limit as number | undefined) ?? 50;
  const offset = (c.offset as number | undefined) ?? 0;

  const result = await getDomainCompetitors(client, {
    domain: targetDomain,
    source,
    limit,
    offset,
    type: "organic",
  });

  const items = result.items.map((item) => ({
    domain: item.domain,
    keywords_count: item.keywords_count ?? item.total_keywords,
    avg_position: item.avg_position,
    visibility: item.visibility,
    etv: item.traffic,
    common_keywords: item.common_keywords,
  }));

  // Write-through to competitor snapshot
  if (projectId) {
    try {
      await persistCompetitorSnapshot({
        projectId,
        keywords:
          request.keywords ?? (request.keyword ? [request.keyword] : []),
        locationCode: request.locationCode ?? 2840,
        languageCode: request.languageCode ?? "en",
        items,
      });
    } catch (err) {
      console.error(
        "seo-data.seranking.competitor-snapshot.write-through:",
        err,
      );
    }
  }

  return items;
}

async function routeBacklinks(
  client: SeRankingClient,
  request: SEODataRequest,
): Promise<unknown> {
  const domain = request.domain!;
  const mode =
    (request.constraints?.backlinkCall as BacklinkCall | undefined) ??
    "summary";
  const c = request.constraints ?? {};
  const limit = (c.limit as number | undefined) ?? 100;
  const offset = (c.offset as number | undefined) ?? 0;

  switch (mode) {
    case "summary": {
      const summary = await getBacklinksSummary(client, { target: domain });
      return {
        target: summary.target,
        rank: summary.domain_inlink_rank,
        backlinks: summary.total_backlinks,
        referring_domains: summary.referring_domains,
        new_backlinks: summary.new_backlinks,
        lost_backlinks: summary.lost_backlinks,
        referring_pages: summary.total_backlinks,
        broken_backlinks: 0,
        broken_pages: 0,
        backlinks_spam_score: null,
      };
    }
    case "referring_domains": {
      const result = await getReferringDomains(client, {
        target: domain,
        limit,
        offset,
      });
      return {
        items: result.items.map((r) => ({
          domain: r.domain,
          backlinks: r.backlinks,
          rank: r.inlink_rank,
          first_seen: r.first_seen,
          broken_backlinks: 0,
          broken_pages: 0,
          backlinks_spam_score: null,
        })),
        totalCount: result.totalCount,
      };
    }
    case "rows": {
      const result = await getBacklinks(client, {
        target: domain,
        limit,
        offset,
      });
      return {
        items: result.items.map((b) => ({
          url_from: b.source_url,
          url_to: b.target_url,
          anchor: b.anchor,
          dofollow: b.dofollow,
          rank: b.inlink_rank,
          first_seen: b.first_seen,
          last_visited: b.last_seen,
        })),
        totalCount: result.totalCount,
      };
    }
    case "domain_pages": {
      const result = await getBacklinkPages(client, {
        target: domain,
        limit,
        offset,
      });
      return {
        items: result.items.map((p) => ({
          url: p.url,
          page: p.url,
          backlinks: p.backlinks,
          referring_domains: p.referring_domains,
          rank: p.inlink_rank,
        })),
        totalCount: result.totalCount,
      };
    }
    case "history": {
      const historyItems = await getBacklinksHistory(client, {
        target: domain,
        mode: "domain",
        dateFrom: request.dateFrom,
        dateTo: request.dateTo,
      });

      if (!historyItems || historyItems.length === 0) {
        return [];
      }

      return historyItems.map((item) => ({
        date: item.date,
        rank: item.inlink_rank ?? null,
        backlinks: item.backlinks ?? item.count ?? null,
        referring_domains: item.referring_domains ?? null,
        new_backlinks: item.new ?? item.new_backlinks ?? null,
        lost_backlinks: item.lost ?? item.lost_backlinks ?? null,
        new_referring_domains: item.new_referring_domains ?? null,
        lost_referring_domains: item.lost_referring_domains ?? null,
      }));
    }
    default:
      throw new ProviderUnsupportedError(
        "seranking",
        "backlinks",
        `Unknown backlink call mode: ${String(mode)}`,
      );
  }
}
