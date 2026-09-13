/* eslint-disable max-lines */
import { and, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { gscSearchPerformance, gscSearchPerformanceSyncs } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import {
  isRangeCoveredByIntervals,
  mergeDateIntervals,
  syncRunsToIntervals,
} from "../services/gscSyncUtils";

export type GscSearchPerformanceRow = typeof gscSearchPerformance.$inferSelect;
export type GscSearchPerformanceInsert =
  typeof gscSearchPerformance.$inferInsert;
export type GscSyncRow = typeof gscSearchPerformanceSyncs.$inferSelect;

export async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export interface DeterministicGscFactIdParams {
  projectId: string;
  property: string;
  searchType: string;
  date: string;
  grain: string;
  grainKey: string;
}

export async function deterministicGscFactId(
  params: DeterministicGscFactIdParams,
): Promise<string> {
  return (
    await sha256Hex(
      [
        params.projectId,
        params.property,
        params.searchType,
        params.date,
        params.grain,
        params.grainKey,
      ].join("|"),
    )
  ).slice(0, 36);
}

export type {
  SearchPerformanceTotalsResult,
  SearchPerformanceStrikingRow,
  SearchPerformanceDimensionRowResult,
} from "@/types/schemas/search-performance";
import type {
  SearchPerformanceTotalsResult,
  SearchPerformanceStrikingRow,
  SearchPerformanceDimensionRowResult,
} from "@/types/schemas/search-performance";

async function upsertFacts(facts: GscSearchPerformanceInsert[]): Promise<{
  inserted: number;
}> {
  if (facts.length === 0) return { inserted: 0 };

  await executeInBatches(facts, (tx, fact) =>
    tx
      .insert(gscSearchPerformance)
      .values(fact)
      .onConflictDoUpdate({
        target: gscSearchPerformance.id,
        set: {
          clicks: fact.clicks,
          impressions: fact.impressions,
          ctr: fact.ctr,
          position: fact.position,
          updatedAt: sql`(current_timestamp)`,
        },
      }),
  );

  return { inserted: facts.length };
}

async function getActiveSyncRun(
  projectId: string,
  property?: string,
): Promise<GscSyncRow | null> {
  const conditions = [
    eq(gscSearchPerformanceSyncs.projectId, projectId),
    inArray(gscSearchPerformanceSyncs.status, ["pending", "running"]),
  ];
  if (property) {
    conditions.push(eq(gscSearchPerformanceSyncs.property, property));
  }

  const rows = await db
    .select()
    .from(gscSearchPerformanceSyncs)
    .where(and(...conditions))
    .limit(1);

  return rows[0] ?? null;
}

async function getLatestSyncRun(
  projectId: string,
  property?: string,
): Promise<GscSyncRow | null> {
  const conditions = [eq(gscSearchPerformanceSyncs.projectId, projectId)];
  if (property) {
    conditions.push(eq(gscSearchPerformanceSyncs.property, property));
  }

  const rows = await db
    .select()
    .from(gscSearchPerformanceSyncs)
    .where(and(...conditions))
    .orderBy(desc(gscSearchPerformanceSyncs.startedAt))
    .limit(1);

  return rows[0] ?? null;
}

async function createSyncRun(input: {
  id?: string;
  projectId: string;
  gscConnectionId?: string | null;
  property: string;
  syncType: string;
  requestedStartDate: string;
  requestedEndDate: string;
}): Promise<
  | { ok: true; sync: GscSyncRow }
  | { ok: false; sync: GscSyncRow; alreadyRunning: true }
> {
  const active = await getActiveSyncRun(input.projectId, input.property);
  if (active) {
    return { ok: false, sync: active, alreadyRunning: true };
  }

  const id = input.id ?? crypto.randomUUID();
  try {
    const [row] = await db
      .insert(gscSearchPerformanceSyncs)
      .values({
        id,
        projectId: input.projectId,
        gscConnectionId: input.gscConnectionId ?? null,
        property: input.property,
        syncType: input.syncType,
        requestedStartDate: input.requestedStartDate,
        requestedEndDate: input.requestedEndDate,
        status: "running",
      })
      .returning();

    if (!row) throw new Error("Failed to insert sync run");
    return { ok: true, sync: row };
  } catch (error) {
    // Re-check in case another worker beat us in the race
    const concurrent = await getActiveSyncRun(input.projectId, input.property);
    if (concurrent) {
      return { ok: false, sync: concurrent, alreadyRunning: true };
    }
    throw error;
  }
}

async function updateSyncRun(
  id: string,
  patch: Partial<typeof gscSearchPerformanceSyncs.$inferInsert>,
): Promise<void> {
  await db
    .update(gscSearchPerformanceSyncs)
    .set({
      ...patch,
      updatedAt: sql`(current_timestamp)`,
    })
    .where(eq(gscSearchPerformanceSyncs.id, id));
}

export interface StoredCoverageRange {
  startDate: string;
  endDate: string;
  totalDays: number;
}

async function getStoredCoverageRange(
  projectId: string,
  searchType: string = "web",
): Promise<StoredCoverageRange | null> {
  const [syncRuns, factRows] = await Promise.all([
    db
      .select({
        status: gscSearchPerformanceSyncs.status,
        requestedStartDate: gscSearchPerformanceSyncs.requestedStartDate,
        requestedEndDate: gscSearchPerformanceSyncs.requestedEndDate,
        actualLastSuccessfulDate:
          gscSearchPerformanceSyncs.actualLastSuccessfulDate,
      })
      .from(gscSearchPerformanceSyncs)
      .where(
        and(
          eq(gscSearchPerformanceSyncs.projectId, projectId),
          inArray(gscSearchPerformanceSyncs.status, ["completed", "partial"]),
        ),
      ),
    db
      .select({
        minDate: sql<string | null>`min(${gscSearchPerformance.date})`,
        maxDate: sql<string | null>`max(${gscSearchPerformance.date})`,
        totalDays: sql<number>`count(distinct ${gscSearchPerformance.date})`,
      })
      .from(gscSearchPerformance)
      .where(
        and(
          eq(gscSearchPerformance.projectId, projectId),
          eq(gscSearchPerformance.searchType, searchType),
          eq(gscSearchPerformance.grain, "summary"),
        ),
      ),
  ]);

  const intervals = syncRunsToIntervals(syncRuns);
  const merged = mergeDateIntervals(intervals);

  const syncMin = merged.length > 0 ? merged[0].startDate : null;
  const syncMax = merged.length > 0 ? merged[merged.length - 1].endDate : null;
  const factStats = factRows[0];
  const factMin = factStats?.minDate ?? null;
  const factMax = factStats?.maxDate ?? null;

  const startDate =
    syncMin && factMin
      ? syncMin < factMin
        ? syncMin
        : factMin
      : (syncMin ?? factMin);
  const endDate =
    syncMax && factMax
      ? syncMax > factMax
        ? syncMax
        : factMax
      : (syncMax ?? factMax);

  if (!startDate || !endDate) {
    return null;
  }

  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const spanDays =
    !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs
      ? Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1
      : Number(factStats?.totalDays ?? 0);

  return {
    startDate,
    endDate,
    totalDays: spanDays,
  };
}

async function hasCoverage(
  projectId: string,
  startDate: string,
  endDate: string,
  searchType: string = "web",
): Promise<boolean> {
  // 1. Check sync intervals recorded in gsc_search_performance_syncs
  const syncRuns = await db
    .select({
      status: gscSearchPerformanceSyncs.status,
      requestedStartDate: gscSearchPerformanceSyncs.requestedStartDate,
      requestedEndDate: gscSearchPerformanceSyncs.requestedEndDate,
      actualLastSuccessfulDate:
        gscSearchPerformanceSyncs.actualLastSuccessfulDate,
    })
    .from(gscSearchPerformanceSyncs)
    .where(
      and(
        eq(gscSearchPerformanceSyncs.projectId, projectId),
        inArray(gscSearchPerformanceSyncs.status, ["completed", "partial"]),
      ),
    );

  if (syncRuns.length > 0) {
    const intervals = syncRunsToIntervals(syncRuns);
    const merged = mergeDateIntervals(intervals);
    return isRangeCoveredByIntervals(merged, { startDate, endDate });
  }

  // 2. Conservative fallback for legacy data without sync runs metadata:
  // Facts alone cannot distinguish whether missing dates were zero-row days
  // or never-synchronized missing days. To prevent false-positive continuous
  // coverage claims across gaps, only return true if facts are present for all expected days.
  const rows = await db
    .select({
      minDate: sql<string | null>`min(${gscSearchPerformance.date})`,
      maxDate: sql<string | null>`max(${gscSearchPerformance.date})`,
      count: sql<number>`count(distinct ${gscSearchPerformance.date})`,
    })
    .from(gscSearchPerformance)
    .where(
      and(
        eq(gscSearchPerformance.projectId, projectId),
        eq(gscSearchPerformance.searchType, searchType),
        eq(gscSearchPerformance.grain, "summary"),
        gte(gscSearchPerformance.date, startDate),
        lte(gscSearchPerformance.date, endDate),
      ),
    );

  const stats = rows[0];
  if (!stats || !stats.minDate || !stats.maxDate || Number(stats.count) === 0) {
    return false;
  }

  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  const expectedDays =
    !Number.isNaN(startMs) && !Number.isNaN(endMs) && endMs >= startMs
      ? Math.round((endMs - startMs) / (24 * 60 * 60 * 1000)) + 1
      : 0;

  return (
    stats.minDate <= startDate &&
    stats.maxDate >= endDate &&
    (expectedDays === 0 || Number(stats.count) >= expectedDays)
  );
}

async function getTotals(
  projectId: string,
  startDate: string,
  endDate: string,
  filters?: { device?: string; country?: string },
): Promise<SearchPerformanceTotalsResult> {
  let grain = "summary";
  const conditions = [
    eq(gscSearchPerformance.projectId, projectId),
    gte(gscSearchPerformance.date, startDate),
    lte(gscSearchPerformance.date, endDate),
  ];

  if (filters?.device) {
    grain = "device";
    conditions.push(eq(gscSearchPerformance.device, filters.device));
  } else if (filters?.country) {
    grain = "country";
    conditions.push(eq(gscSearchPerformance.country, filters.country));
  }
  conditions.push(eq(gscSearchPerformance.grain, grain));

  const rows = await db
    .select({
      clicks: sql<number>`coalesce(sum(${gscSearchPerformance.clicks}), 0)`,
      impressions: sql<number>`coalesce(sum(${gscSearchPerformance.impressions}), 0)`,
      weightedPosition: sql<number>`coalesce(sum(${gscSearchPerformance.position} * ${gscSearchPerformance.impressions}), 0)`,
    })
    .from(gscSearchPerformance)
    .where(and(...conditions));

  const result = rows[0] ?? { clicks: 0, impressions: 0, weightedPosition: 0 };
  const clicks = Number(result.clicks);
  const impressions = Number(result.impressions);
  const weightedPosition = Number(result.weightedPosition);

  return {
    clicks,
    impressions,
    ctr: impressions > 0 ? clicks / impressions : 0,
    position: impressions > 0 ? weightedPosition / impressions : 0,
  };
}

async function getStrikingDistance(
  projectId: string,
  startDate: string,
  endDate: string,
  limit: number = 100,
): Promise<SearchPerformanceStrikingRow[]> {
  const rows = await db
    .select({
      query: sql<string>`${gscSearchPerformance.query}`,
      page: sql<string>`${gscSearchPerformance.page}`,
      clicks: sql<number>`coalesce(sum(${gscSearchPerformance.clicks}), 0)`,
      impressions: sql<number>`coalesce(sum(${gscSearchPerformance.impressions}), 0)`,
      weightedPosition: sql<number>`coalesce(sum(${gscSearchPerformance.position} * ${gscSearchPerformance.impressions}), 0)`,
    })
    .from(gscSearchPerformance)
    .where(
      and(
        eq(gscSearchPerformance.projectId, projectId),
        eq(gscSearchPerformance.grain, "query_page"),
        gte(gscSearchPerformance.date, startDate),
        lte(gscSearchPerformance.date, endDate),
      ),
    )
    .groupBy(gscSearchPerformance.query, gscSearchPerformance.page);

  // Collapse by query to best position
  const topPageByQuery = new Map<string, SearchPerformanceStrikingRow>();
  for (const row of rows) {
    if (!row.query || !row.page) continue;
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const weightedPosition = Number(row.weightedPosition);
    const position = impressions > 0 ? weightedPosition / impressions : 0;

    const current = topPageByQuery.get(row.query);
    const isBetter =
      !current ||
      position < current.position ||
      (position === current.position && impressions > current.impressions);

    if (isBetter) {
      topPageByQuery.set(row.query, {
        query: row.query,
        page: row.page,
        clicks,
        impressions,
        position,
      });
    }
  }

  // Filter 5..20 and sort by impressions descending
  return Array.from(topPageByQuery.values())
    .filter((row) => row.position >= 5 && row.position <= 20)
    .toSorted((a, b) => b.impressions - a.impressions)
    .slice(0, limit);
}

export interface GetTableRowsParams {
  projectId: string;
  dimension: "query" | "page";
  startDate: string;
  endDate: string;
  page: number;
  pageSize: number;
}

async function getTableRows({
  projectId,
  dimension,
  startDate,
  endDate,
  page,
  pageSize,
}: GetTableRowsParams): Promise<{
  rows: SearchPerformanceDimensionRowResult[];
  hasNextPage: boolean;
}> {
  const column =
    dimension === "page"
      ? gscSearchPerformance.page
      : gscSearchPerformance.query;

  const offset = (page - 1) * pageSize;
  const limit = pageSize + 1; // +1 to detect next page

  const rows = await db
    .select({
      key: sql<string>`${column}`,
      clicks: sql<number>`coalesce(sum(${gscSearchPerformance.clicks}), 0)`,
      impressions: sql<number>`coalesce(sum(${gscSearchPerformance.impressions}), 0)`,
      weightedPosition: sql<number>`coalesce(sum(${gscSearchPerformance.position} * ${gscSearchPerformance.impressions}), 0)`,
    })
    .from(gscSearchPerformance)
    .where(
      and(
        eq(gscSearchPerformance.projectId, projectId),
        eq(gscSearchPerformance.grain, dimension),
        gte(gscSearchPerformance.date, startDate),
        lte(gscSearchPerformance.date, endDate),
      ),
    )
    .groupBy(column)
    .orderBy(
      desc(sql`sum(${gscSearchPerformance.clicks})`),
      desc(sql`sum(${gscSearchPerformance.impressions})`),
    )
    .limit(limit)
    .offset(offset);

  const hasNextPage = rows.length > pageSize;
  const sliced = hasNextPage ? rows.slice(0, pageSize) : rows;

  const results: SearchPerformanceDimensionRowResult[] = sliced.map((row) => {
    const clicks = Number(row.clicks);
    const impressions = Number(row.impressions);
    const weightedPosition = Number(row.weightedPosition);
    return {
      key: row.key ?? "",
      clicks,
      impressions,
      ctr: impressions > 0 ? clicks / impressions : 0,
      position: impressions > 0 ? weightedPosition / impressions : 0,
    };
  });

  return { rows: results, hasNextPage };
}

async function getCountries(
  projectId: string,
  startDate: string,
  endDate: string,
  limit: number = 25,
): Promise<SearchPerformanceDimensionRowResult[]> {
  const rows = await db
    .select({
      country: sql<string>`${gscSearchPerformance.country}`,
      clicks: sql<number>`coalesce(sum(${gscSearchPerformance.clicks}), 0)`,
      impressions: sql<number>`coalesce(sum(${gscSearchPerformance.impressions}), 0)`,
      weightedPosition: sql<number>`coalesce(sum(${gscSearchPerformance.position} * ${gscSearchPerformance.impressions}), 0)`,
    })
    .from(gscSearchPerformance)
    .where(
      and(
        eq(gscSearchPerformance.projectId, projectId),
        eq(gscSearchPerformance.grain, "country"),
        gte(gscSearchPerformance.date, startDate),
        lte(gscSearchPerformance.date, endDate),
      ),
    )
    .groupBy(gscSearchPerformance.country)
    .orderBy(desc(sql`sum(${gscSearchPerformance.impressions})`))
    .limit(limit);

  return rows
    .filter((r) => Boolean(r.country))
    .map((row) => {
      const clicks = Number(row.clicks);
      const impressions = Number(row.impressions);
      const weightedPosition = Number(row.weightedPosition);
      return {
        key: row.country ?? "",
        clicks,
        impressions,
        ctr: impressions > 0 ? clicks / impressions : 0,
        position: impressions > 0 ? weightedPosition / impressions : 0,
      };
    });
}

export const GscSearchPerformanceRepository = {
  upsertFacts,
  getActiveSyncRun,
  getLatestSyncRun,
  createSyncRun,
  updateSyncRun,
  hasCoverage,
  getStoredCoverageRange,
  getTotals,
  getStrikingDistance,
  getTableRows,
  getCountries,
};
