/* eslint-disable max-lines */
import {
  and,
  count,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  like,
  lte,
  ne,
  or,
  sql,
} from "drizzle-orm";
import type { InferInsertModel } from "drizzle-orm";
import { db } from "@/db";
import {
  rankTrackingConfigs,
  rankCheckRuns,
  rankSnapshots,
  rankProviderCalls,
  rankTrackingKeywords,
  projects,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import {
  getLatestSnapshotsForKeywords,
  getLatestValidSnapshotsForKeywords,
  getSnapshotsBeforeDate,
  getEarliestSnapshotsForKeywords,
  getValidDailySnapshotsForConfig,
  getKeywordHistory,
  getConfigTrend,
  getPositionMatrix,
  getLatestPositionsMap,
} from "./snapshotQueries";
import { getLatestRankingFactsForConfig } from "./missingRankingQueries";

// ---------------------------------------------------------------------------
// Config CRUD
// ---------------------------------------------------------------------------

async function getProjectsForOrganization(organizationId: string) {
  return db
    .select()
    .from(projects)
    .where(
      and(
        eq(projects.organizationId, organizationId),
        isNull(projects.archivedAt),
      ),
    );
}

async function getConfigsForProject(projectId: string) {
  return db
    .select()
    .from(rankTrackingConfigs)
    .where(
      and(
        eq(rankTrackingConfigs.projectId, projectId),
        eq(rankTrackingConfigs.isActive, true),
      ),
    )
    .orderBy(rankTrackingConfigs.createdAt);
}

async function getConfigById({
  configId,
  projectId,
}: {
  configId: string;
  projectId: string;
}) {
  const rows = await db
    .select()
    .from(rankTrackingConfigs)
    .where(
      and(
        eq(rankTrackingConfigs.id, configId),
        eq(rankTrackingConfigs.projectId, projectId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getConfigByProjectDomainLocation(
  projectId: string,
  domain: string,
  locationCode: number,
  locationName: string | null,
) {
  const rows = await db
    .select()
    .from(rankTrackingConfigs)
    .where(
      and(
        eq(rankTrackingConfigs.projectId, projectId),
        eq(rankTrackingConfigs.domain, domain),
        eq(rankTrackingConfigs.locationCode, locationCode),
        // National (NULL) and per-city configs are distinct rows — mirrors
        // the partial unique indexes, so a national config and any number of
        // city configs can coexist for the same domain.
        locationName === null
          ? isNull(rankTrackingConfigs.locationName)
          : eq(rankTrackingConfigs.locationName, locationName),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function createConfig(
  data: InferInsertModel<typeof rankTrackingConfigs>,
) {
  await db.insert(rankTrackingConfigs).values(data);
}

async function updateConfig(
  configId: string,
  projectId: string,
  data: Partial<InferInsertModel<typeof rankTrackingConfigs>>,
) {
  await db
    .update(rankTrackingConfigs)
    .set(data)
    .where(
      and(
        eq(rankTrackingConfigs.id, configId),
        eq(rankTrackingConfigs.projectId, projectId),
      ),
    );
}

async function getDueConfigsWithOrganization(nowIso: string) {
  return db
    .select({
      id: rankTrackingConfigs.id,
      projectId: rankTrackingConfigs.projectId,
      domain: rankTrackingConfigs.domain,
      locationCode: rankTrackingConfigs.locationCode,
      languageCode: rankTrackingConfigs.languageCode,
      locationName: rankTrackingConfigs.locationName,
      devices: rankTrackingConfigs.devices,
      serpDepth: rankTrackingConfigs.serpDepth,
      scheduleInterval: rankTrackingConfigs.scheduleInterval,
      nextCheckAt: rankTrackingConfigs.nextCheckAt,
      lastCheckedAt: rankTrackingConfigs.lastCheckedAt,
      organizationId: projects.organizationId,
    })
    .from(rankTrackingConfigs)
    .innerJoin(projects, eq(rankTrackingConfigs.projectId, projects.id))
    .where(
      and(
        eq(rankTrackingConfigs.isActive, true),
        lte(rankTrackingConfigs.nextCheckAt, nowIso),
        isNull(projects.archivedAt),
      ),
    )
    .limit(50);
}

async function countPersistedPairsForOrgSince(
  organizationId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(rankSnapshots)
    .innerJoin(projects, eq(rankSnapshots.projectId, projects.id))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        gte(rankSnapshots.checkedAt, sinceIso),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function countPersistedPairsForProjectSince(
  projectId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(rankSnapshots)
    .where(
      and(
        eq(rankSnapshots.projectId, projectId),
        gte(rankSnapshots.checkedAt, sinceIso),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function countInFlightReservedPairsForOrg(
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({
      keywordsTotal: rankCheckRuns.keywordsTotal,
      devices: rankTrackingConfigs.devices,
    })
    .from(rankCheckRuns)
    .innerJoin(projects, eq(rankCheckRuns.projectId, projects.id))
    .innerJoin(
      rankTrackingConfigs,
      eq(rankCheckRuns.configId, rankTrackingConfigs.id),
    )
    .where(
      and(
        eq(projects.organizationId, organizationId),
        inArray(rankCheckRuns.status, ["pending", "running"]),
      ),
    );

  let total = 0;
  for (const r of rows) {
    const deviceMultiplier = r.devices === "both" ? 2 : 1;
    total += (r.keywordsTotal || 0) * deviceMultiplier;
  }
  return total;
}

async function countInFlightReservedPairsForProject(
  projectId: string,
): Promise<number> {
  const rows = await db
    .select({
      keywordsTotal: rankCheckRuns.keywordsTotal,
      devices: rankTrackingConfigs.devices,
    })
    .from(rankCheckRuns)
    .innerJoin(
      rankTrackingConfigs,
      eq(rankCheckRuns.configId, rankTrackingConfigs.id),
    )
    .where(
      and(
        eq(rankCheckRuns.projectId, projectId),
        inArray(rankCheckRuns.status, ["pending", "running"]),
      ),
    );

  let total = 0;
  for (const r of rows) {
    const deviceMultiplier = r.devices === "both" ? 2 : 1;
    total += (r.keywordsTotal || 0) * deviceMultiplier;
  }
  return total;
}

async function findExistingSnapshotForObservation(input: {
  configId: string;
  trackingKeywordId: string;
  trackingTargetId?: string | null;
  device: "desktop" | "mobile";
  dateStr: string;
  source?: "daily_import" | "any";
}): Promise<typeof rankSnapshots.$inferSelect | null> {
  const conditions = [
    eq(rankSnapshots.configId, input.configId),
    eq(rankSnapshots.trackingKeywordId, input.trackingKeywordId),
    eq(rankSnapshots.device, input.device),
  ];

  if (input.source === "daily_import") {
    // Use observationSource as the authoritative provenance field, independent
    // of completionConfidence. Only treat pre-migration legacy NULL/'legacy' rows
    // as daily imports when their providerStatus explicitly matches daily sync
    // output so legacy manual CONFIRMED snapshots are never misclassified.
    conditions.push(
      eq(rankSnapshots.checkedDate, input.dateStr),
      or(
        eq(rankSnapshots.observationSource, "daily_sync"),
        and(
          or(
            isNull(rankSnapshots.observationSource),
            eq(rankSnapshots.observationSource, "legacy"),
          ),
          like(
            rankSnapshots.providerStatus,
            "%SE Ranking daily position import%",
          ),
        ),
      )!,
    );
  } else {
    conditions.push(
      or(
        eq(rankSnapshots.checkedDate, input.dateStr),
        like(rankSnapshots.checkedAt, `${input.dateStr}%`),
        and(
          gte(rankSnapshots.checkedAt, `${input.dateStr}T00:00:00.000Z`),
          lte(rankSnapshots.checkedAt, `${input.dateStr}T23:59:59.999Z`),
        ),
      )!,
    );
  }

  if (input.trackingTargetId !== undefined) {
    if (input.trackingTargetId === null) {
      conditions.push(isNull(rankSnapshots.trackingTargetId));
    } else {
      conditions.push(
        eq(rankSnapshots.trackingTargetId, input.trackingTargetId),
      );
    }
  }

  const rows = await db
    .select()
    .from(rankSnapshots)
    .where(and(...conditions))
    .orderBy(desc(rankSnapshots.checkedAt), desc(rankSnapshots.id))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestSnapshotDateForKeywordTarget(input: {
  configId: string;
  trackingKeywordId: string;
  trackingTargetId?: string | null;
  device: "desktop" | "mobile";
}): Promise<string | null> {
  const conditions = [
    eq(rankSnapshots.configId, input.configId),
    eq(rankSnapshots.trackingKeywordId, input.trackingKeywordId),
    eq(rankSnapshots.device, input.device),
    eq(rankSnapshots.provider, "seranking"),
    or(
      isNull(rankSnapshots.rankingStatus),
      and(
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
        ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
      ),
    ),
    sql`(${rankSnapshots.completionConfidence} IS NULL OR ${rankSnapshots.completionConfidence} != 'UNVERIFIED')`,
  ];
  if (input.trackingTargetId) {
    conditions.push(eq(rankSnapshots.trackingTargetId, input.trackingTargetId));
  }
  const rows = await db
    .select({
      checkedDate: rankSnapshots.checkedDate,
      checkedAt: rankSnapshots.checkedAt,
    })
    .from(rankSnapshots)
    .where(and(...conditions))
    .orderBy(
      desc(
        sql`coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10))`,
      ),
      desc(rankSnapshots.id),
    )
    .limit(1);

  const row = rows[0];
  if (!row) return null;
  if (row.checkedDate && /^\d{4}-\d{2}-\d{2}$/.test(row.checkedDate)) {
    return row.checkedDate;
  }
  if (row.checkedAt) {
    return String(row.checkedAt).slice(0, 10);
  }
  return null;
}

async function countRunsForOrgSince(
  organizationId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(rankCheckRuns)
    .innerJoin(projects, eq(rankCheckRuns.projectId, projects.id))
    .where(
      and(
        eq(projects.organizationId, organizationId),
        gte(rankCheckRuns.startedAt, sinceIso),
      ),
    );
  return rows[0]?.total ?? 0;
}

async function countRunsForProjectSince(
  projectId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ total: count() })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.projectId, projectId),
        gte(rankCheckRuns.startedAt, sinceIso),
      ),
    );
  return rows[0]?.total ?? 0;
}

// ---------------------------------------------------------------------------
// Run CRUD
// ---------------------------------------------------------------------------

/**
 * Try to insert a new pending run. Returns true if inserted, false if blocked
 * by the partial unique index on (config_id) WHERE status IN ('pending',
 * 'running') — i.e. another active run exists for this config.
 *
 * This is how duplicate-trigger protection is enforced: the DB rejects the
 * second insert rather than a separate lock table.
 */
async function tryCreateRun(data: {
  id: string;
  configId: string;
  projectId: string;
  keywordsTotal: number;
  trigger?: "manual" | "scheduled";
  isSubsetRun?: boolean;
}): Promise<boolean> {
  const inserted = await db
    .insert(rankCheckRuns)
    .values({ ...data, trigger: data.trigger ?? "manual", status: "pending" })
    .onConflictDoNothing()
    .returning({ id: rankCheckRuns.id });
  return inserted.length > 0;
}

async function updateRun(
  runId: string,
  data: Partial<InferInsertModel<typeof rankCheckRuns>>,
) {
  await db.update(rankCheckRuns).set(data).where(eq(rankCheckRuns.id, runId));
}

async function getRunById(runId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.configId, configId))
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestScheduledRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        eq(rankCheckRuns.trigger, "scheduled"),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestScheduledRunsForConfigs(configIds: string[]) {
  const result = new Map<string, typeof rankCheckRuns.$inferSelect>();
  if (configIds.length === 0) return result;

  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(
      and(
        inArray(rankCheckRuns.configId, configIds),
        eq(rankCheckRuns.trigger, "scheduled"),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt));

  for (const row of rows) {
    if (!result.has(row.configId)) {
      result.set(row.configId, row);
    }
  }
  return result;
}

/**
 * Most recent runs for a config, newest first. Detector input layer filters
 * these to qualifying runs (completed, or partial with committed snapshots);
 * failed/empty runs never qualify as detection windows.
 */
async function getRecentRunsForConfig(configId: string, limit: number) {
  return db
    .select()
    .from(rankCheckRuns)
    .where(eq(rankCheckRuns.configId, configId))
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(limit);
}

/**
 * Returns the currently active (pending or running) run for a config, if any.
 * At most one such row exists, enforced by the partial unique index.
 */
async function getActiveRunForConfig(configId: string) {
  const rows = await db
    .select()
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// Snapshots
// ---------------------------------------------------------------------------

async function insertSnapshots(
  snapshots: Array<Omit<InferInsertModel<typeof rankSnapshots>, "id">>,
) {
  // Target the partial unique indexes explicitly so primary-key drift never gets
  // swallowed while target-aware multi-country observations and legacy rows are
  // each deduplicated safely even when `location` or `language` is NULL.
  // Note: drizzle-orm's sqlite-core `onConflictDoNothing({ target, where })`
  // currently emits invalid SQL (`DO NOTHING WHERE ...`), whereas
  // `onConflictDoUpdate({ target, targetWhere, set })` emits valid
  // `ON CONFLICT (...) WHERE ... DO UPDATE SET ...` in both SQLite and PG.
  await executeInBatches(snapshots, (tx, snapshot) => {
    const normalizedSnapshot =
      snapshot.trackingTargetId !== null &&
      snapshot.trackingTargetId !== undefined &&
      !snapshot.checkedDate
        ? {
            ...snapshot,
            checkedDate:
              typeof snapshot.checkedAt === "string" &&
              snapshot.checkedAt.length >= 10
                ? snapshot.checkedAt.slice(0, 10)
                : new Date().toISOString().slice(0, 10),
          }
        : snapshot;

    return normalizedSnapshot.trackingTargetId !== null &&
      normalizedSnapshot.trackingTargetId !== undefined
      ? tx
          .insert(rankSnapshots)
          .values(normalizedSnapshot)
          .onConflictDoUpdate({
            target: [
              rankSnapshots.runId,
              rankSnapshots.trackingTargetId,
              rankSnapshots.trackingKeywordId,
              rankSnapshots.device,
              rankSnapshots.checkedDate,
            ],
            targetWhere: isNotNull(rankSnapshots.trackingTargetId),
            set: { trackingKeywordId: normalizedSnapshot.trackingKeywordId },
          })
      : tx
          .insert(rankSnapshots)
          .values(normalizedSnapshot)
          .onConflictDoUpdate({
            target: [
              rankSnapshots.runId,
              rankSnapshots.trackingKeywordId,
              rankSnapshots.device,
            ],
            targetWhere: isNull(rankSnapshots.trackingTargetId),
            set: { trackingKeywordId: normalizedSnapshot.trackingKeywordId },
          });
  });
}

async function getSnapshotsForRun(runId: string) {
  return db.select().from(rankSnapshots).where(eq(rankSnapshots.runId, runId));
}

async function insertProviderCalls(
  calls: Array<
    Omit<InferInsertModel<typeof rankProviderCalls>, "id" | "createdAt">
  >,
) {
  if (calls.length === 0) return;
  await executeInBatches(calls, (tx, call) =>
    tx.insert(rankProviderCalls).values(call),
  );
}

async function getProviderCallsForRun(runId: string) {
  return db
    .select()
    .from(rankProviderCalls)
    .where(eq(rankProviderCalls.runId, runId))
    .orderBy(rankProviderCalls.id);
}

// ---------------------------------------------------------------------------
// Tracking keywords per config
// ---------------------------------------------------------------------------

async function getKeywordsForConfig(configId: string) {
  return db
    .select()
    .from(rankTrackingKeywords)
    .where(eq(rankTrackingKeywords.configId, configId))
    .orderBy(rankTrackingKeywords.createdAt);
}

async function addKeywordsToConfig(
  keywords: Array<{ id: string; configId: string; keyword: string }>,
) {
  await executeInBatches(keywords, (tx, kw) =>
    tx.insert(rankTrackingKeywords).values(kw).onConflictDoNothing(),
  );
}

async function removeKeywordsFromConfig(
  keywordIds: string[],
  configId: string,
) {
  if (keywordIds.length === 0) return;
  const CHUNK_SIZE = 90;
  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);
    await db
      .delete(rankTrackingKeywords)
      .where(
        and(
          inArray(rankTrackingKeywords.id, chunk),
          eq(rankTrackingKeywords.configId, configId),
        ),
      );
  }
}

async function getConfigSummaries(projectId: string) {
  const configs = await getConfigsForProject(projectId);
  if (configs.length === 0) return [];

  // Batch: keyword counts grouped by config
  const kwCounts = await db
    .select({
      configId: rankTrackingKeywords.configId,
      value: count(),
    })
    .from(rankTrackingKeywords)
    .where(
      inArray(
        rankTrackingKeywords.configId,
        configs.map((c) => c.id),
      ),
    )
    .groupBy(rankTrackingKeywords.configId);

  const kwCountMap = new Map(kwCounts.map((r) => [r.configId, r.value]));

  const configIds = configs.map((c) => c.id);
  const runs = await db
    .select({
      configId: rankCheckRuns.configId,
      status: rankCheckRuns.status,
      completedAt: rankCheckRuns.completedAt,
    })
    .from(rankCheckRuns)
    .where(inArray(rankCheckRuns.configId, configIds))
    .orderBy(desc(rankCheckRuns.startedAt));

  const latestRunMap = new Map<
    string,
    { status: string; completedAt: string | null }
  >();
  for (const run of runs) {
    if (!latestRunMap.has(run.configId)) {
      latestRunMap.set(run.configId, {
        status: run.status,
        completedAt: run.completedAt,
      });
    }
  }

  return configs.map((config) => ({
    ...config,
    keywordCount: kwCountMap.get(config.id) ?? 0,
    lastRunStatus: latestRunMap.get(config.id)?.status ?? null,
    lastRunCompletedAt: latestRunMap.get(config.id)?.completedAt ?? null,
  }));
}

async function updateKeywordMetrics(
  updates: Array<{
    id: string;
    searchVolume: number | null;
    keywordDifficulty: number | null;
    cpc: number | null;
    metricsFetchedAt: string;
  }>,
) {
  await executeInBatches(updates, (tx, u) =>
    tx
      .update(rankTrackingKeywords)
      .set({
        searchVolume: u.searchVolume,
        keywordDifficulty: u.keywordDifficulty,
        cpc: u.cpc,
        metricsFetchedAt: u.metricsFetchedAt,
      })
      .where(eq(rankTrackingKeywords.id, u.id)),
  );
}

async function getKeywordCountForConfig(configId: string) {
  const rows = await db
    .select({ value: count() })
    .from(rankTrackingKeywords)
    .where(eq(rankTrackingKeywords.configId, configId));
  return rows[0]?.value ?? 0;
}

export const RankTrackingRepository = {
  getProjectsForOrganization,
  getConfigsForProject,
  getConfigById,
  getConfigByProjectDomainLocation,
  createConfig,
  updateConfig,
  getDueConfigsWithOrganization,
  tryCreateRun,
  updateRun,
  getRunById,
  getLatestRunForConfig,
  getLatestScheduledRunForConfig,
  getLatestScheduledRunsForConfigs,
  getRecentRunsForConfig,
  getActiveRunForConfig,
  insertSnapshots,
  getSnapshotsForRun,
  insertProviderCalls,
  getProviderCallsForRun,
  getKeywordsForConfig,
  addKeywordsToConfig,
  removeKeywordsFromConfig,
  updateKeywordMetrics,
  getKeywordCountForConfig,
  getConfigSummaries,
  getLatestSnapshotsForKeywords,
  getLatestValidSnapshotsForKeywords,
  getSnapshotsBeforeDate,
  getEarliestSnapshotsForKeywords,
  getValidDailySnapshotsForConfig,
  getKeywordHistory,
  getConfigTrend,
  getPositionMatrix,
  getLatestPositionsMap,
  getLatestRankingFactsForConfig,
  countRunsForOrgSince,
  countRunsForProjectSince,
  countPersistedPairsForOrgSince,
  countPersistedPairsForProjectSince,
  countInFlightReservedPairsForOrg,
  countInFlightReservedPairsForProject,
  findExistingSnapshotForObservation,
  getLatestSnapshotDateForKeywordTarget,
};
