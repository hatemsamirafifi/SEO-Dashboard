/* eslint-disable max-lines */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNull,
  ne,
  or,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import { rankCheckRuns, rankSnapshots } from "@/db/schema";
import { toSqliteTimestamp } from "@/server/features/rank-tracking/rankTrackingTimestamps";

/**
 * SQL fragment excluding UNVERIFIED snapshots from valid-snapshot queries.
 * An UNVERIFIED row (completion_confidence = 'UNVERIFIED') is a same-day
 * observation identical to the pre-recheck baseline — it may be stale data
 * from an earlier run, never a fresh ranking. It must never surface as a
 * valid position, affect position changes/history trends, or feed SAM/
 * detector recommendations. Inlined as raw SQL so no extra bound parameter
 * is added (D1 caps parameters at 100 per statement).
 */
const EXCLUDE_UNVERIFIED = sql`(${rankSnapshots.completionConfidence} IS NULL OR ${rankSnapshots.completionConfidence} != 'UNVERIFIED')`;

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
  trackingTargetId?: string;
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
  // Chunking by 38 keeps total parameters <= 90.
  const CHUNK_SIZE = 38;
  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);

    const validSnapshotConditions = [
      inArray(rankSnapshots.runId, completedRunIds),
      inArray(rankSnapshots.trackingKeywordId, chunk),
      or(
        isNull(rankSnapshots.rankingStatus),
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
      ),
      EXCLUDE_UNVERIFIED,
    ];
    if (options?.excludeRunId) {
      validSnapshotConditions.push(
        ne(rankSnapshots.runId, options.excludeRunId),
      );
    }
    if (options?.beforeDate) {
      const beforeDay = options.beforeDate.slice(0, 10);
      validSnapshotConditions.push(
        sql`((${rankSnapshots.checkedDate} is not null and ${rankSnapshots.checkedDate} < ${beforeDay}) or (${rankSnapshots.checkedDate} is null and ${rankSnapshots.checkedAt} < ${options.beforeDate}))`,
      );
    }
    if (options?.trackingTargetId) {
      validSnapshotConditions.push(
        eq(rankSnapshots.trackingTargetId, options.trackingTargetId),
      );
    }

    const ranked = db.$with("ranked").as(
      db
        .select({
          trackingTargetId: rankSnapshots.trackingTargetId,
          trackingKeywordId: rankSnapshots.trackingKeywordId,
          device: rankSnapshots.device,
          position: rankSnapshots.position,
          rn: sql<number>`row_number() over (
            partition by coalesce(${rankSnapshots.trackingTargetId}, 'none'), ${rankSnapshots.trackingKeywordId}, ${rankSnapshots.device}
            order by
              coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10)) desc,
              case
                when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
                when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
                else 1
              end desc,
              case
                when ${rankSnapshots.observationSource} = 'daily_sync' then 2
                when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
                else 1
              end desc,
              case
                when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
                when ${rankSnapshots.rankingStatus} is null then 1
                else 0
              end desc,
              ${rankSnapshots.checkedAt} desc,
              ${rankSnapshots.id} desc
          )`.as("rn"),
        })
        .from(rankSnapshots)
        .where(and(...validSnapshotConditions)),
    );

    const rows = await db
      .with(ranked)
      .select({
        trackingTargetId: ranked.trackingTargetId,
        trackingKeywordId: ranked.trackingKeywordId,
        device: ranked.device,
        position: ranked.position,
      })
      .from(ranked)
      .where(sql`ranked.rn = 1`);

    for (const row of rows) {
      if (row.trackingTargetId) {
        map.set(
          `${row.trackingTargetId}:${row.trackingKeywordId}:${row.device}`,
          row.position,
        );
      }
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
  trackingTargetId?: string,
) {
  const cutoffDate = cutoffTimestamp(sinceDays).slice(0, 10);
  const conditions = [
    inArray(rankSnapshots.runId, completedRunIdsForConfig(configId)),
    eq(rankSnapshots.trackingKeywordId, trackingKeywordId),
    sql`coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10)) >= ${cutoffDate}`,
    EXCLUDE_UNVERIFIED,
    or(
      isNull(rankSnapshots.rankingStatus),
      and(
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
        ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
      ),
    ),
  ];
  if (trackingTargetId) {
    conditions.push(eq(rankSnapshots.trackingTargetId, trackingTargetId));
  }

  const candidates = db.$with("candidates").as(
    db
      .select({
        id: rankSnapshots.id,
        trackingTargetId: rankSnapshots.trackingTargetId,
        countryCode: rankSnapshots.countryCode,
        cityName: rankSnapshots.cityName,
        language: rankSnapshots.language,
        device: rankSnapshots.device,
        checkedAt: rankSnapshots.checkedAt,
        checkedDate: rankSnapshots.checkedDate,
        importedAt: rankSnapshots.importedAt,
        observationSource: rankSnapshots.observationSource,
        position: rankSnapshots.position,
        previousPosition: rankSnapshots.previousPosition,
        rankingStatus: rankSnapshots.rankingStatus,
        url: rankSnapshots.url,
        providerStatus: rankSnapshots.providerStatus,
        errorMessage: rankSnapshots.errorMessage,
        obsDate:
          sql<string>`coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10))`.as(
            "obs_date",
          ),
        rn: sql<number>`row_number() over (
          partition by coalesce(${rankSnapshots.trackingTargetId}, 'none'), ${rankSnapshots.trackingKeywordId}, ${rankSnapshots.device}, coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10))
          order by
            case
              when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
              when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.observationSource} = 'daily_sync' then 2
              when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
              when ${rankSnapshots.rankingStatus} is null then 1
              else 0
            end desc,
            ${rankSnapshots.checkedAt} desc,
            ${rankSnapshots.id} desc
        )`.as("rn"),
      })
      .from(rankSnapshots)
      .where(and(...conditions)),
  );

  return db
    .with(candidates)
    .select({
      id: candidates.id,
      trackingTargetId: candidates.trackingTargetId,
      countryCode: candidates.countryCode,
      cityName: candidates.cityName,
      language: candidates.language,
      device: candidates.device,
      checkedAt: candidates.checkedAt,
      checkedDate: candidates.checkedDate,
      importedAt: candidates.importedAt,
      observationSource: candidates.observationSource,
      position: candidates.position,
      previousPosition: candidates.previousPosition,
      rankingStatus: candidates.rankingStatus,
      url: candidates.url,
      providerStatus: candidates.providerStatus,
      errorMessage: candidates.errorMessage,
    })
    .from(candidates)
    .where(sql`candidates.rn = 1`)
    .orderBy(asc(sql`candidates.obs_date`), asc(candidates.checkedAt));
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
  trackingTargetId?: string,
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
        rn: sql<number>`row_number() over (
          partition by date_list.check_date, ${rankSnapshots.trackingKeywordId}, coalesce(${rankSnapshots.trackingTargetId}, 'none')
          order by
            case
              when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
              when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.observationSource} = 'daily_sync' then 2
              when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
              when ${rankSnapshots.rankingStatus} is null then 1
              else 0
            end desc,
            ${rankSnapshots.checkedAt} desc,
            ${rankSnapshots.id} desc
        )`.as("rn"),
      })
      .from(dateList)
      .innerJoin(
        rankSnapshots,
        and(
          eq(rankSnapshots.configId, configId),
          eq(rankSnapshots.device, device),
          ...(trackingTargetId
            ? [eq(rankSnapshots.trackingTargetId, trackingTargetId)]
            : []),
          sql`coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10)) <= date_list.check_date`,
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
        and(
          or(
            isNull(rankSnapshots.rankingStatus),
            and(
              ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
              ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
            ),
          ),
          EXCLUDE_UNVERIFIED,
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
  trackingTargetId?: string,
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
        ...(trackingTargetId
          ? [eq(rankSnapshots.trackingTargetId, trackingTargetId)]
          : []),
        or(
          isNull(rankSnapshots.rankingStatus),
          and(
            ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
            ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
          ),
        ),
        EXCLUDE_UNVERIFIED,
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
    trackingTargetId?: string;
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

  const conditions = [inArray(rankSnapshots.runId, candidateRunIds)];
  if (opts.beforeDate) {
    const beforeDay = opts.beforeDate.slice(0, 10);
    conditions.push(
      sql`((${rankSnapshots.checkedDate} is not null and ${rankSnapshots.checkedDate} <= ${beforeDay}) or (${rankSnapshots.checkedDate} is null and ${rankSnapshots.checkedAt} <= ${opts.beforeDate}))`,
    );
  }
  if (opts.trackingTargetId) {
    conditions.push(eq(rankSnapshots.trackingTargetId, opts.trackingTargetId));
  }
  if (opts.validOnly) {
    const validCond = and(
      or(
        isNull(rankSnapshots.rankingStatus),
        and(
          ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
          ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
        ),
      ),
      EXCLUDE_UNVERIFIED,
    );
    if (validCond) {
      conditions.push(validCond);
    }
  }

  const aggOrder = opts.order === "latest" ? sql`desc` : sql`asc`;

  const ranked = db.$with("ranked").as(
    db
      .select({
        id: rankSnapshots.id,
        runId: rankSnapshots.runId,
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        trackingTargetId: rankSnapshots.trackingTargetId,
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
        completionConfidence: rankSnapshots.completionConfidence,
        observationSource: rankSnapshots.observationSource,
        countryCode: rankSnapshots.countryCode,
        cityName: rankSnapshots.cityName,
        language: rankSnapshots.language,
        checkedAt: rankSnapshots.checkedAt,
        checkedDate: rankSnapshots.checkedDate,
        importedAt: rankSnapshots.importedAt,
        rn: sql<number>`row_number() over (
          partition by coalesce(${rankSnapshots.trackingTargetId}, 'none'), ${rankSnapshots.trackingKeywordId}, ${rankSnapshots.device}
          order by
            coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10)) ${aggOrder},
            case
              when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
              when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.observationSource} = 'daily_sync' then 2
              when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
              when ${rankSnapshots.rankingStatus} is null then 1
              else 0
            end desc,
            ${rankSnapshots.checkedAt} ${aggOrder},
            coalesce(${rankSnapshots.importedAt}, '') ${aggOrder},
            ${rankSnapshots.id} ${aggOrder}
        )`.as("rn"),
      })
      .from(rankSnapshots)
      .where(and(...conditions)),
  );

  return db
    .with(ranked)
    .select({
      id: ranked.id,
      runId: ranked.runId,
      trackingKeywordId: ranked.trackingKeywordId,
      trackingTargetId: ranked.trackingTargetId,
      keyword: ranked.keyword,
      device: ranked.device,
      position: ranked.position,
      previousPosition: ranked.previousPosition,
      rankingStatus: ranked.rankingStatus,
      url: ranked.url,
      serpFeatures: ranked.serpFeatures,
      provider: ranked.provider,
      providerStatus: ranked.providerStatus,
      providerStatusCode: ranked.providerStatusCode,
      errorMessage: ranked.errorMessage,
      completionConfidence: ranked.completionConfidence,
      observationSource: ranked.observationSource,
      countryCode: ranked.countryCode,
      cityName: ranked.cityName,
      language: ranked.language,
      checkedAt: ranked.checkedAt,
      checkedDate: ranked.checkedDate,
      importedAt: ranked.importedAt,
    })
    .from(ranked)
    .where(sql`ranked.rn = 1`);
}

export async function getLatestSnapshotsForKeywords(
  configId: string,
  trackingTargetId?: string,
) {
  return getSnapshotsForConfig(configId, {
    order: "latest",
    trackingTargetId,
  });
}

export async function getLatestValidSnapshotsForKeywords(
  configId: string,
  trackingTargetId?: string,
) {
  return getSnapshotsForConfig(configId, {
    order: "latest",
    validOnly: true,
    trackingTargetId,
  });
}

export async function getSnapshotsBeforeDate(
  configId: string,
  beforeDate: string,
  trackingTargetId?: string,
) {
  return getSnapshotsForConfig(configId, {
    beforeDate,
    order: "latest",
    validOnly: true,
    trackingTargetId,
  });
}

export async function getEarliestSnapshotsForKeywords(
  configId: string,
  keywordIds: string[],
  trackingTargetId?: string,
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
  // IDs plus up to 6 params from completedRunIds, trackingTargetId, and rankingStatus, referenced TWICE.
  // With CHUNK_SIZE = 38: (6 + 38) * 2 = 88 params <= 100 limit.
  const CHUNK_SIZE = 38;
  const allResults: Awaited<ReturnType<typeof getSnapshotsForConfig>> = [];

  for (let i = 0; i < keywordIds.length; i += CHUNK_SIZE) {
    const chunk = keywordIds.slice(i, i + CHUNK_SIZE);

    const validConditions = [
      inArray(rankSnapshots.runId, completedRunIds),
      inArray(rankSnapshots.trackingKeywordId, chunk),
      ...(trackingTargetId
        ? [eq(rankSnapshots.trackingTargetId, trackingTargetId)]
        : []),
      or(
        isNull(rankSnapshots.rankingStatus),
        and(
          ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
          ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
        ),
      ),
      EXCLUDE_UNVERIFIED,
    ];

    const ranked = db.$with("ranked").as(
      db
        .select({
          id: rankSnapshots.id,
          runId: rankSnapshots.runId,
          trackingKeywordId: rankSnapshots.trackingKeywordId,
          trackingTargetId: rankSnapshots.trackingTargetId,
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
          completionConfidence: rankSnapshots.completionConfidence,
          observationSource: rankSnapshots.observationSource,
          countryCode: rankSnapshots.countryCode,
          cityName: rankSnapshots.cityName,
          language: rankSnapshots.language,
          checkedAt: rankSnapshots.checkedAt,
          checkedDate: rankSnapshots.checkedDate,
          importedAt: rankSnapshots.importedAt,
          rn: sql<number>`row_number() over (
            partition by coalesce(${rankSnapshots.trackingTargetId}, 'none'), ${rankSnapshots.trackingKeywordId}, ${rankSnapshots.device}
            order by
              coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10)) asc,
              case
                when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
                when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
                else 1
              end desc,
              case
                when ${rankSnapshots.observationSource} = 'daily_sync' then 2
                when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
                else 1
              end desc,
              case
                when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
                when ${rankSnapshots.rankingStatus} is null then 1
                else 0
              end desc,
              ${rankSnapshots.checkedAt} asc,
              coalesce(${rankSnapshots.importedAt}, '') asc,
              ${rankSnapshots.id} asc
          )`.as("rn"),
        })
        .from(rankSnapshots)
        .where(and(...validConditions)),
    );

    const rows = await db
      .with(ranked)
      .select({
        id: ranked.id,
        runId: ranked.runId,
        trackingKeywordId: ranked.trackingKeywordId,
        trackingTargetId: ranked.trackingTargetId,
        keyword: ranked.keyword,
        device: ranked.device,
        position: ranked.position,
        previousPosition: ranked.previousPosition,
        rankingStatus: ranked.rankingStatus,
        url: ranked.url,
        serpFeatures: ranked.serpFeatures,
        provider: ranked.provider,
        providerStatus: ranked.providerStatus,
        providerStatusCode: ranked.providerStatusCode,
        errorMessage: ranked.errorMessage,
        completionConfidence: ranked.completionConfidence,
        observationSource: ranked.observationSource,
        countryCode: ranked.countryCode,
        cityName: ranked.cityName,
        language: ranked.language,
        checkedAt: ranked.checkedAt,
        checkedDate: ranked.checkedDate,
        importedAt: ranked.importedAt,
      })
      .from(ranked)
      .where(sql`ranked.rn = 1`);

    allResults.push(...rows);
  }

  return allResults;
}

/**
 * Authoritative daily valid snapshot series for a config, deduplicated per
 * (target, keyword, device, provider, obsDate) and ordered newest observation
 * date first. Used to resolve comparable previous observations without
 * cross-provider, cross-target, or same-day import-order contamination.
 */
export async function getValidDailySnapshotsForConfig(
  configId: string,
  trackingTargetId?: string,
) {
  const completedRunIds = db
    .select({ id: rankCheckRuns.id })
    .from(rankCheckRuns)
    .where(
      and(
        eq(rankCheckRuns.configId, configId),
        inArray(rankCheckRuns.status, ["completed", "partial"]),
      ),
    );

  const conditions = [
    inArray(rankSnapshots.runId, completedRunIds),
    EXCLUDE_UNVERIFIED,
    or(
      isNull(rankSnapshots.rankingStatus),
      and(
        ne(rankSnapshots.rankingStatus, "CHECK_FAILED"),
        ne(rankSnapshots.rankingStatus, "NOT_CHECKED"),
      ),
    ),
  ];
  if (trackingTargetId) {
    conditions.push(eq(rankSnapshots.trackingTargetId, trackingTargetId));
  }

  const obsDateExpr = sql<string>`coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10))`;

  const daily = db.$with("daily").as(
    db
      .select({
        id: rankSnapshots.id,
        runId: rankSnapshots.runId,
        trackingKeywordId: rankSnapshots.trackingKeywordId,
        trackingTargetId: rankSnapshots.trackingTargetId,
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
        completionConfidence: rankSnapshots.completionConfidence,
        observationSource: rankSnapshots.observationSource,
        countryCode: rankSnapshots.countryCode,
        cityName: rankSnapshots.cityName,
        language: rankSnapshots.language,
        checkedAt: rankSnapshots.checkedAt,
        checkedDate: rankSnapshots.checkedDate,
        importedAt: rankSnapshots.importedAt,
        obsDate: obsDateExpr.as("obs_date"),
        rn: sql<number>`row_number() over (
          partition by
            coalesce(${rankSnapshots.trackingTargetId}, 'none'),
            ${rankSnapshots.trackingKeywordId},
            ${rankSnapshots.device},
            ${rankSnapshots.provider},
            coalesce(${rankSnapshots.checkedDate}, substr(${rankSnapshots.checkedAt}, 1, 10))
          order by
            case
              when ${rankSnapshots.completionConfidence} = 'CONFIRMED' then 3
              when ${rankSnapshots.completionConfidence} = 'LIKELY_COMPLETE' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.observationSource} = 'daily_sync' then 2
              when ${rankSnapshots.providerStatus} like '%SE Ranking daily position import%' then 2
              else 1
            end desc,
            case
              when ${rankSnapshots.rankingStatus} in ('RANKED', 'NO_RESULT') then 2
              when ${rankSnapshots.rankingStatus} is null then 1
              else 0
            end desc,
            ${rankSnapshots.checkedAt} desc,
            coalesce(${rankSnapshots.importedAt}, '') desc,
            ${rankSnapshots.id} desc
        )`.as("rn"),
      })
      .from(rankSnapshots)
      .where(and(...conditions)),
  );

  return db
    .with(daily)
    .select({
      id: daily.id,
      runId: daily.runId,
      trackingKeywordId: daily.trackingKeywordId,
      trackingTargetId: daily.trackingTargetId,
      keyword: daily.keyword,
      device: daily.device,
      position: daily.position,
      previousPosition: daily.previousPosition,
      rankingStatus: daily.rankingStatus,
      url: daily.url,
      serpFeatures: daily.serpFeatures,
      provider: daily.provider,
      providerStatus: daily.providerStatus,
      providerStatusCode: daily.providerStatusCode,
      errorMessage: daily.errorMessage,
      completionConfidence: daily.completionConfidence,
      observationSource: daily.observationSource,
      countryCode: daily.countryCode,
      cityName: daily.cityName,
      language: daily.language,
      checkedAt: daily.checkedAt,
      checkedDate: daily.checkedDate,
      importedAt: daily.importedAt,
    })
    .from(daily)
    .where(sql`daily.rn = 1`)
    .orderBy(desc(sql`daily.obs_date`), desc(daily.checkedAt), desc(daily.id));
}
