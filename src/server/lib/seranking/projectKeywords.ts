import { z } from "zod";
import type { SeRankingClient } from "./client";
import { classifyProjectApiError } from "./projectAccess";
import { parseAddedKeywordsPayload } from "./projectParsers";
import {
  seRankingProjectKeywordSchema,
  toNumericRemoteKeywordId,
  type SeRankingProjectKeyword,
} from "./projectSchemas";

export interface AddKeywordsParams {
  siteId: number;
  keywords: Array<{
    keyword: string;
    groupId?: number;
    targetUrl?: string;
    siteEngineIds?: number[];
  }>;
}

export interface UpdateKeywordParams {
  siteId: number;
  keywordId: string | number;
  keyword: string;
  groupId?: number;
  targetUrl?: string;
  isStrict?: 0 | 1;
  comment?: string;
  siteEngineIds: number[];
}

export async function listKeywords(
  client: SeRankingClient,
  siteId: number,
  siteEngineId?: number,
  strict = false,
): Promise<SeRankingProjectKeyword[]> {
  const params: Record<string, string | number> = { site_id: siteId };
  if (siteEngineId) {
    params.site_engine_id = siteEngineId;
  }

  const raw = await client.request<unknown[]>("/project-management/keywords", {
    method: "GET",
    params,
  });

  if (strict) {
    return z
      .array(
        seRankingProjectKeywordSchema.refine(
          (k) => k.keyword.trim().length > 0,
        ),
      )
      .parse(raw);
  }
  if (!Array.isArray(raw)) return [];
  return parseAddedKeywordsPayload(raw);
}

function backfillParsedKeywords(
  parsed: SeRankingProjectKeyword[],
  batch: Array<{ keyword: string; siteEngineIds?: number[] }>,
) {
  if (parsed.length === 0 || !parsed.every((p) => !p.keyword)) return;
  for (let j = 0; j < parsed.length && j < batch.length; j++) {
    parsed[j].keyword = batch[j].keyword;
    if (batch[j].siteEngineIds && parsed[j].siteEngineIds.length === 0) {
      parsed[j].siteEngineIds = batch[j].siteEngineIds!;
    }
  }
}

export async function addKeywords(
  client: SeRankingClient,
  params: AddKeywordsParams,
): Promise<SeRankingProjectKeyword[]> {
  if (params.keywords.length === 0) return [];

  const results: SeRankingProjectKeyword[] = [];
  const BATCH_SIZE = 50;

  for (let i = 0; i < params.keywords.length; i += BATCH_SIZE) {
    const batch = params.keywords.slice(i, i + BATCH_SIZE);
    const payload = batch.map((kw) => ({
      keyword: kw.keyword,
      ...(kw.groupId !== undefined ? { group_id: kw.groupId } : {}),
      ...(kw.targetUrl !== undefined ? { target_url: kw.targetUrl } : {}),
      ...(kw.siteEngineIds && kw.siteEngineIds.length > 0
        ? { site_engine_ids: kw.siteEngineIds }
        : {}),
    }));

    try {
      const res = await client.request<unknown>(
        "/project-management/keywords",
        {
          method: "POST",
          params: { site_id: params.siteId },
          body: payload,
        },
      );
      const parsed = parseAddedKeywordsPayload(res);
      backfillParsedKeywords(parsed, batch);
      results.push(...parsed);
    } catch (error) {
      throw classifyProjectApiError(error, "keyword_sync");
    }
  }

  if (results.length === 0 && params.keywords.length > 0) {
    const remoteList = await listKeywords(client, params.siteId);
    const remoteMap = new Map<string, SeRankingProjectKeyword>();
    for (const rk of remoteList) {
      remoteMap.set(rk.keyword.trim().toLowerCase(), rk);
    }
    for (const kw of params.keywords) {
      const found = remoteMap.get(kw.keyword.trim().toLowerCase());
      if (found) results.push(found);
    }
  }

  return results;
}

export interface AddKeywordsOnceResult {
  /** Whether the batch request returned a success status. */
  ok: boolean;
  /** Raw `{added, ids}` payload from the documented POST response, if readable. */
  added: number | null;
  ids: string[];
}

/**
 * Single-attempt keyword POST for selective (user-confirmed) uploads.
 *
 * Unlike `addKeywords`, this:
 * - disables the generic transport retry loop (`noRetry`), because a failed
 *   POST may already have committed remotely and replaying it could
 *   duplicate or double-charge the upload;
 * - never backfills keyword identity from response ordinals and never falls
 *   back to a silent re-listing — the caller must reconcile fresh provider
 *   state to determine what actually landed.
 */
export async function addKeywordsOnce(
  client: SeRankingClient,
  params: AddKeywordsParams,
): Promise<AddKeywordsOnceResult> {
  if (params.keywords.length === 0) {
    return { ok: true, added: 0, ids: [] };
  }

  const payload = params.keywords.map((kw) => ({
    keyword: kw.keyword,
    ...(kw.groupId !== undefined ? { group_id: kw.groupId } : {}),
    ...(kw.targetUrl !== undefined ? { target_url: kw.targetUrl } : {}),
    ...(kw.siteEngineIds && kw.siteEngineIds.length > 0
      ? { site_engine_ids: kw.siteEngineIds }
      : {}),
  }));

  try {
    const res = await client.request<Record<string, unknown>>(
      "/project-management/keywords",
      {
        method: "POST",
        params: { site_id: params.siteId },
        body: payload,
        noRetry: true,
      },
    );
    const added =
      res && typeof res.added === "number" && Number.isFinite(res.added)
        ? res.added
        : null;
    const ids = Array.isArray(res?.ids)
      ? res.ids.filter(
          (id): id is string | number =>
            typeof id === "number" || typeof id === "string",
        )
      : [];
    return {
      ok: true,
      added,
      ids: ids.map((id) => String(id)),
    };
  } catch (error) {
    throw classifyProjectApiError(error, "keyword_sync");
  }
}

export async function updateKeyword(
  client: SeRankingClient,
  params: UpdateKeywordParams,
): Promise<{ ok: boolean }> {
  const numericKeywordId =
    typeof params.keywordId === "number"
      ? params.keywordId
      : toNumericRemoteKeywordId(params.keywordId);

  const payload = {
    keyword: params.keyword,
    ...(params.groupId !== undefined ? { group_id: params.groupId } : {}),
    ...(params.targetUrl !== undefined ? { target_url: params.targetUrl } : {}),
    ...(params.isStrict !== undefined ? { is_strict: params.isStrict } : {}),
    ...(params.comment !== undefined ? { comment: params.comment } : {}),
    site_engine_ids: params.siteEngineIds,
  };

  try {
    await client.request<unknown>("/project-management/keywords", {
      method: "PATCH",
      params: {
        site_id: params.siteId,
        keyword_id: numericKeywordId,
      },
      body: payload,
    });
    return { ok: true };
  } catch (error) {
    throw classifyProjectApiError(error, "keyword_sync");
  }
}
