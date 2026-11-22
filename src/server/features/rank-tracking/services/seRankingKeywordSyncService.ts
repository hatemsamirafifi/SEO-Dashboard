import { AppError } from "@/server/lib/errors";
import {
  type createSeRankingClient,
  SeRankingProjectService,
} from "@/server/lib/seranking";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";

export interface SyncTrackedKeywordsParams {
  localProjectId: string;
  configId: string;
  projectBindingId: string;
  remoteSiteId: number;
  client: ReturnType<typeof createSeRankingClient>;
  keywords?: Array<{ id: string; keyword: string }>;
  readOnlySync?: boolean;
}

async function ensureKeywordEngineAssociations(input: {
  client: ReturnType<typeof createSeRankingClient>;
  remoteSiteId: number;
  remoteKeyword: {
    id: string;
    keyword: string;
    groupId?: number;
    targetUrl?: string;
    siteEngineIds?: number[];
  };
  requiredEngineIds: number[];
  readOnlySync?: boolean;
}) {
  if (input.requiredEngineIds.length === 0) return;
  const existingEngines = input.remoteKeyword.siteEngineIds ?? [];
  const missingEngines = input.requiredEngineIds.filter(
    (engId) => !existingEngines.includes(engId),
  );
  if (missingEngines.length === 0) return;

  if (input.readOnlySync) {
    throw new AppError(
      "FORBIDDEN",
      `Keyword "${input.remoteKeyword.keyword}" lacks required search engine association; keyword update is strictly forbidden in readOnlySync mode.`,
    );
  }

  const unionEngines = Array.from(
    new Set([...existingEngines, ...input.requiredEngineIds]),
  ).toSorted((a, b) => a - b);
  await SeRankingProjectService.updateKeyword(input.client, {
    siteId: input.remoteSiteId,
    keywordId: input.remoteKeyword.id,
    keyword: input.remoteKeyword.keyword,
    groupId: input.remoteKeyword.groupId,
    targetUrl: input.remoteKeyword.targetUrl,
    siteEngineIds: unionEngines,
  });
  input.remoteKeyword.siteEngineIds = unionEngines;
}

export async function syncTrackedKeywords(params: SyncTrackedKeywordsParams) {
  const localKeywords =
    params.keywords ??
    (await RankTrackingRepository.getKeywordsForConfig(params.configId));
  if (localKeywords.length === 0) return [];

  const [existingMappings, remoteKeywords, engineBindings] = await Promise.all([
    SeRankingBindingRepository.getKeywordMappingsForProject(
      params.projectBindingId,
    ),
    SeRankingProjectService.listKeywords(params.client, params.remoteSiteId),
    SeRankingBindingRepository.getEngineBindingsForProject(
      params.projectBindingId,
    ),
  ]);

  const requiredEngineIds = engineBindings
    .map((b) => b.remoteSiteEngineId)
    .filter((id): id is number => typeof id === "number");

  const remoteKeywordMap = new Map<string, (typeof remoteKeywords)[0]>();
  for (const rk of remoteKeywords) {
    remoteKeywordMap.set(rk.keyword.trim().toLowerCase(), rk);
  }

  const missingKeywords: Array<{ id: string; keyword: string }> = [];
  const mappingsToUpsert = [];
  const nowIso = new Date().toISOString();

  for (const kw of localKeywords) {
    const normalized = kw.keyword.trim().toLowerCase();
    const existingMapping = existingMappings.find(
      (m) => m.trackingKeywordId === kw.id,
    );
    const remoteKeyword = remoteKeywordMap.get(normalized);

    if (remoteKeyword !== undefined) {
      const remoteId = remoteKeyword.id;

      await ensureKeywordEngineAssociations({
        client: params.client,
        remoteSiteId: params.remoteSiteId,
        remoteKeyword,
        requiredEngineIds,
        readOnlySync: params.readOnlySync,
      });

      if (
        !existingMapping ||
        existingMapping.remoteKeywordId !== remoteId ||
        existingMapping.status !== "synced"
      ) {
        mappingsToUpsert.push({
          id: existingMapping?.id || crypto.randomUUID(),
          projectBindingId: params.projectBindingId,
          trackingKeywordId: kw.id,
          remoteKeywordId: remoteId,
          status: "synced" as const,
          createdAt: existingMapping?.createdAt || nowIso,
          updatedAt: nowIso,
        });
      }
      continue;
    }

    missingKeywords.push(kw);
  }

  if (missingKeywords.length > 0) {
    if (params.readOnlySync) {
      throw new AppError(
        "FORBIDDEN",
        `${missingKeywords.length} keyword(s) not found in remote SE Ranking project; keyword addition is strictly forbidden in readOnlySync mode.`,
      );
    }
    const added = await SeRankingProjectService.addKeywords(params.client, {
      siteId: params.remoteSiteId,
      keywords: missingKeywords.map((k) => ({
        keyword: k.keyword,
        siteEngineIds:
          requiredEngineIds.length > 0 ? requiredEngineIds : undefined,
      })),
    });

    for (const addedKw of added) {
      const normalizedAdded = addedKw.keyword.trim().toLowerCase();
      const local = missingKeywords.find(
        (k) => k.keyword.trim().toLowerCase() === normalizedAdded,
      );
      if (local) {
        mappingsToUpsert.push({
          id: crypto.randomUUID(),
          projectBindingId: params.projectBindingId,
          trackingKeywordId: local.id,
          remoteKeywordId: addedKw.id,
          status: "synced" as const,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
  }

  if (mappingsToUpsert.length > 0) {
    await SeRankingBindingRepository.bulkUpsertKeywordMappings(
      mappingsToUpsert,
    );
  }

  return mappingsToUpsert;
}
