/* eslint-disable max-lines */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  lt,
  lte,
  max,
  min,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { rankCheckRuns, rankSnapshots } from "@/db/schema";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";

function completedRunIdsForConfig(configId: string) {
  return db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
      ),
    );
}

function cutoffTimestamp(sinceDays: number): string {
  return toSqliteTimestamp(
    new Date(Date.now() - sinceDays * 24 * 60 * 60 * 1000),
  );
}

export interface LatestPositionsOptions {
  excludeRunId?: string;
  beforeDate?: string;
}

/**
 * Map latest known positions for a list of (keywordId, device) pairs in a config.
 * Used to resolve previousPosition before inserting new snapshots.
 *
 * Strict resolution semantics:
 * - Scoped to config and completed runs
 * - Excludes currentRunId (both from runs and snapshots)
 * - Excludes CHECK_FAILED snapshots so vendor errors do not corrupt prior rank
 * - If beforeDate is provided, strictly before that date
 * - Returns position as integer or null (NO_RESULT preserved as null, never 0)
 * - Deterministic regardless of batch/insertion order
 */
export async function getLatestPositionsMap(
  configId: string,
  pairs: Array<{ keywordId: string; device: "desktop" | "mobile" }>,
  options?: LatestPositionsOptions,
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>();
  if (pairs.length === 0) return map;

  const keywordIds = Array.from(new Set(pairs.map((p) => p.keywordId)));

  const runConditions = [
    eq(rankCheckRuns.configId, configId),
    inArray(rankCheckRuns.status, ["completed", "partial"]),
  ];
  if (options?.excludeRunId) {
    runConditions.push(ne(rankCheckRuns.id, options.excludeRunId));
  }

  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(and(...runConditions));

  // D1 caps bound parameters at 100 per statement.
  // The query references validSnapshotConditions twice (grouped subquery + outer where),
  // each containing chunk keyword IDs plus completedRunIds and other filter params.
  // Chunking by 40 keeps total parameters <= 90.
  const CHUNK_SIZE = 40;
  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);

    const validSnapshotConditions = [
      inArray(rankSnapshots.runId, completedRunIds),
      inArray(rankSnapshots.trackingKeywordId, chunk),
      or(
        isNull(rankSnapshots.rankingStatus),
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
      ),
    ];
    if (options?.excludeRunId) {
      validSnapshotConditions.push(
        ne(rankSnapshots.runId, options.excludeRunId),
      );
    }
    if (options?.beforeDate) {
      validSnapshotConditions.push(
        lt(rankSnapshots.checkedAt, options.beforeDate),
      );
    }

    const grouped = db
      .select({
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        device: rankSnapshots.device,
        targetCheckedAt: max(rankSnapshots.checkedAt).as("target_checked_at"),
      })
      .from(rankSnapshots)
      .where(and(...validSnapshotConditions))
      .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
      .as("grouped");

    const rows = await db
      .select({
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        device: rankSnapshots.device,
        position: rankSnapshots.position,
      })
      .from(rankSnapshots)
      .innerJoin(
        grouped,
        and(
          eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
          eq(rankSnapshots.device, grouped.device),
          eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
        ),
      )
      .where(and(...validSnapshotConditions));

    for (const row of rows) {
      map.set(`${row.trackingKeywordId}:${row.device}`, row.position);
    }
  }
  return map;
}

/**
 * Flat per-keyword position series across completed runs, ordered oldest first.
 * `null` position = checked but not found within serpDepth (a real event, not a
 * missing check). The client pivots these rows per device.
 */
export async function getKeywordHistory(
  configId: string,
  trackingKeywordId: string,
  sinceDays: number,
) {
  return db
    .select({
      id: rankSnapshots.id,
      device: rankSnapshots.device,
      checkedAt: rankSnapshots.checkedAt,
      checkedDate: rankSnapshots.checkedDate,
      position: rankSnapshots.position,
      previousPosition: rankSnapshots.previousPosition,
      rankingStatus: rankSnapshots.rankingStatus,
      url: rankSnapshots.url,
      providerStatus: rankSnapshots.providerStatus,
      errorMessage: rankSnapshots.errorMessage,
    })
    .from(rankSnapshots)
    .where(
      and(
        inArray(rankSnapshots.runId, completedRunIdsForConfig(configId)),
        eq(rankSnapshots.trackingKeywordId, trackingKeywordId),
        gte(rankSnapshots.checkedAt, cutoffTimestamp(sinceDays)),
      ),
    )
    .orderBy(asc(rankSnapshots.checkedAt));
}

/**
 * Keyword-position distribution for one device grouped by check date, oldest first.
 * Resolves each tracked keyword's latest known ranking as of each check date
 * so that subset checks (e.g. checking missing rankings, selected keywords, or
 * partial runs) correctly update the portfolio's distribution without collapsing
 * the total keyword count or being discarded.
 */
export async function getConfigTrend(
  configId: string,
  device: "desktop" | "mobile",
  sinceDays: number,
) {
  const cutoff = cutoffTimestamp(sinceDays);

  const dateList = db.$with("date_list").as(
    db
      .select({
        checkDate: sql<string>`substr(${rankCheckRuns.startedAt}, 1, 10)`.as(
          "check_date",
        ),
        latestRunAt: sql<string>`max(${rankCheckRuns.startedAt})`.as(
          "latest_run_at",
        ),
        runId: sql<string>`max(${rankCheckRuns.id})`.as("run_id"),
      })
      .from(rankCheckRuns)
      .where(
        and(
          eq(rankCheckRuns.configId, configId),
          inArray(rankCheckRuns.status, ["completed", "partial"]),
          gte(rankCheckRuns.startedAt, cutoff),
        ),
      )
      .groupBy(sql`substr(${rankCheckRuns.startedAt}, 1, 10)`),
  );

  const rankedSnapshots = db.$with("ranked_snapshots").as(
    db
      .select({
        checkDate: sql<string>`date_list.check_date`.as("check_date"),
        latestRunAt: sql<string>`date_list.latest_run_at`.as("latest_run_at"),
        runId: sql<string>`date_list.run_id`.as("run_id"),
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        position: rankSnapshots.position,
        rn: sql<number>`row_number() over (partition by date_list.check_date, ${rankSnapshots.trackingKeywordId} order by ${rankSnapshots.checkedAt} desc)`.as(
          "rn",
        ),
      })
      .from(dateList)
      .innerJoin(
        rankSnapshots,
        and(
          eq(rankSnapshots.configId, configId),
          eq(rankSnapshots.device, device),
          sql`${rankSnapshots.checkedAt} <= date_list.latest_run_at`,
        ),
      )
      .innerJoin(
        rankCheckRuns,
        and(
          eq(rankCheckRuns.id, rankSnapshots.runId),
          inArray(rankCheckRuns.status, ["completed", "partial"]),
        ),
      )
      .where(
        or(
          isNull(rankSnapshots.rankingStatus),
          and(
            ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
            ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
          ),
        ),
      ),
  );

  return db
    .with(dateList, rankedSnapshots)
    .select({
      runId: sql<string>`ranked_snapshots.run_id`,
      checkedAt: sql<string>`ranked_snapshots.latest_run_at`,
      total: sql<number>`count(*)`,
      top3: sql<number>`sum(case when ranked_snapshots.position between 1 and 3 then 1 else 0 end)`,
      top4to10: sql<number>`sum(case when ranked_snapshots.position between 4 and 10 then 1 else 0 end)`,
      top11to20: sql<number>`sum(case when ranked_snapshots.position between 11 and 20 then 1 else 0 end)`,
    })
    .from(rankedSnapshots)
    .where(sql`ranked_snapshots.rn = 1`)
    .groupBy(
      sql`ranked_snapshots.check_date`,
      sql`ranked_snapshots.latest_run_at`,
      sql`ranked_snapshots.run_id`,
    )
    .orderBy(asc(sql`ranked_snapshots.check_date`));
}

/**
 * Recent per-keyword positions for one device as a flat list, for the "by date"
 * history matrix. Bounded to the last `runLimit` completed runs; the client
 * pivots these into keyword rows × run (date) columns.
 */
export async function getPositionMatrix(
  configId: string,
  device: "desktop" | "mobile",
  runLimit: number,
) {
  const recentRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
        eq(rankCheckRuns.isSubsetRun, false),
      ),
    )
    .orderBy(desc(rankCheckRuns.startedAt))
    .limit(runLimit);

  return db
    .select({
      runId: rankSnapshots.runId,
      checkedAt: rankCheckRuns.startedAt,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      position: rankSnapshots.position,
    })
    .from(rankSnapshots)
    .innerJoin(rankCheckRuns, eq(rankSnapshots.runId, rankCheckRuns.id))
    .where(
      and(
        inArray(rankSnapshots.runId, recentRunIds),
        eq(rankSnapshots.device, device),
        or(
          isNull(rankSnapshots.rankingStatus),
          and(
            ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
            ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
          ),
        ),
      ),
    )
    .orderBy(asc(rankCheckRuns.startedAt));
}

/**
 * Pick one snapshot per keyword+device from completed runs, using SQL GROUP BY
 * + self-join instead of loading all snapshots into JS memory.
 *
 * No keywordIds needed — scoped to the config via a completed-runs subquery,
 * so subset runs are included automatically.
 */
export async function getSnapshotsForConfig(
  configId: string,
  opts: {
    beforeDate?: string;
    order: "latest" | "earliest";
    validOnly?: boolean;
  },
) {
  const allowedStatuses: ("completed" | "partial" | "failed")[] = opts.validOnly
    ? ["completed", "partial"]
    : ["completed", "partial", "failed"];

  const candidateRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, allowedStatuses),
      ),
    );

  const aggFn = opts.order === "latest" ? max : min;

  const conditions = [inArray(rankSnapshots.runId, candidateRunIds)];
  if (opts.beforeDate) {
    conditions.push(lte(rankSnapshots.checkedAt, opts.beforeDate));
  }
  if (opts.validOnly) {
    const validCond = or(
      isNull(rankSnapshots.rankingStatus),
      and(
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
        ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
      ),
    );
    if (validCond) {
      conditions.push(validCond);
    }
  }

  const grouped = db
    .select({
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      device: rankSnapshots.device,
      targetCheckedAt: aggFn(rankSnapshots.checkedAt).as("target_checked_at"),
    })
    .from(rankSnapshots)
    .where(and(...conditions))
    .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
    .as("grouped");

  return db
    .select({
      id: rankSnapshots.id,
      runId: rankSnapshots.runId,
      trackingKeywordId: rankSnapshots.trackingKeywordId,
      keyword: rankSnapshots.keyword,
      device: rankSnapshots.device,
      position: rankSnapshots.position,
      previousPosition: rankSnapshots.previousPosition,
      rankingStatus: rankSnapshots.rankingStatus,
      url: rankSnapshots.url,
      serpFeatures: rankSnapshots.serpFeatures,
      provider: rankSnapshots.provider,
      providerStatus: rankSnapshots.providerStatus,
      providerStatusCode: rankSnapshots.providerStatusCode,
      errorMessage: rankSnapshots.errorMessage,
      checkedAt: rankSnapshots.checkedAt,
    })
    .from(rankSnapshots)
    .innerJoin(
      grouped,
      and(
        eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
        eq(rankSnapshots.device, grouped.device),
        eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
      ),
    )
    .where(and(...conditions));
}

export async function getLatestSnapshotsForKeywords(configId: string) {
  return getSnapshotsForConfig(configId, { order: "latest" });
}

export async function getLatestValidSnapshotsForKeywords(configId: string) {
  return getSnapshotsForConfig(configId, { order: "latest", validOnly: true });
}

export async function getSnapshotsBeforeDate(
  configId: string,
  beforeDate: string,
) {
  return getSnapshotsForConfig(configId, {
    beforeDate,
    order: "latest",
    validOnly: true,
  });
}

export async function getEarliestSnapshotsForKeywords(
  configId: string,
  keywordIds: string[],
) {
  if (keywordIds.length === 0) return [];

  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
      ),
    );

  // D1 caps bound parameters at 100 per statement. The query binds N keyword
  // IDs plus 5 params from completedRunIds and rankingStatus, referenced TWICE
  // (both in the `grouped` subquery and the outer `where`).
  // With CHUNK_SIZE = 40: (5 + 40) * 2 = 90 params <= 100 limit.
  const CHUNK_SIZE = 40;
  const allResults: Awaited<ReturnType<typeof getSnapshotsForConfig>> = [];

  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);

    const validConditions = [
      inArray(rankSnapshots.runId, completedRunIds),
      inArray(rankSnapshots.trackingKeywordId, chunk),
      or(
        isNull(rankSnapshots.rankingStatus),
        and(
          ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
          ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
        ),
      ),
    ];

    const grouped = db
      .select({
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        device: rankSnapshots.device,
        targetCheckedAt: min(rankSnapshots.checkedAt).as("target_checked_at"),
      })
      .from(rankSnapshots)
      .where(and(...validConditions))
      .groupBy(rankSnapshots.trackingKeywordId, rankSnapshots.device)
      .as("grouped");

    const rows = await db
      .select({
        id: rankSnapshots.id,
        runId: rankSnapshots.runId,
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        keyword: rankSnapshots.keyword,
        device: rankSnapshots.device,
        position: rankSnapshots.position,
        previousPosition: rankSnapshots.previousPosition,
        rankingStatus: rankSnapshots.rankingStatus,
        url: rankSnapshots.url,
        serpFeatures: rankSnapshots.serpFeatures,
        provider: rankSnapshots.provider,
        providerStatus: rankSnapshots.providerStatus,
        providerStatusCode: rankSnapshots.providerStatusCode,
        errorMessage: rankSnapshots.errorMessage,
        checkedAt: rankSnapshots.checkedAt,
      })
      .from(rankSnapshots)
      .innerJoin(
        grouped,
        and(
          eq(rankSnapshots.trackingKeywordId, grouped.trackingKeywordId),
          eq(rankSnapshots.device, grouped.device),
          eq(rankSnapshots.checkedAt, grouped.targetCheckedAt),
        ),
      )
      .where(and(...validConditions));

    allResults.push(...rows);
  }

  return allResults;
}
