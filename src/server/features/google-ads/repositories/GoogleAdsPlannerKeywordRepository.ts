import { and, eq, inArray } from "drizzle-orm";
import { runBatch } from "@/db/runBatch";
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
  isoNow,
  normalizeCustomerId,
  normalizeKeywordText,
  type GoogleAdsPlannerDataType,
  type GoogleAdsPlannerObservationInput,
  type GoogleAdsPlannerScope,
} from "./googleAdsPlannerKeywordModel";
import {
  getKeywordGroupMatches,
  getLatestMetricsObservation,
  getObservation,
  selectGroupIds,
  selectMonthRows,
  selectVariantRows,
} from "./googleAdsPlannerKeywordQueries";

/** Google Ads Keyword Planner first-party repository (master plan phase 2).
 *
 *  Normalized storage of Keyword Planner GROUP observations: one observation
 *  ledger row per (project, customer, data type, seed, market, network,
 *  contract), one canonical group row per keyword inside that scope, plus
 *  explicit variant memberships and explicit monthly histories. Reads
 *  rebuild faithful typed planner records — micros stay micros, close
 *  variants reattach, absent metrics stay null — never fabricated rows per
 *  variant.
 *
 *  Honesty rules (same basis as google-ads-planner schema): values are
 *  Google-native — money in micros of the account currency, the competition
 *  enum and its 0-100 index (NOT organic keyword difficulty); absent
 *  upstream metrics stay null; a month Google reported with no volume stays
 *  null; a REAL zero stays zero. `sourceFetchedAt` is only advanced by an
 *  actual fresh planner fetch — reads never refresh it.
 */

export type {
  GoogleAdsPlannerDataType,
  GoogleAdsPlannerKeywordMatches,
  GoogleAdsPlannerObservationInput,
  GoogleAdsPlannerScope,
  GoogleAdsPlannerStoredGroup,
} from "./googleAdsPlannerKeywordModel";

/** Records one fresh planner fetch as a normalized observation. Per-group
 *  replacement sync: the variant memberships and monthly histories of the
 *  groups INSIDE this payload are replaced with the fetched state — detail
 *  rows absent from the payload are deleted. Groups of other seeds or other
 *  flows inside the same scope are left untouched, so ideas seeds and
 *  saved-metric sets coexist instead of deleting each other's data. */
async function recordGroupObservation(
  input: GoogleAdsPlannerObservationInput,
): Promise<void> {
  const customerId = normalizeCustomerId(input.scope.customerId);
  const scope = { ...input.scope, customerId };
  const now = isoNow();

  // 1. The observation ledger row.
  await runBatch((tx) => [
    tx
      .insert(googleAdsPlannerObservations)
      .values({
        id: crypto.randomUUID(),
        projectId: scope.projectId,
        organizationId: scope.organizationId,
        customerId,
        loginCustomerId: scope.loginCustomerId,
        dataType: input.dataType,
        currencyCode: scope.currencyCode,
        locationCode: scope.locationCode,
        languageCode: scope.languageCode,
        network: scope.network,
        contractVersion: scope.contractVersion,
        seedKeyword: input.seedKeyword,
        sourceFetchedAt: input.sourceFetchedAt,
        truncated: input.stats.truncated,
        partial: input.stats.partial,
        malformedKeywordCount: input.stats.malformedKeywordCount,
        duplicateKeywordCount: input.stats.duplicateKeywordCount,
        missingKeywordCount: input.stats.missingKeywordCount,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: [
          googleAdsPlannerObservations.projectId,
          googleAdsPlannerObservations.customerId,
          googleAdsPlannerObservations.dataType,
          googleAdsPlannerObservations.seedKeyword,
          googleAdsPlannerObservations.locationCode,
          googleAdsPlannerObservations.languageCode,
          googleAdsPlannerObservations.network,
          googleAdsPlannerObservations.contractVersion,
        ],
        set: {
          sourceFetchedAt: input.sourceFetchedAt,
          truncated: input.stats.truncated,
          partial: input.stats.partial,
          malformedKeywordCount: input.stats.malformedKeywordCount,
          duplicateKeywordCount: input.stats.duplicateKeywordCount,
          missingKeywordCount: input.stats.missingKeywordCount,
          updatedAt: now,
        },
      }),
  ]);

  // 2. Canonical group rows, deduped by normalized keyword identity. A
  //    duplicate canonical keyword inside one payload keeps the FIRST
  //    record's metrics (the parsing layer already merges upstream repeats
  //    and reports the count).
  const groupPayloads = new Map<string, GoogleAdsKeywordRecord>();
  for (const record of input.records) {
    const keyword = normalizeKeywordText(record.keyword);
    if (!keyword || groupPayloads.has(keyword)) continue;
    groupPayloads.set(keyword, record);
  }

  await upsertGroupRows(scope, groupPayloads, input.sourceFetchedAt);

  // 3. Variant memberships + monthly histories per group, pruned to the
  //    state the payload reports.
  await syncGroupDetails(scope, groupPayloads, input.sourceFetchedAt);
}

async function upsertGroupRows(
  scope: GoogleAdsPlannerScope,
  groupPayloads: Map<string, GoogleAdsKeywordRecord>,
  sourceFetchedAt: string,
): Promise<void> {
  if (groupPayloads.size === 0) return;
  const now = isoNow();
  const groupValues = [...groupPayloads.entries()].map(([keyword, record]) => ({
    id: crypto.randomUUID(),
    projectId: scope.projectId,
    organizationId: scope.organizationId,
    customerId: scope.customerId,
    loginCustomerId: scope.loginCustomerId,
    currencyCode: scope.currencyCode,
    locationCode: scope.locationCode,
    languageCode: scope.languageCode,
    network: scope.network,
    contractVersion: scope.contractVersion,
    keyword,
    avgMonthlySearches: record.avgMonthlySearches,
    competition: record.competition,
    competitionIndex: record.competitionIndex,
    averageCpcMicros: record.averageCpcMicros,
    lowTopOfPageBidMicros: record.lowTopOfPageBidMicros,
    highTopOfPageBidMicros: record.highTopOfPageBidMicros,
    sourceFetchedAt,
    updatedAt: now,
  }));

  await runBatch((tx) =>
    groupValues.map((value) =>
      tx
        .insert(googleAdsPlannerGroups)
        .values(value)
        .onConflictDoUpdate({
          target: [
            googleAdsPlannerGroups.projectId,
            googleAdsPlannerGroups.customerId,
            googleAdsPlannerGroups.locationCode,
            googleAdsPlannerGroups.languageCode,
            googleAdsPlannerGroups.network,
            googleAdsPlannerGroups.contractVersion,
            googleAdsPlannerGroups.keyword,
          ],
          // The metrics and provenance refresh; created_at is deliberately
          // absent (the original row keeps it). The setWhere guard keeps a
          // foreign organization's row from being rewritten.
          set: {
            avgMonthlySearches: value.avgMonthlySearches,
            competition: value.competition,
            competitionIndex: value.competitionIndex,
            averageCpcMicros: value.averageCpcMicros,
            lowTopOfPageBidMicros: value.lowTopOfPageBidMicros,
            highTopOfPageBidMicros: value.highTopOfPageBidMicros,
            sourceFetchedAt: value.sourceFetchedAt,
            currencyCode: value.currencyCode,
            updatedAt: now,
          },
          setWhere: and(
            eq(googleAdsPlannerGroups.projectId, scope.projectId),
            eq(googleAdsPlannerGroups.organizationId, scope.organizationId),
          ),
        }),
    ),
  );
}

async function syncGroupDetails(
  scope: GoogleAdsPlannerScope,
  groupPayloads: Map<string, GoogleAdsKeywordRecord>,
  sourceFetchedAt: string,
): Promise<void> {
  if (groupPayloads.size === 0) return;

  const groupIdsByKeyword = await selectGroupIds(scope, [
    ...groupPayloads.keys(),
  ]);
  if (groupIdsByKeyword.size === 0) return;

  const variantsByGroupId = new Map<string, Set<string>>();
  const monthsByGroupId = new Map<
    string,
    Map<`${number}-${number}`, GoogleAdsMonthlySearchVolume>
  >();
  for (const [groupKeyword, record] of groupPayloads) {
    const groupId = groupIdsByKeyword.get(groupKeyword);
    if (!groupId) continue;

    const variants = new Set<string>();
    for (const variant of record.closeVariants) {
      const normalized = normalizeKeywordText(variant);
      if (!normalized || normalized === groupKeyword) continue;
      variants.add(normalized);
    }
    variantsByGroupId.set(groupId, variants);

    const months = new Map<
      `${number}-${number}`,
      GoogleAdsMonthlySearchVolume
    >();
    for (const entry of record.monthlySearchVolumes) {
      if (
        typeof entry.year !== "number" ||
        typeof entry.month !== "number" ||
        entry.month < 1 ||
        entry.month > 12
      ) {
        continue;
      }
      months.set(`${entry.year}-${entry.month}`, entry);
    }
    monthsByGroupId.set(groupId, months);
  }

  if (variantsByGroupId.size === 0) return;
  const groupIds = [...variantsByGroupId.keys()];
  const now = isoNow();

  const existingVariantIds = await selectVariantRows(groupIds);
  const existingMonthRows = await selectMonthRows(groupIds);

  // Stale detail rows absent from the fresh payload get deleted. Collect row
  // ids so the deletes are exact and never cascade into data another flow
  // (different seed or the saved-metrics path) owns.
  const variantDeleteIds: string[] = [];
  const monthDeleteIds: string[] = [];
  for (const [groupId, variants] of variantsByGroupId) {
    for (const row of existingVariantIds.get(groupId) ?? []) {
      if (!variants.has(row.variantKeyword)) variantDeleteIds.push(row.id);
    }
    const months = monthsByGroupId.get(groupId) ?? new Map();
    for (const [rowId, year, month] of existingMonthRows.get(groupId) ?? []) {
      if (!months.has(`${year}-${month}`)) monthDeleteIds.push(rowId);
    }
  }

  if (variantDeleteIds.length > 0) {
    await runBatch((tx) => [
      tx
        .delete(googleAdsPlannerGroupVariants)
        .where(inArray(googleAdsPlannerGroupVariants.id, variantDeleteIds)),
    ]);
  }
  if (monthDeleteIds.length > 0) {
    await runBatch((tx) => [
      tx
        .delete(googleAdsPlannerGroupMonths)
        .where(inArray(googleAdsPlannerGroupMonths.id, monthDeleteIds)),
    ]);
  }

  const variantValues = [...variantsByGroupId].flatMap(([groupId, variants]) =>
    [...variants].map((variantKeyword) => ({
      id: crypto.randomUUID(),
      groupId,
      variantKeyword,
      sourceFetchedAt,
      updatedAt: now,
    })),
  );
  if (variantValues.length > 0) {
    await runBatch((tx) =>
      variantValues.map((value) =>
        tx
          .insert(googleAdsPlannerGroupVariants)
          .values(value)
          .onConflictDoUpdate({
            target: [
              googleAdsPlannerGroupVariants.groupId,
              googleAdsPlannerGroupVariants.variantKeyword,
            ],
            set: { sourceFetchedAt, updatedAt: now },
          }),
      ),
    );
  }

  const monthValues: Array<{
    id: string;
    groupId: string;
    year: number;
    month: number;
    volume: number | null;
    updatedAt: string;
  }> = [];
  for (const [groupId, months] of monthsByGroupId) {
    for (const [key, entry] of months) {
      const separator = key.indexOf("-");
      monthValues.push({
        id: crypto.randomUUID(),
        groupId,
        year: Number(key.slice(0, separator)),
        month: Number(key.slice(separator + 1)),
        // A null volume means Google reported no data — never fictional 0.
        volume: entry.volume ?? null,
        updatedAt: now,
      });
    }
  }
  if (monthValues.length > 0) {
    await runBatch((tx) =>
      monthValues.map((value) =>
        tx
          .insert(googleAdsPlannerGroupMonths)
          .values(value)
          .onConflictDoUpdate({
            target: [
              googleAdsPlannerGroupMonths.groupId,
              googleAdsPlannerGroupMonths.year,
              googleAdsPlannerGroupMonths.month,
            ],
            set: { volume: value.volume, updatedAt: now },
          }),
      ),
    );
  }
}

export const GoogleAdsPlannerKeywordRepository = {
  recordGroupObservation,
  getObservation,
  getKeywordGroupMatches,
  getLatestMetricsObservation,
};
