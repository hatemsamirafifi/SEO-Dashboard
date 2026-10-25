import { KeywordResearchRepository } from "@/server/features/keywords/repositories/KeywordResearchRepository";
import { jsonCodec } from "@/shared/json";
import type {
  DeleteSavedKeywordTagInput,
  ExportSavedKeywordsInput,
  GetSavedKeywordsInput,
  RemoveSavedKeywordsInput,
  ResolvedSaveKeywordsInput,
  UpdateSavedKeywordTagInput,
  UpdateSavedKeywordTagsInput,
} from "@/types/schemas/keywords";
import type {
  MonthlySearch,
  SavedKeywordGoogleAdsPlanner,
  SavedKeywordRow,
  SavedKeywordTagSummary,
} from "@/types/keywords";
import { GoogleAdsConnectionRepository } from "@/server/features/google-ads/repositories/GoogleAdsConnectionRepository";
import {
  GoogleAdsPlannerKeywordRepository,
  type GoogleAdsPlannerStoredGroup,
} from "@/server/features/google-ads/repositories/GoogleAdsPlannerKeywordRepository";
import { GOOGLE_ADS_PLANNER_CACHE_CONTRACT } from "@/server/lib/seo-data/providers/google-ads-planner-access";
import { GOOGLE_ADS_DEFAULT_PLANNER_NETWORK } from "@/server/lib/googleAdsPlanner";
import { normalizeKeyword } from "./helpers";
import { z } from "zod";

const monthlySearchSchema = z.object({
  year: z.number().int().positive(),
  month: z.number().int().min(1).max(12),
  searchVolume: z.number().int().nonnegative(),
});

const monthlySearchesCodec = jsonCodec(z.array(monthlySearchSchema));

function parseMonthlySearches(payload: string | null): MonthlySearch[] {
  if (!payload) return [];
  const result = monthlySearchesCodec.safeParse(payload);
  return result.success ? result.data : [];
}

export async function saveKeywords(input: ResolvedSaveKeywordsInput) {
  const normalizedKeywords = [
    ...new Set(
      input.keywords.map(normalizeKeyword).filter((kw) => kw.length > 0),
    ),
  ];

  const metricByKeyword = new Map(
    (input.metrics ?? [])
      .map((metric) => {
        const keyword = normalizeKeyword(metric.keyword);
        if (!keyword || !normalizedKeywords.includes(keyword)) return null;
        return [keyword, metric] as const;
      })
      .filter(
        (
          entry,
        ): entry is readonly [
          string,
          NonNullable<typeof input.metrics>[number],
        ] => entry != null,
      ),
  );

  if (metricByKeyword.size > 0) {
    await Promise.all(
      normalizedKeywords.map(async (keyword) => {
        const metric = metricByKeyword.get(keyword);
        if (!metric) return;

        await KeywordResearchRepository.upsertKeywordMetric({
          projectId: input.projectId,
          keyword,
          locationCode: input.locationCode,
          languageCode: input.languageCode,
          searchVolume: metric.searchVolume ?? null,
          cpc: metric.cpc ?? null,
          competition: metric.competition ?? null,
          keywordDifficulty: metric.keywordDifficulty ?? null,
          intent: metric.intent ?? null,
          monthlySearchesJson: JSON.stringify(metric.monthlySearches ?? []),
        });
      }),
    );
  }

  const savedRows = await KeywordResearchRepository.saveKeywordsToProject({
    projectId: input.projectId,
    keywords: normalizedKeywords,
    locationCode: input.locationCode,
    languageCode: input.languageCode,
  });
  const savedKeywordIds = savedRows.map((row) => row.id);

  if (input.tagMode === "replace") {
    const replacementTags = input.tags ?? [];
    if (replacementTags.length === 0) {
      throw new Error("Replacement tags are required when tagMode is replace.");
    }
    await KeywordResearchRepository.replaceTagsForSavedKeywords({
      projectId: input.projectId,
      savedKeywordIds,
      tagNames: replacementTags,
    });
  } else if ((input.tags?.length ?? 0) > 0) {
    await KeywordResearchRepository.addTagsToSavedKeywords({
      projectId: input.projectId,
      savedKeywordIds,
      tagNames: input.tags ?? [],
    });
  }

  return {
    success: true,
    savedKeywordIds,
  };
}

export async function getSavedKeywords(
  input: GetSavedKeywordsInput,
  context?: SavedKeywordsServingContext,
): Promise<{
  rows: SavedKeywordRow[];
  totalCount: number;
  tags: SavedKeywordTagSummary[];
}> {
  const result = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId: input.projectId,
    search: input.search,
    includeTerms: input.includeTerms,
    excludeTerms: input.excludeTerms,
    minVolume: input.minVolume,
    maxVolume: input.maxVolume,
    minCpc: input.minCpc,
    maxCpc: input.maxCpc,
    minDifficulty: input.minDifficulty,
    maxDifficulty: input.maxDifficulty,
    tagIds: input.tagIds,
    tagNames: input.tagNames,
    page: input.page,
    pageSize: input.pageSize,
    sort: input.sort,
    order: input.order,
  });

  const mappedRows = mapSavedKeywordRows(result.rows);
  const annotatedRows = await annotateRowsWithGoogleAdsPlanner(
    input.projectId,
    context?.organizationId,
    mappedRows,
  );

  return {
    rows: annotatedRows,
    totalCount: result.totalCount,
    tags: mapSavedKeywordTags(result.tags),
  };
}

export async function exportSavedKeywords(
  input: ExportSavedKeywordsInput,
  context?: SavedKeywordsServingContext,
): Promise<{ rows: SavedKeywordRow[] }> {
  const result = await KeywordResearchRepository.listSavedKeywordsByProject({
    projectId: input.projectId,
    search: input.search,
    includeTerms: input.includeTerms,
    excludeTerms: input.excludeTerms,
    minVolume: input.minVolume,
    maxVolume: input.maxVolume,
    minCpc: input.minCpc,
    maxCpc: input.maxCpc,
    minDifficulty: input.minDifficulty,
    maxDifficulty: input.maxDifficulty,
    tagIds: input.tagIds,
    tagNames: input.tagNames,
    sort: input.sort,
    order: input.order,
  });

  const annotatedRows = await annotateRowsWithGoogleAdsPlanner(
    input.projectId,
    context?.organizationId,
    mapSavedKeywordRows(result.rows),
  );

  return { rows: annotatedRows };
}

export async function updateSavedKeywordTags(
  input: UpdateSavedKeywordTagsInput,
) {
  const addResult =
    (input.addTags?.length ?? 0) > 0
      ? await KeywordResearchRepository.addTagsToSavedKeywords({
          projectId: input.projectId,
          savedKeywordIds: input.savedKeywordIds,
          tagNames: input.addTags ?? [],
        })
      : { savedKeywordCount: 0, tags: [] };

  const removeResult =
    (input.removeTagIds?.length ?? 0) > 0
      ? await KeywordResearchRepository.removeTagsFromSavedKeywords({
          projectId: input.projectId,
          savedKeywordIds: input.savedKeywordIds,
          tagIds: input.removeTagIds ?? [],
        })
      : { removedCount: 0, savedKeywordCount: 0, tags: [] };

  return {
    success: true,
    taggedCount: Math.max(
      addResult.savedKeywordCount,
      removeResult.savedKeywordCount,
    ),
    addedTags: addResult.tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      normalizedName: tag.normalizedName,
      color: tag.color ?? null,
    })),
    removedTagIds: removeResult.tags.map((tag) => tag.id),
    removedAssignments: removeResult.removedCount,
  };
}

function mapSavedKeywordRows(
  rows: Awaited<
    ReturnType<typeof KeywordResearchRepository.listSavedKeywordsByProject>
  >["rows"],
): SavedKeywordRow[] {
  return rows.map(({ row, metric, tags }) => ({
    id: row.id,
    projectId: row.projectId,
    keyword: row.keyword,
    locationCode: row.locationCode,
    languageCode: row.languageCode,
    createdAt: row.createdAt,
    searchVolume: metric?.searchVolume ?? null,
    cpc: metric?.cpc ?? null,
    competition: metric?.competition ?? null,
    keywordDifficulty: metric?.keywordDifficulty ?? null,
    intent: metric?.intent ?? null,
    monthlySearches: parseMonthlySearches(metric?.monthlySearches ?? null),
    fetchedAt: metric?.fetchedAt ?? null,
    tags: tags.map((tag) => ({
      id: tag.id,
      name: tag.name,
      normalizedName: tag.normalizedName,
      color: tag.color ?? null,
    })),
  }));
}

function mapSavedKeywordTags(
  tags: Awaited<
    ReturnType<typeof KeywordResearchRepository.listSavedKeywordsByProject>
  >["tags"],
): SavedKeywordTagSummary[] {
  return tags.map((tag) => ({
    id: tag.id,
    name: tag.name,
    normalizedName: tag.normalizedName,
    color: tag.color ?? null,
    keywordCount: tag.keywordCount,
  }));
}

/** Server-resolved context for reads that may enrich rows with first-party
 *  planner estimates. Never client input: the Ads identity comes from the
 *  project's connection row inside this organization. */
export type SavedKeywordsServingContext = {
  organizationId: string;
};

const GOOGLE_ADS_MICROS = 1_000_000;

/** Builds the first-party annotation off the stored planner record. Money
 *  micros are re-expressed in the account's currency units; Google-native
 *  honesty flags stay untouched. */
function plannerAnnotation(
  normalizedKeyword: string,
  stored: GoogleAdsPlannerStoredGroup,
  isCanonical: boolean,
): SavedKeywordGoogleAdsPlanner {
  const record = stored.record;
  return {
    canonicalKeyword: record.keyword,
    isCanonical,
    sharedEstimate: !isCanonical,
    searchVolume: record.avgMonthlySearches,
    cpc:
      record.averageCpcMicros === null
        ? null
        : record.averageCpcMicros / GOOGLE_ADS_MICROS,
    lowTopOfPageBid:
      record.lowTopOfPageBidMicros === null
        ? null
        : record.lowTopOfPageBidMicros / GOOGLE_ADS_MICROS,
    highTopOfPageBid:
      record.highTopOfPageBidMicros === null
        ? null
        : record.highTopOfPageBidMicros / GOOGLE_ADS_MICROS,
    competitionLevel: record.competition,
    competitionIndex: record.competitionIndex,
    currencyCode: stored.currencyCode,
    fetchedAt: stored.sourceFetchedAt,
    monthlySearches: record.monthlySearchVolumes
      .filter((entry) => entry.volume !== null)
      .map((entry) => ({
        year: entry.year,
        month: entry.month,
        searchVolume: entry.volume ?? 0,
      })),
  };
}

/** Attaches first-party planner estimates to saved rows when the project's
 *  Ads connection holds stored planner observations. An annotatable list
 *  can fail at any layer (unconnected project, repository hiccup, market
 *  without a stored observation); the legacy rows always stay intact and
 *  only the optional annotation is skipped. A list can span multiple saved
 *  markets; planner estimates are scoped per market, so each
 *  (location, language) group is matched separately. */
async function annotateRowsWithGoogleAdsPlanner(
  projectId: string,
  organizationId: string | undefined,
  rows: SavedKeywordRow[],
): Promise<SavedKeywordRow[]> {
  if (!organizationId || rows.length === 0) return rows;
  let connection;
  try {
    connection = await GoogleAdsConnectionRepository.getByProjectId(
      projectId,
      organizationId,
    );
  } catch {
    return rows;
  }
  if (!connection) return rows;

  const byMarket = new Map<string, SavedKeywordRow[]>();
  for (const row of rows) {
    const marketKey = `${row.locationCode}:${row.languageCode}`;
    const list = byMarket.get(marketKey) ?? [];
    list.push(row);
    byMarket.set(marketKey, list);
  }

  for (const [marketKey, marketRows] of byMarket) {
    const [locationText, languageCode] = marketKey.split(":");
    const locationCode = Number(locationText);
    if (!Number.isInteger(locationCode)) continue;
    let matches;
    try {
      matches = await GoogleAdsPlannerKeywordRepository.getKeywordGroupMatches(
        {
          projectId,
          customerId: connection.customerId,
          locationCode,
          languageCode,
          network: GOOGLE_ADS_DEFAULT_PLANNER_NETWORK,
          contractVersion: GOOGLE_ADS_PLANNER_CACHE_CONTRACT,
        },
        marketRows.map((row) => row.keyword),
      );
    } catch {
      continue;
    }
    for (const row of marketRows) {
      const normalized = normalizeKeyword(row.keyword);
      const canonical = matches.canonical.get(normalized);
      if (canonical) {
        row.googleAdsPlanner = plannerAnnotation(normalized, canonical, true);
        continue;
      }
      const variant = matches.variants.get(normalized);
      if (variant) {
        row.googleAdsPlanner = plannerAnnotation(normalized, variant, false);
      }
    }
  }
  return rows;
}

export async function updateSavedKeywordTag(input: UpdateSavedKeywordTagInput) {
  const updated = await KeywordResearchRepository.updateSavedKeywordTag({
    projectId: input.projectId,
    tagId: input.tagId,
    name: input.name,
    color: input.color,
  });
  if (!updated) return { success: false as const };
  return {
    success: true as const,
    tag: {
      id: updated.id,
      name: updated.name,
      normalizedName: updated.normalizedName,
      color: updated.color ?? null,
    },
  };
}

export async function deleteSavedKeywordTag(input: DeleteSavedKeywordTagInput) {
  const result = await KeywordResearchRepository.deleteSavedKeywordTag({
    projectId: input.projectId,
    tagId: input.tagId,
  });
  if (result.status === "in_use") {
    throw new TagInUseError(result.assignmentCount);
  }
  return { success: result.status === "deleted" };
}

class TagInUseError extends Error {
  readonly code = "TAG_IN_USE" as const;
  constructor(readonly assignmentCount: number) {
    super(
      `Tag is attached to ${assignmentCount} keyword${assignmentCount === 1 ? "" : "s"}. Remove the tag from those keywords first.`,
    );
    this.name = "TagInUseError";
  }
}

export async function removeSavedKeywords(
  projectId: string,
  input: RemoveSavedKeywordsInput,
) {
  const deletedCount = await KeywordResearchRepository.removeSavedKeywords(
    input.savedKeywordIds,
    projectId,
  );
  return { success: true, deletedCount };
}
