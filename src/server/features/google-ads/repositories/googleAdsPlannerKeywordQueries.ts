import { and, desc, eq, gte, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  googleAdsPlannerGroupMonths,
  googleAdsPlannerGroupVariants,
  googleAdsPlannerGroups,
  googleAdsPlannerObservations,
} from "@/db/schema";
import type {
  GoogleAdsKeywordRecord,
  GoogleAdsMonthlySearchVolume,
} from "@/server/lib/googleAdsPlanner";
import {
  chunked,
  competitionFromStored,
  normalizeCustomerId,
  normalizeKeywordText,
  type GoogleAdsPlannerKeywordMatches,
  type GoogleAdsPlannerStoredGroup,
  type GroupRow,
} from "./googleAdsPlannerKeywordModel";

/** Read side of the Google Ads planner first-party storage: every query that
 *  rebuilds typed planner records or gates serving on freshness. Writes live
 *  in GoogleAdsPlannerKeywordRepository.ts; the two share the model module. */

/** Scope columns of a group row, in unique-index order. */
export type GroupScopeColumns = {
  projectId: string;
  customerId: string;
  locationCode: number;
  languageCode: string;
  network: string;
  contractVersion: string;
};

/** Group ids by canonical keyword inside an exact planner scope. */
export async function selectGroupIds(
  scope: GroupScopeColumns,
  keywords: string[],
): Promise<Map<string, string>> {
  const byKeyword = new Map<string, string>();
  for (const chunk of chunked(keywords, 100)) {
    const rows = await db
      .select({
        id: googleAdsPlannerGroups.id,
        keyword: googleAdsPlannerGroups.keyword,
      })
      .from(googleAdsPlannerGroups)
      .where(
        and(
          eq(googleAdsPlannerGroups.projectId, scope.projectId),
          eq(googleAdsPlannerGroups.customerId, scope.customerId),
          eq(googleAdsPlannerGroups.locationCode, scope.locationCode),
          eq(googleAdsPlannerGroups.languageCode, scope.languageCode),
          eq(googleAdsPlannerGroups.network, scope.network),
          eq(googleAdsPlannerGroups.contractVersion, scope.contractVersion),
          inArray(googleAdsPlannerGroups.keyword, chunk),
        ),
      );
    for (const row of rows) byKeyword.set(row.keyword, row.id);
  }
  return byKeyword;
}

/** Variant keywords of the given groups, keyed by group id. */
export async function selectVariantRows(
  groupIds: string[],
): Promise<Map<string, Array<{ id: string; variantKeyword: string }>>> {
  const byGroupId = new Map<
    string,
    Array<{ id: string; variantKeyword: string }>
  >();
  for (const chunk of chunked(groupIds, 100)) {
    const rows = await db
      .select({
        id: googleAdsPlannerGroupVariants.id,
        groupId: googleAdsPlannerGroupVariants.groupId,
        variantKeyword: googleAdsPlannerGroupVariants.variantKeyword,
      })
      .from(googleAdsPlannerGroupVariants)
      .where(inArray(googleAdsPlannerGroupVariants.groupId, chunk));
    for (const row of rows) {
      const list = byGroupId.get(row.groupId) ?? [];
      list.push({ id: row.id, variantKeyword: row.variantKeyword });
      byGroupId.set(row.groupId, list);
    }
  }
  return byGroupId;
}

/** Month rows of the given groups, keyed by group id as
 *  [rowId, year, month] triples used to decide staleness. */
export async function selectMonthRows(
  groupIds: string[],
): Promise<Map<string, Array<[string, number, number]>>> {
  const byGroupId = new Map<string, Array<[string, number, number]>>();
  for (const chunk of chunked(groupIds, 100)) {
    const rows = await db
      .select({
        id: googleAdsPlannerGroupMonths.id,
        groupId: googleAdsPlannerGroupMonths.groupId,
        year: googleAdsPlannerGroupMonths.year,
        month: googleAdsPlannerGroupMonths.month,
      })
      .from(googleAdsPlannerGroupMonths)
      .where(inArray(googleAdsPlannerGroupMonths.groupId, chunk));
    for (const row of rows) {
      const list = byGroupId.get(row.groupId) ?? [];
      list.push([row.id, row.year, row.month]);
      byGroupId.set(row.groupId, list);
    }
  }
  return byGroupId;
}

/** Full month rows (volume included) of the given groups, keyed by group id,
 *  for reattaching monthly histories to rebuilt planner records. */
async function selectMonthRowsWithVolume(
  groupIds: string[],
): Promise<
  Map<string, Array<{ year: number; month: number; volume: number | null }>>
> {
  const byGroupId = new Map<
    string,
    Array<{ year: number; month: number; volume: number | null }>
  >();
  for (const chunk of chunked(groupIds, 100)) {
    const rows = await db
      .select({
        groupId: googleAdsPlannerGroupMonths.groupId,
        year: googleAdsPlannerGroupMonths.year,
        month: googleAdsPlannerGroupMonths.month,
        volume: googleAdsPlannerGroupMonths.volume,
      })
      .from(googleAdsPlannerGroupMonths)
      .where(inArray(googleAdsPlannerGroupMonths.groupId, chunk));
    for (const row of rows) {
      const list = byGroupId.get(row.groupId) ?? [];
      list.push({ year: row.year, month: row.month, volume: row.volume });
      byGroupId.set(row.groupId, list);
    }
  }
  return byGroupId;
}

/** Rebuilds a typed planner record from a stored group row: monthly volumes
 *  reattach as an explicit (possibly sparse/null) history, micros stay
 *  micros, and absent metrics stay null — never fabricated zeros. */
function groupRowToStored(
  row: GroupRow,
  variants: string[],
  months: Array<[number, number, number | null]>,
): GoogleAdsPlannerStoredGroup {
  const monthlySearchVolumes: GoogleAdsMonthlySearchVolume[] = months
    .toSorted((a, b) => a[0] - b[0] || a[1] - b[1])
    .map(([year, month, volume]) => ({ year, month, volume }));
  const record: GoogleAdsKeywordRecord = {
    keyword: row.keyword,
    closeVariants: variants,
    avgMonthlySearches: row.avgMonthlySearches,
    monthlySearchVolumes,
    competition: competitionFromStored(row.competition),
    competitionIndex: row.competitionIndex,
    averageCpcMicros: row.averageCpcMicros,
    lowTopOfPageBidMicros: row.lowTopOfPageBidMicros,
    highTopOfPageBidMicros: row.highTopOfPageBidMicros,
  };
  return {
    record,
    sourceFetchedAt: row.sourceFetchedAt,
    currencyCode: row.currencyCode,
  };
}

/** Stored planner records for the given group ids, keyed by group id.
 *  Variant memberships and full month rows are reattached per group. */
async function selectStoredGroups(
  groupIds: string[],
): Promise<Map<string, GoogleAdsPlannerStoredGroup>> {
  const byId = new Map<string, GroupRow>();
  for (const chunk of chunked(groupIds, 100)) {
    const rows = await db
      .select()
      .from(googleAdsPlannerGroups)
      .where(inArray(googleAdsPlannerGroups.id, chunk));
    for (const row of rows) byId.set(row.id, row);
  }

  const variantsByGroupId = await selectVariantRows(groupIds);
  const monthTriplesByGroupId = await selectMonthRowsWithVolume(groupIds);

  const stored = new Map<string, GoogleAdsPlannerStoredGroup>();
  for (const [id, row] of byId) {
    const variantKeywords = (variantsByGroupId.get(id) ?? []).map(
      (variant) => variant.variantKeyword,
    );
    const months: Array<[number, number, number | null]> = (
      monthTriplesByGroupId.get(id) ?? []
    ).map((monthRow) => [monthRow.year, monthRow.month, monthRow.volume]);
    stored.set(id, groupRowToStored(row, variantKeywords, months));
  }
  return stored;
}

/** Scope columns of an observation row, in unique-index order. */
type ObservationScopeColumns = {
  projectId: string;
  customerId: string;
  dataType: string;
  seedKeyword: string;
  locationCode: number;
  languageCode: string;
  network: string;
  contractVersion: string;
};

type ObservationKey = ObservationScopeColumns & { organizationId: string };

/** The observation ledger row for an exact planner scope, or null when the
 *  flow was never recorded. Used by the internal provider to gate the SQL
 *  serving branch on the observation being fresh enough. */
export async function getObservation(key: ObservationKey): Promise<{
  sourceFetchedAt: string;
  truncated: boolean;
  partial: boolean;
  malformedKeywordCount: number;
  duplicateKeywordCount: number;
  missingKeywordCount: number;
  currencyCode: string | null;
} | null> {
  const customerId = normalizeCustomerId(key.customerId);
  const rows = await db
    .select()
    .from(googleAdsPlannerObservations)
    .where(
      and(
        eq(googleAdsPlannerObservations.projectId, key.projectId),
        eq(googleAdsPlannerObservations.organizationId, key.organizationId),
        eq(googleAdsPlannerObservations.customerId, customerId),
        eq(googleAdsPlannerObservations.dataType, key.dataType),
        eq(googleAdsPlannerObservations.seedKeyword, key.seedKeyword),
        eq(googleAdsPlannerObservations.locationCode, key.locationCode),
        eq(googleAdsPlannerObservations.languageCode, key.languageCode),
        eq(googleAdsPlannerObservations.network, key.network),
        eq(googleAdsPlannerObservations.contractVersion, key.contractVersion),
      ),
    )
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    sourceFetchedAt: row.sourceFetchedAt,
    truncated: row.truncated,
    partial: row.partial,
    malformedKeywordCount: row.malformedKeywordCount,
    duplicateKeywordCount: row.duplicateKeywordCount,
    missingKeywordCount: row.missingKeywordCount,
    currencyCode: row.currencyCode,
  };
}

/** Reads stored groups for a request keyword list, resolved inside an exact
 *  planner scope for the CURRENT Ads connection. Canonical matches and
 *  variant matches are returned separately so callers can annotate variant
 *  keywords as sharing their canonical group's estimate — never copy the
 *  group statistics into unrelated literal keywords or sum variants. */
export async function getKeywordGroupMatches(
  scope: GroupScopeColumns,
  keywords: string[],
  options: {
    /** Lower bound on the group's sourceFetchedAt (ISO string compare).
     *  undefined/null disables the freshness filter. */
    minSourceFetchedAt?: string | null;
  } = {},
): Promise<GoogleAdsPlannerKeywordMatches> {
  const result: GoogleAdsPlannerKeywordMatches = {
    canonical: new Map(),
    variants: new Map(),
  };
  const normalizedKeywords = keywords.map(normalizeKeywordText).filter(Boolean);
  if (normalizedKeywords.length === 0) return result;

  const conditions = [
    eq(googleAdsPlannerGroups.projectId, scope.projectId),
    eq(googleAdsPlannerGroups.customerId, scope.customerId),
    eq(googleAdsPlannerGroups.locationCode, scope.locationCode),
    eq(googleAdsPlannerGroups.languageCode, scope.languageCode),
    eq(googleAdsPlannerGroups.network, scope.network),
    eq(googleAdsPlannerGroups.contractVersion, scope.contractVersion),
  ];
  const minFetchedAt =
    typeof options.minSourceFetchedAt === "string" && options.minSourceFetchedAt
      ? options.minSourceFetchedAt
      : null;
  if (minFetchedAt) {
    // ISO timestamps compare lexicographically — the lower bound keeps
    // stale observations out of the serving path.
    conditions.push(gte(googleAdsPlannerGroups.sourceFetchedAt, minFetchedAt));
  }

  // 1. Groups whose canonical keyword matches the requested keywords.
  const canonicalRows: GroupRow[] = [];
  for (const chunk of chunked(normalizedKeywords, 100)) {
    const rows = await db
      .select()
      .from(googleAdsPlannerGroups)
      .where(
        and(...conditions, inArray(googleAdsPlannerGroups.keyword, chunk)),
      );
    canonicalRows.push(...rows);
  }
  const matchedGroupIds = new Set(canonicalRows.map((row) => row.id));

  // 2. Variant memberships that resolve to additional canonical groups for
  //    keywords the canonical lookup missed.
  const unresolvedKeywords = normalizedKeywords.filter(
    (keyword) => !canonicalRows.some((row) => row.keyword === keyword),
  );
  const variantGroupRefs: Array<{
    groupId: string;
    variantKeyword: string;
  }> = [];
  for (const chunk of chunked(unresolvedKeywords, 100)) {
    const rows = await db
      .select({
        groupId: googleAdsPlannerGroupVariants.groupId,
        variantKeyword: googleAdsPlannerGroupVariants.variantKeyword,
      })
      .from(googleAdsPlannerGroupVariants)
      .where(inArray(googleAdsPlannerGroupVariants.variantKeyword, chunk));
    variantGroupRefs.push(...rows);
  }
  const extraGroupIds = [
    ...new Set(
      variantGroupRefs
        .map((ref) => ref.groupId)
        .filter((id) => !matchedGroupIds.has(id)),
    ),
  ];
  const extraRows: GroupRow[] = [];
  for (const chunk of chunked(extraGroupIds, 100)) {
    const rows = await db
      .select()
      .from(googleAdsPlannerGroups)
      .where(and(...conditions, inArray(googleAdsPlannerGroups.id, chunk)));
    extraRows.push(...rows);
  }
  const resolvedGroupIds = extraRows.map((row) => row.id);

  const storedById = await selectStoredGroups([
    ...matchedGroupIds,
    ...resolvedGroupIds,
  ]);

  for (const row of canonicalRows) {
    const stored = storedById.get(row.id);
    if (stored) result.canonical.set(row.keyword, stored);
  }
  for (const ref of variantGroupRefs) {
    const stored = storedById.get(ref.groupId);
    if (stored) result.variants.set(ref.variantKeyword, stored);
  }
  return result;
}

/** The freshest keyword_metrics observation ledger row for a project/market
 *  scope resolved WITHOUT the caller knowing the Ads customer id. Serves the
 *  internal provider's planner SQL branch: the ledger row carries the
 *  identity (customerId, loginCustomerId, currency) the payload was fetched
 *  under, so the stored data is attributed faithfully instead of guessed.
 *  Cumulative record counts (malformed/duplicate/missing in THIS scope's
 *  payload) ride along for envelope honesty flags. Returns null when no
 *  observation meeting `minSourceFetchedAt` exists. */
export async function getLatestMetricsObservation(input: {
  projectId: string;
  organizationId: string;
  locationCode: number;
  languageCode: string;
  network: string;
  contractVersion: string;
  /** Freshness lower bound (ISO string compare); undefined disables it. */
  minSourceFetchedAt?: string | null;
}): Promise<{
  customerId: string;
  loginCustomerId: string | null;
  currencyCode: string | null;
  sourceFetchedAt: string;
  truncated: boolean;
  partial: boolean;
  malformedKeywordCount: number;
  duplicateKeywordCount: number;
  missingKeywordCount: number;
} | null> {
  const conditions = [
    eq(googleAdsPlannerObservations.projectId, input.projectId),
    eq(googleAdsPlannerObservations.organizationId, input.organizationId),
    eq(googleAdsPlannerObservations.dataType, "keyword_metrics"),
    eq(googleAdsPlannerObservations.locationCode, input.locationCode),
    eq(googleAdsPlannerObservations.languageCode, input.languageCode),
    eq(googleAdsPlannerObservations.network, input.network),
    eq(googleAdsPlannerObservations.contractVersion, input.contractVersion),
  ];
  const minFetchedAt =
    typeof input.minSourceFetchedAt === "string" && input.minSourceFetchedAt
      ? input.minSourceFetchedAt
      : null;
  if (minFetchedAt) {
    conditions.push(
      gte(googleAdsPlannerObservations.sourceFetchedAt, minFetchedAt),
    );
  }
  const rows = await db
    .select()
    .from(googleAdsPlannerObservations)
    .where(and(...conditions))
    .orderBy(desc(googleAdsPlannerObservations.sourceFetchedAt))
    .limit(1);
  const row = rows[0];
  if (!row) return null;
  return {
    customerId: row.customerId,
    loginCustomerId: row.loginCustomerId,
    currencyCode: row.currencyCode,
    sourceFetchedAt: row.sourceFetchedAt,
    truncated: row.truncated,
    partial: row.partial,
    malformedKeywordCount: row.malformedKeywordCount,
    duplicateKeywordCount: row.duplicateKeywordCount,
    missingKeywordCount: row.missingKeywordCount,
  };
}
