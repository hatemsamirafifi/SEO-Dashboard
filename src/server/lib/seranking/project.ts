import type { SeRankingClient } from "./client";
import {
  classifyProjectApiError,
  validateProjectApiAccess,
  verifySiteAccessible,
  type ProjectApiAccessReport,
  type ProjectQuotaDimension,
} from "./projectAccess";
import {
  seRankingSiteSchema,
  seRankingSiteEngineSchema,
  toNumericRemoteKeywordId,
  type SeRankingSite,
  type SeRankingSiteEngine,
  type SeRankingProjectKeyword,
  type SeRankingPositionItem,
} from "./projectSchemas";
import {
  parseAddedKeywordsPayload,
  parsePositionsPayload,
} from "./projectParsers";

export type { ProjectApiAccessReport, ProjectQuotaDimension };

export interface CreateSiteParams {
  url: string;
  title: string;
  depth?: number;
  subdomainMatch?: boolean;
  exactUrl?: boolean;
  /** Default `"manual"` so OpenSEO schedules rank checks without remote daily runs. */
  checkFreq?:
    | "check_daily"
    | "check_1in3"
    | "check_weekly"
    | "check_monthly"
    | "manual";
  /** Default `0` to prevent unwanted weekly automated email reports. */
  autoReports?: 0 | 1;
  /** Default `1` to disable automatic background website audits on site creation. */
  disableAudit?: 0 | 1;
}

export interface AddEngineParams {
  siteId: number;
  searchEngineId: number;
  regionId?: number;
  regionName?: string;
  langCode?: string;
}

export interface AddKeywordsParams {
  siteId: number;
  keywords: Array<{
    keyword: string;
    groupId?: number;
    targetUrl?: string;
  }>;
}

export interface RecheckParams {
  siteId: number;
  siteEngineId?: number;
  /** Stored normalized string keyword IDs, converted safely to numeric IDs at boundary. */
  keywordIds?: string[];
  /** Explicit engine-keyword pairs when targeting specific SE Ranking engines. */
  engineKeywordPairs?: Array<{ siteEngineId: number; keywordId: string }>;
}

export interface GetPositionsParams {
  siteId: number;
  siteEngineId?: number;
  dateFrom?: string;
  dateTo?: string;
  withLandingPages?: boolean;
  withSerpFeatures?: boolean;
}

/**
 * Validates Project API authentication, accessibility, and reported Project API
 * quotas independently of Data API `/account/subscription` credits.
 */
async function validateAccessAndQuota(
  client: SeRankingClient,
  options?: { siteIdForEngineCheck?: number },
): Promise<ProjectApiAccessReport> {
  return validateProjectApiAccess(client, options);
}

async function listSites(client: SeRankingClient): Promise<SeRankingSite[]> {
  try {
    const raw = await client.request<unknown[]>("/project-management/sites", {
      method: "GET",
    });
    if (!Array.isArray(raw)) return [];
    return raw
      .map((item) => {
        const res = seRankingSiteSchema.safeParse(item);
        return res.success ? res.data : null;
      })
      .filter((item): item is SeRankingSite => item !== null);
  } catch (error) {
    throw classifyProjectApiError(error, "access");
  }
}

async function createSite(
  client: SeRankingClient,
  params: CreateSiteParams,
): Promise<SeRankingSite> {
  const payload = {
    url: params.url,
    title: params.title,
    depth: params.depth ?? 100,
    subdomain_match: params.subdomainMatch ? 1 : 0,
    exact_url: params.exactUrl ? 1 : 0,
    check_freq: params.checkFreq ?? "manual",
    auto_reports: params.autoReports ?? 0,
    disable_audit: params.disableAudit ?? 1,
  };

  try {
    const res = await client.request<Record<string, unknown>>(
      "/project-management/sites",
      {
        method: "POST",
        body: payload,
      },
    );
    return seRankingSiteSchema.parse(res);
  } catch (error) {
    throw classifyProjectApiError(error, "site_create");
  }
}

async function listSiteSearchEngines(
  client: SeRankingClient,
  siteId: number,
): Promise<SeRankingSiteEngine[]> {
  const raw = await client.request<unknown[]>(
    "/project-management/sites/search-engines",
    {
      method: "GET",
      params: { site_id: siteId },
    },
  );

  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      const res = seRankingSiteEngineSchema.safeParse(item);
      return res.success ? res.data : null;
    })
    .filter((item): item is SeRankingSiteEngine => item !== null);
}

async function addSiteSearchEngine(
  client: SeRankingClient,
  params: AddEngineParams,
): Promise<SeRankingSiteEngine> {
  const payload = {
    site_id: params.siteId,
    search_engine_id: params.searchEngineId,
    region_id: params.regionId ?? 0,
    ...(params.regionName ? { region_name: params.regionName } : {}),
    lang_code: params.langCode ?? "en",
  };

  try {
    const res = await client.request<Record<string, unknown>>(
      "/project-management/sites/search-engines",
      {
        method: "POST",
        params: { site_id: params.siteId },
        body: payload,
      },
    );

    return seRankingSiteEngineSchema.parse(res);
  } catch (error) {
    throw classifyProjectApiError(error, "engine_create");
  }
}

async function listKeywords(
  client: SeRankingClient,
  siteId: number,
  siteEngineId?: number,
): Promise<SeRankingProjectKeyword[]> {
  const params: Record<string, string | number> = { site_id: siteId };
  if (siteEngineId) {
    params.site_engine_id = siteEngineId;
  }

  const raw = await client.request<unknown[]>("/project-management/keywords", {
    method: "GET",
    params,
  });

  if (!Array.isArray(raw)) return [];
  return parseAddedKeywordsPayload(raw);
}

async function addKeywords(
  client: SeRankingClient,
  params: AddKeywordsParams,
): Promise<SeRankingProjectKeyword[]> {
  if (params.keywords.length === 0) return [];

  const results: SeRankingProjectKeyword[] = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < params.keywords.length; i += BATCH_SIZE) {
    const batch = params.keywords.slice(i, i + BATCH_SIZE);
    const payload = {
      site_id: params.siteId,
      keywords: batch.map((kw) => ({
        keyword: kw.keyword,
        group_id: kw.groupId,
        target_url: kw.targetUrl,
      })),
    };

    try {
      const res = await client.request<unknown>(
        "/project-management/keywords",
        {
          method: "POST",
          params: { site_id: params.siteId },
          body: payload,
        },
      );
      results.push(...parseAddedKeywordsPayload(res));
    } catch (error) {
      throw classifyProjectApiError(error, "keyword_sync");
    }
  }

  return results;
}

async function recheckPositions(
  client: SeRankingClient,
  params: RecheckParams,
): Promise<{ ok: boolean; status?: string }> {
  const payload: Record<string, unknown> = {
    site_id: params.siteId,
  };
  if (params.siteEngineId) {
    payload.site_engine_id = params.siteEngineId;
  }

  if (params.engineKeywordPairs && params.engineKeywordPairs.length > 0) {
    payload.keywords = params.engineKeywordPairs.map((pair) => ({
      site_engine_id: pair.siteEngineId,
      keyword_id: toNumericRemoteKeywordId(pair.keywordId),
    }));
  } else if (params.keywordIds && params.keywordIds.length > 0) {
    payload.keywords = params.keywordIds.map((id) =>
      toNumericRemoteKeywordId(id),
    );
  }

  try {
    const res = await client.request<{ ok?: boolean; status?: string }>(
      "/project-management/sites/positions/recheck",
      {
        method: "POST",
        params: { site_id: params.siteId },
        body: payload,
      },
    );
    return { ok: true, status: res?.status ?? "queued" };
  } catch (error) {
    throw classifyProjectApiError(error, "recheck");
  }
}

async function getCheckDates(
  client: SeRankingClient,
  siteId: number,
  siteEngineId?: number,
): Promise<string[]> {
  const params: Record<string, string | number> = { site_id: siteId };
  if (siteEngineId) {
    params.site_engine_id = siteEngineId;
  }

  const res = await client.request<unknown[]>(
    "/project-management/sites/check-dates",
    {
      method: "GET",
      params,
    },
  );

  if (Array.isArray(res)) {
    return res.filter((item): item is string => typeof item === "string");
  }
  return [];
}

async function getPositions(
  client: SeRankingClient,
  params: GetPositionsParams,
): Promise<SeRankingPositionItem[]> {
  const queryParams: Record<string, string | number> = {
    site_id: params.siteId,
  };
  if (params.siteEngineId) {
    queryParams.site_engine_id = params.siteEngineId;
  }
  if (params.dateFrom) {
    queryParams.date_from = params.dateFrom;
  }
  if (params.dateTo) {
    queryParams.date_to = params.dateTo;
  }
  if (params.withLandingPages) {
    queryParams.with_landing_pages = 1;
  }
  if (params.withSerpFeatures) {
    queryParams.with_serp_features = 1;
  }

  const raw = await client.request<unknown>(
    "/project-management/sites/positions",
    {
      method: "GET",
      params: queryParams,
    },
  );

  return parsePositionsPayload(raw);
}

/**
 * SE Ranking Project API Service
 * Non-destructive implementation: never executes DELETE requests.
 */
export const SeRankingProjectService = {
  validateAccessAndQuota,
  verifySiteAccessible,
  listSites,
  createSite,
  listSiteSearchEngines,
  addSiteSearchEngine,
  listKeywords,
  addKeywords,
  recheckPositions,
  getCheckDates,
  getPositions,
};
