/* eslint-disable max-lines */
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lte,
  sql,
} from "drizzle-orm";
import { db } from "@/db";
import {
  ga4DailyAcquisition,
  ga4DailyEvents,
  ga4DailyLandingPages,
  ga4DailySummary,
  ga4SyncCoverage,
  ga4Syncs,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import {
  isGa4SyncGrain,
  isSuccessCoverageStatus,
  type Ga4CoverageStatus,
  type Ga4SyncGrain,
  type Ga4TruncationMeta,
} from "../services/ga4SyncUtils";

export type Ga4SyncRow = typeof ga4Syncs.$inferSelect;
export type Ga4SummaryInsert = typeof ga4DailySummary.$inferInsert;
export type Ga4AcquisitionInsert = typeof ga4DailyAcquisition.$inferInsert;
export type Ga4LandingInsert = typeof ga4DailyLandingPages.$inferInsert;
export type Ga4EventInsert = typeof ga4DailyEvents.$inferInsert;

export class Ga4AggregationError extends Error {}

export const NEW_USERS_FOOTNOTE =
  "new_users summed across non-overlapping daily summary rows (new on each day); dimensioned values are dimension-level only.";

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

export async function deterministicGa4FactId(params: {
  projectId: string;
  propertyId: string;
  date: string;
  grain: string;
  grainKey: string;
}): Promise<string> {
  return (
    await sha256Hex(
      [
        params.projectId,
        params.propertyId,
        params.date,
        params.grain,
        params.grainKey,
      ].join("|"),
    )
  ).slice(0, 36);
}

async function getActiveSyncRun(
  projectId: string,
  propertyId: string,
): Promise<Ga4SyncRow | null> {
  const rows = await db
    .select()
    .from(ga4Syncs)
    .where(
      and(
        eq(ga4Syncs.projectId, projectId),
        eq(ga4Syncs.propertyId, propertyId),
        inArray(ga4Syncs.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestSyncRun(
  projectId: string,
  propertyId: string,
): Promise<Ga4SyncRow | null> {
  const rows = await db
    .select()
    .from(ga4Syncs)
    .where(
      and(
        eq(ga4Syncs.projectId, projectId),
        eq(ga4Syncs.propertyId, propertyId),
      ),
    )
    .orderBy(desc(ga4Syncs.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** §7 version-token selector: latest finalized run with successful_units > 0.
 *  Running rows (null completedAt) never qualify, so a crash cannot advance
 *  the token. */
async function getLatestSuccessfulRun(
  projectId: string,
  propertyId: string,
): Promise<Ga4SyncRow | null> {
  const rows = await db
    .select()
    .from(ga4Syncs)
    .where(
      and(
        eq(ga4Syncs.projectId, projectId),
        eq(ga4Syncs.propertyId, propertyId),
        isNotNull(ga4Syncs.completedAt),
      ),
    )
    .orderBy(desc(ga4Syncs.completedAt))
    .limit(25);
  return rows.find((row) => (row.successfulUnits ?? 0) > 0) ?? null;
}

async function createSyncRun(input: {
  id?: string;
  projectId: string;
  ga4ConnectionId?: string | null;
  propertyId: string;
  syncType: string;
  requestedStartDate: string;
  requestedEndDate: string;
}): Promise<
  | { ok: true; sync: Ga4SyncRow }
  | { ok: false; sync: Ga4SyncRow; alreadyRunning: true }
> {
  const active = await getActiveSyncRun(input.projectId, input.propertyId);
  if (active) {
    return { ok: false, sync: active, alreadyRunning: true };
  }

  const id = input.id ?? crypto.randomUUID();
  const nowIso = new Date().toISOString();
  try {
    const [row] = await db
      .insert(ga4Syncs)
      .values({
        id,
        projectId: input.projectId,
        ga4ConnectionId: input.ga4ConnectionId ?? null,
        propertyId: input.propertyId,
        syncType: input.syncType,
        requestedStartDate: input.requestedStartDate,
        requestedEndDate: input.requestedEndDate,
        status: "running",
        // Explicit ISO-8601 like updatedAt: startedAt orders runs and gates
        // the 6h cron floor, both of which compare lexicographically.
        startedAt: nowIso,
        // Written explicitly as ISO-8601: SQLite's current_timestamp uses a
        // space separator which does NOT compare correctly against ISO
        // strings, and updatedAt is compared lexicographically for
        // stale-run recovery.
        updatedAt: nowIso,
      })
      .returning();
    if (!row) throw new Error("Failed to insert ga4 sync run");
    return { ok: true, sync: row };
  } catch (error) {
    // Re-check in case another worker beat us in the race.
    const concurrent = await getActiveSyncRun(
      input.projectId,
      input.propertyId,
    );
    if (concurrent) {
      return { ok: false, sync: concurrent, alreadyRunning: true };
    }
    throw error;
  }
}

async function updateSyncRun(
  id: string,
  patch: Partial<typeof ga4Syncs.$inferInsert>,
): Promise<void> {
  await db
    .update(ga4Syncs)
    // Explicit ISO-8601 (see createSyncRun): updatedAt is compared
    // lexicographically for stale-run recovery on both dialects.
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(ga4Syncs.id, id));
}

/** Crash recovery: runs stuck pending/running since before `staleBeforeIso`
 *  are finalized as failed so a new run can proceed. Returns the count. */
async function markStaleRunsFailed(
  projectId: string,
  propertyId: string,
  staleBeforeIso: string,
): Promise<number> {
  const stale = await db
    .select({ id: ga4Syncs.id })
    .from(ga4Syncs)
    .where(
      and(
        eq(ga4Syncs.projectId, projectId),
        eq(ga4Syncs.propertyId, propertyId),
        inArray(ga4Syncs.status, ["pending", "running"]),
        lte(ga4Syncs.updatedAt, staleBeforeIso),
      ),
    );
  for (const row of stale) {
    await updateSyncRun(row.id, {
      status: "failed",
      completedAt: new Date().toISOString(),
      error: "STALE_RUN: sync run stopped making progress and was recovered.",
      errorClass: "STALE_RUN",
    });
  }
  return stale.length;
}

/** Seed PENDING units for every date×grain in range. Existing SUCCESS rows
 *  are preserved unless `force` (manual explicit-window reprocessing);
 *  FAILED/PENDING rows are reset to PENDING for retry. */
async function seedPendingUnits(input: {
  projectId: string;
  propertyId: string;
  dates: string[];
  grains: Ga4SyncGrain[];
  force?: boolean;
}): Promise<void> {
  const units = input.dates.flatMap((date) =>
    input.grains.map((grain) => ({ date, grain })),
  );
  if (units.length === 0) return;
  await executeInBatches(units, (tx, unit) =>
    tx
      .insert(ga4SyncCoverage)
      .values({
        id: crypto.randomUUID(),
        projectId: input.projectId,
        propertyId: input.propertyId,
        date: unit.date,
        grain: unit.grain,
        status: "pending",
      })
      .onConflictDoNothing({
        target: [
          ga4SyncCoverage.projectId,
          ga4SyncCoverage.propertyId,
          ga4SyncCoverage.date,
          ga4SyncCoverage.grain,
        ],
      }),
  );
  // Reset retryable units. SUCCESS rows survive a normal seed; a forced
  // (manual explicit-window) seed resets everything to PENDING.
  const resettable: Ga4CoverageStatus[] = input.force
    ? ["PENDING", "SUCCESS_WITH_DATA", "SUCCESS_ZERO_ROWS", "FAILED"]
    : ["PENDING", "FAILED"];
  await db
    .update(ga4SyncCoverage)
    .set({ status: "pending", updatedAt: sql`(current_timestamp)` })
    .where(
      and(
        eq(ga4SyncCoverage.projectId, input.projectId),
        eq(ga4SyncCoverage.propertyId, input.propertyId),
        inArray(ga4SyncCoverage.date, input.dates),
        inArray(ga4SyncCoverage.grain, [...input.grains]),
        inArray(
          ga4SyncCoverage.status,
          resettable.map((s) => s.toLowerCase()),
        ),
      ),
    );
}

async function markUnits(
  units: Array<{
    projectId: string;
    propertyId: string;
    date: string;
    grain: Ga4SyncGrain;
    status: Ga4CoverageStatus;
    truncationMeta?: Ga4TruncationMeta | null;
  }>,
): Promise<void> {
  await executeInBatches(units, (tx, unit) =>
    tx
      .update(ga4SyncCoverage)
      .set({
        status: unit.status.toLowerCase(),
        truncationMeta:
          unit.truncationMeta === undefined
            ? undefined
            : JSON.stringify(unit.truncationMeta),
        updatedAt: sql`(current_timestamp)`,
      })
      .where(
        and(
          eq(ga4SyncCoverage.projectId, unit.projectId),
          eq(ga4SyncCoverage.propertyId, unit.propertyId),
          eq(ga4SyncCoverage.date, unit.date),
          eq(ga4SyncCoverage.grain, unit.grain),
        ),
      ),
  );
}

async function getCoverageMap(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<Map<string, Map<Ga4SyncGrain, Ga4CoverageStatus>>> {
  const rows = await db
    .select({
      date: ga4SyncCoverage.date,
      grain: ga4SyncCoverage.grain,
      status: ga4SyncCoverage.status,
    })
    .from(ga4SyncCoverage)
    .where(
      and(
        eq(ga4SyncCoverage.projectId, projectId),
        eq(ga4SyncCoverage.propertyId, propertyId),
        gte(ga4SyncCoverage.date, from),
        lte(ga4SyncCoverage.date, to),
      ),
    );
  const map = new Map<string, Map<Ga4SyncGrain, Ga4CoverageStatus>>();
  for (const row of rows) {
    if (!isGa4SyncGrain(row.grain)) continue;
    const upper = row.status.toUpperCase();
    const status: Ga4CoverageStatus =
      upper === "SUCCESS_WITH_DATA" ||
      upper === "SUCCESS_ZERO_ROWS" ||
      upper === "FAILED" ||
      upper === "PENDING"
        ? upper
        : "FAILED";
    let day = map.get(row.date);
    if (!day) {
      day = new Map();
      map.set(row.date, day);
    }
    day.set(row.grain, status);
  }
  return map;
}

/** Max date ≤ throughDate with every grain SUCCESS_*, else null. */
async function getLastFullyCoveredDate(
  projectId: string,
  propertyId: string,
  grains: Ga4SyncGrain[],
  throughDate: string,
): Promise<string | null> {
  const map = await getCoverageMap(
    projectId,
    propertyId,
    "0000-01-01",
    throughDate,
  );
  let best: string | null = null;
  for (const [date, states] of map) {
    if (date > throughDate) continue;
    const covered = grains.every((grain) =>
      isSuccessCoverageStatus(states.get(grain) ?? ""),
    );
    if (covered && (best === null || date > best)) best = date;
  }
  return best;
}

async function upsertSummaryRows(rows: Ga4SummaryInsert[]): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(ga4DailySummary)
      .values(row)
      .onConflictDoUpdate({
        target: ga4DailySummary.id,
        set: {
          sessions: row.sessions,
          engagedSessions: row.engagedSessions,
          userEngagementDuration: row.userEngagementDuration,
          screenPageViews: row.screenPageViews,
          eventCount: row.eventCount,
          newUsers: row.newUsers,
          totalUsers: row.totalUsers,
          activeUsers: row.activeUsers,
          totalRevenue: row.totalRevenue,
          purchaseRevenue: row.purchaseRevenue,
          transactions: row.transactions,
          addToCarts: row.addToCarts,
          checkouts: row.checkouts,
          updatedAt: sql`(current_timestamp)`,
        },
      }),
  );
}

async function upsertAcquisitionRows(
  rows: Ga4AcquisitionInsert[],
): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(ga4DailyAcquisition)
      .values(row)
      .onConflictDoUpdate({
        target: ga4DailyAcquisition.id,
        set: {
          channelGroup: row.channelGroup,
          source: row.source,
          medium: row.medium,
          rawChannelGroup: row.rawChannelGroup,
          rawSource: row.rawSource,
          rawMedium: row.rawMedium,
          sessions: row.sessions,
          engagedSessions: row.engagedSessions,
          userEngagementDuration: row.userEngagementDuration,
          screenPageViews: row.screenPageViews,
          eventCount: row.eventCount,
          newUsers: row.newUsers,
          updatedAt: sql`(current_timestamp)`,
        },
      }),
  );
}

async function upsertLandingRows(rows: Ga4LandingInsert[]): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(ga4DailyLandingPages)
      .values(row)
      .onConflictDoUpdate({
        target: ga4DailyLandingPages.id,
        set: {
          landingPage: row.landingPage,
          rawLandingPage: row.rawLandingPage,
          sessions: row.sessions,
          engagedSessions: row.engagedSessions,
          userEngagementDuration: row.userEngagementDuration,
          screenPageViews: row.screenPageViews,
          updatedAt: sql`(current_timestamp)`,
        },
      }),
  );
}

async function upsertEventRows(rows: Ga4EventInsert[]): Promise<void> {
  await executeInBatches(rows, (tx, row) =>
    tx
      .insert(ga4DailyEvents)
      .values(row)
      .onConflictDoUpdate({
        target: ga4DailyEvents.id,
        set: {
          eventName: row.eventName,
          eventCount: row.eventCount,
          isKeyEvent: row.isKeyEvent,
          updatedAt: sql`(current_timestamp)`,
        },
      }),
  );
}

export type Ga4SummaryTotals = {
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
  newUsers: number;
  totalRevenue: number;
  purchaseRevenue: number;
  transactions: number;
  addToCarts: number;
  checkouts: number;
  currencyCode: string | null;
  newUsersFootnote: string;
};

/** Project-wide totals over the summary grain, restricted to
 *  SUCCESS_*-covered dates. Sums new_users (valid: non-overlapping daily
 *  summary rows, footnote attached). Never sums total_users/active_users —
 *  those keys are absent by design; exact period values come from
 *  getPeriodUsers. */
async function getSummaryTotals(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
  currencyCode: string | null,
): Promise<Ga4SummaryTotals> {
  const coveredDates = db
    .select({ date: ga4SyncCoverage.date })
    .from(ga4SyncCoverage)
    .where(
      and(
        eq(ga4SyncCoverage.projectId, projectId),
        eq(ga4SyncCoverage.propertyId, propertyId),
        eq(ga4SyncCoverage.grain, "summary"),
        inArray(ga4SyncCoverage.status, [
          "success_with_data",
          "success_zero_rows",
        ]),
        gte(ga4SyncCoverage.date, from),
        lte(ga4SyncCoverage.date, to),
      ),
    );
  const [totals] = await db
    .select({
      sessions: sql<number | null>`sum(${ga4DailySummary.sessions})`,
      engagedSessions: sql<
        number | null
      >`sum(${ga4DailySummary.engagedSessions})`,
      userEngagementDuration: sql<
        number | null
      >`sum(${ga4DailySummary.userEngagementDuration})`,
      screenPageViews: sql<
        number | null
      >`sum(${ga4DailySummary.screenPageViews})`,
      eventCount: sql<number | null>`sum(${ga4DailySummary.eventCount})`,
      newUsers: sql<number | null>`sum(${ga4DailySummary.newUsers})`,
      totalRevenue: sql<number | null>`sum(${ga4DailySummary.totalRevenue})`,
      purchaseRevenue: sql<
        number | null
      >`sum(${ga4DailySummary.purchaseRevenue})`,
      transactions: sql<number | null>`sum(${ga4DailySummary.transactions})`,
      addToCarts: sql<number | null>`sum(${ga4DailySummary.addToCarts})`,
      checkouts: sql<number | null>`sum(${ga4DailySummary.checkouts})`,
    })
    .from(ga4DailySummary)
    .where(
      and(
        eq(ga4DailySummary.projectId, projectId),
        eq(ga4DailySummary.propertyId, propertyId),
        gte(ga4DailySummary.date, from),
        lte(ga4DailySummary.date, to),
        inArray(ga4DailySummary.date, coveredDates),
      ),
    );
  return {
    sessions: totals?.sessions ?? 0,
    engagedSessions: totals?.engagedSessions ?? 0,
    userEngagementDuration: totals?.userEngagementDuration ?? 0,
    screenPageViews: totals?.screenPageViews ?? 0,
    eventCount: totals?.eventCount ?? 0,
    newUsers: totals?.newUsers ?? 0,
    totalRevenue: totals?.totalRevenue ?? 0,
    purchaseRevenue: totals?.purchaseRevenue ?? 0,
    transactions: totals?.transactions ?? 0,
    addToCarts: totals?.addToCarts ?? 0,
    checkouts: totals?.checkouts ?? 0,
    currencyCode,
    newUsersFootnote: NEW_USERS_FOOTNOTE,
  };
}

type Ga4EntityTable = "acquisition" | "landing_pages" | "events";

/** Date-range sums within ONE entity (valid per §9.4: non-overlapping daily
 *  rows for a single dimension value). Throws Ga4AggregationError when the
 *  entity key is incomplete — that would collapse dimensions into a project
 *  rollup, which is refused for distinct metrics. */
async function getEntityTotals(input: {
  projectId: string;
  propertyId: string;
  table: Ga4EntityTable;
  entity: Record<string, string | undefined>;
  from: string;
  to: string;
}): Promise<Record<string, number>> {
  const { projectId, propertyId, table, entity, from, to } = input;
  if (table === "acquisition") {
    const { channelGroup, source, medium } = entity;
    if (!channelGroup || !source || !medium) {
      throw new Ga4AggregationError(
        "Acquisition totals require a complete channel/source/medium entity; project-wide rollups are refused.",
      );
    }
    const [totals] = await db
      .select({
        sessions: sql<number | null>`sum(${ga4DailyAcquisition.sessions})`,
        engagedSessions: sql<
          number | null
        >`sum(${ga4DailyAcquisition.engagedSessions})`,
        userEngagementDuration: sql<
          number | null
        >`sum(${ga4DailyAcquisition.userEngagementDuration})`,
        screenPageViews: sql<
          number | null
        >`sum(${ga4DailyAcquisition.screenPageViews})`,
        eventCount: sql<number | null>`sum(${ga4DailyAcquisition.eventCount})`,
        newUsers: sql<number | null>`sum(${ga4DailyAcquisition.newUsers})`,
      })
      .from(ga4DailyAcquisition)
      .where(
        and(
          eq(ga4DailyAcquisition.projectId, projectId),
          eq(ga4DailyAcquisition.propertyId, propertyId),
          eq(ga4DailyAcquisition.channelGroup, channelGroup),
          eq(ga4DailyAcquisition.source, source),
          eq(ga4DailyAcquisition.medium, medium),
          gte(ga4DailyAcquisition.date, from),
          lte(ga4DailyAcquisition.date, to),
        ),
      );
    return {
      sessions: totals?.sessions ?? 0,
      engagedSessions: totals?.engagedSessions ?? 0,
      userEngagementDuration: totals?.userEngagementDuration ?? 0,
      screenPageViews: totals?.screenPageViews ?? 0,
      eventCount: totals?.eventCount ?? 0,
      newUsers: totals?.newUsers ?? 0,
    };
  }
  if (table === "landing_pages") {
    const { landingPage } = entity;
    if (!landingPage) {
      throw new Ga4AggregationError(
        "Landing-page totals require a landingPage entity; project-wide rollups are refused.",
      );
    }
    const [totals] = await db
      .select({
        sessions: sql<number | null>`sum(${ga4DailyLandingPages.sessions})`,
        engagedSessions: sql<
          number | null
        >`sum(${ga4DailyLandingPages.engagedSessions})`,
        userEngagementDuration: sql<
          number | null
        >`sum(${ga4DailyLandingPages.userEngagementDuration})`,
        screenPageViews: sql<
          number | null
        >`sum(${ga4DailyLandingPages.screenPageViews})`,
      })
      .from(ga4DailyLandingPages)
      .where(
        and(
          eq(ga4DailyLandingPages.projectId, projectId),
          eq(ga4DailyLandingPages.propertyId, propertyId),
          eq(ga4DailyLandingPages.landingPage, landingPage),
          gte(ga4DailyLandingPages.date, from),
          lte(ga4DailyLandingPages.date, to),
        ),
      );
    return {
      sessions: totals?.sessions ?? 0,
      engagedSessions: totals?.engagedSessions ?? 0,
      userEngagementDuration: totals?.userEngagementDuration ?? 0,
      screenPageViews: totals?.screenPageViews ?? 0,
    };
  }
  const { eventName } = entity;
  if (!eventName) {
    throw new Ga4AggregationError(
      "Event totals require an eventName entity; project-wide rollups are refused.",
    );
  }
  const [totals] = await db
    .select({
      eventCount: sql<number | null>`sum(${ga4DailyEvents.eventCount})`,
    })
    .from(ga4DailyEvents)
    .where(
      and(
        eq(ga4DailyEvents.projectId, projectId),
        eq(ga4DailyEvents.propertyId, propertyId),
        eq(ga4DailyEvents.eventName, eventName),
        gte(ga4DailyEvents.date, from),
        lte(ga4DailyEvents.date, to),
      ),
    );
  return { eventCount: totals?.eventCount ?? 0 };
}

const SUCCESS_COVERAGE_STATUSES = [
  "success_with_data",
  "success_zero_rows",
] as const;

/** Dates with SUCCESS_* coverage for one grain in [from, to]. Every analytics
 *  reader gates on this: FAILED-coverage dates are excluded (failure is never
 *  rendered as zero), SUCCESS_ZERO_ROWS dates contribute zero stored facts. */
function coveredDatesQuery(
  projectId: string,
  propertyId: string,
  grain: string,
  from: string,
  to: string,
) {
  return db
    .select({ date: ga4SyncCoverage.date })
    .from(ga4SyncCoverage)
    .where(
      and(
        eq(ga4SyncCoverage.projectId, projectId),
        eq(ga4SyncCoverage.propertyId, propertyId),
        eq(ga4SyncCoverage.grain, grain),
        inArray(ga4SyncCoverage.status, [...SUCCESS_COVERAGE_STATUSES]),
        gte(ga4SyncCoverage.date, from),
        lte(ga4SyncCoverage.date, to),
      ),
    );
}

export type Ga4DailySeriesPoint = {
  date: string;
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
  newUsers: number;
};

/** Coverage-gated daily summary series for trend charts (selected range).
 *  Only dates with SUCCESS_* summary coverage appear; no totalUsers /
 *  activeUsers keys (distinct metrics are never summed or averaged). */
async function getDailySummarySeries(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
): Promise<Ga4DailySeriesPoint[]> {
  const rows = await db
    .select({
      date: ga4DailySummary.date,
      sessions: ga4DailySummary.sessions,
      engagedSessions: ga4DailySummary.engagedSessions,
      userEngagementDuration: ga4DailySummary.userEngagementDuration,
      screenPageViews: ga4DailySummary.screenPageViews,
      eventCount: ga4DailySummary.eventCount,
      newUsers: ga4DailySummary.newUsers,
    })
    .from(ga4DailySummary)
    .where(
      and(
        eq(ga4DailySummary.projectId, projectId),
        eq(ga4DailySummary.propertyId, propertyId),
        gte(ga4DailySummary.date, from),
        lte(ga4DailySummary.date, to),
        inArray(
          ga4DailySummary.date,
          coveredDatesQuery(projectId, propertyId, "summary", from, to),
        ),
      ),
    )
    .orderBy(asc(ga4DailySummary.date));
  return rows.map((row) => ({
    date: row.date,
    sessions: row.sessions ?? 0,
    engagedSessions: row.engagedSessions ?? 0,
    userEngagementDuration: row.userEngagementDuration ?? 0,
    screenPageViews: row.screenPageViews ?? 0,
    eventCount: row.eventCount ?? 0,
    newUsers: row.newUsers ?? 0,
  }));
}

export type Ga4AcquisitionGroup = {
  channelGroup: string;
  source: string;
  medium: string;
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
  eventCount: number;
};

/** Acquisition rows grouped by channel/source/medium over SUCCESS_*-covered
 *  acquisition dates, ordered by sessions desc. Per-entity date-range sums
 *  (valid per §9.4); no project-wide rollup, no newUsers (summary-grain
 *  only per the analytics contract). */
async function getAcquisitionGroups(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
  filter: { channelGroup?: string },
): Promise<Ga4AcquisitionGroup[]> {
  const sessionsSum = sql<number | null>`sum(${ga4DailyAcquisition.sessions})`;
  const rows = await db
    .select({
      channelGroup: ga4DailyAcquisition.channelGroup,
      source: ga4DailyAcquisition.source,
      medium: ga4DailyAcquisition.medium,
      sessions: sessionsSum,
      engagedSessions: sql<
        number | null
      >`sum(${ga4DailyAcquisition.engagedSessions})`,
      userEngagementDuration: sql<
        number | null
      >`sum(${ga4DailyAcquisition.userEngagementDuration})`,
      screenPageViews: sql<
        number | null
      >`sum(${ga4DailyAcquisition.screenPageViews})`,
      eventCount: sql<number | null>`sum(${ga4DailyAcquisition.eventCount})`,
    })
    .from(ga4DailyAcquisition)
    .where(
      and(
        eq(ga4DailyAcquisition.projectId, projectId),
        eq(ga4DailyAcquisition.propertyId, propertyId),
        gte(ga4DailyAcquisition.date, from),
        lte(ga4DailyAcquisition.date, to),
        ...(filter.channelGroup
          ? [eq(ga4DailyAcquisition.channelGroup, filter.channelGroup)]
          : []),
        inArray(
          ga4DailyAcquisition.date,
          coveredDatesQuery(projectId, propertyId, "acquisition", from, to),
        ),
      ),
    )
    .groupBy(
      ga4DailyAcquisition.channelGroup,
      ga4DailyAcquisition.source,
      ga4DailyAcquisition.medium,
    )
    .orderBy(desc(sessionsSum));
  return rows.map((row) => ({
    channelGroup: row.channelGroup,
    source: row.source,
    medium: row.medium,
    sessions: row.sessions ?? 0,
    engagedSessions: row.engagedSessions ?? 0,
    userEngagementDuration: row.userEngagementDuration ?? 0,
    screenPageViews: row.screenPageViews ?? 0,
    eventCount: row.eventCount ?? 0,
  }));
}

export type Ga4LandingGroup = {
  landingPage: string;
  sessions: number;
  engagedSessions: number;
  userEngagementDuration: number;
  screenPageViews: number;
};

/** Landing rows grouped by page over SUCCESS_*-covered landing dates,
 *  ordered by sessions desc with a caller-supplied top-N bound. */
async function getLandingGroups(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
  filter: { limit: number },
): Promise<Ga4LandingGroup[]> {
  const sessionsSum = sql<number | null>`sum(${ga4DailyLandingPages.sessions})`;
  const rows = await db
    .select({
      landingPage: ga4DailyLandingPages.landingPage,
      sessions: sessionsSum,
      engagedSessions: sql<
        number | null
      >`sum(${ga4DailyLandingPages.engagedSessions})`,
      userEngagementDuration: sql<
        number | null
      >`sum(${ga4DailyLandingPages.userEngagementDuration})`,
      screenPageViews: sql<
        number | null
      >`sum(${ga4DailyLandingPages.screenPageViews})`,
    })
    .from(ga4DailyLandingPages)
    .where(
      and(
        eq(ga4DailyLandingPages.projectId, projectId),
        eq(ga4DailyLandingPages.propertyId, propertyId),
        gte(ga4DailyLandingPages.date, from),
        lte(ga4DailyLandingPages.date, to),
        inArray(
          ga4DailyLandingPages.date,
          coveredDatesQuery(projectId, propertyId, "landing_pages", from, to),
        ),
      ),
    )
    .groupBy(ga4DailyLandingPages.landingPage)
    .orderBy(desc(sessionsSum))
    .limit(filter.limit);
  return rows.map((row) => ({
    landingPage: row.landingPage,
    sessions: row.sessions ?? 0,
    engagedSessions: row.engagedSessions ?? 0,
    userEngagementDuration: row.userEngagementDuration ?? 0,
    screenPageViews: row.screenPageViews ?? 0,
  }));
}

export type Ga4EventGroup = {
  eventName: string;
  eventCount: number;
  isKeyEvent: boolean;
};

/** Event rows grouped by name over SUCCESS_*-covered event dates, ordered
 *  by eventCount desc with a caller-supplied top-N bound. `keyEventsOnly`
 *  serves the read-only conversions list (goal selection deferred per §22).
 *  `isKeyEvent` aggregates via max for SQLite/PG boolean parity. */
async function getEventGroups(
  projectId: string,
  propertyId: string,
  from: string,
  to: string,
  filter: { limit: number; keyEventsOnly?: boolean },
): Promise<Ga4EventGroup[]> {
  const eventCountSum = sql<number | null>`sum(${ga4DailyEvents.eventCount})`;
  // max(case...) keeps SQLite/PG parity: PG max(boolean) returns boolean
  // while SQLite booleans are integers, so normalize to 0/1 in SQL.
  const keyEventFlag = sql<
    number | null
  >`max(case when ${ga4DailyEvents.isKeyEvent} then 1 else 0 end)`;
  const rows = await db
    .select({
      eventName: ga4DailyEvents.eventName,
      eventCount: eventCountSum,
      isKeyEvent: keyEventFlag,
    })
    .from(ga4DailyEvents)
    .where(
      and(
        eq(ga4DailyEvents.projectId, projectId),
        eq(ga4DailyEvents.propertyId, propertyId),
        gte(ga4DailyEvents.date, from),
        lte(ga4DailyEvents.date, to),
        ...(filter.keyEventsOnly ? [eq(ga4DailyEvents.isKeyEvent, true)] : []),
        inArray(
          ga4DailyEvents.date,
          coveredDatesQuery(projectId, propertyId, "events", from, to),
        ),
      ),
    )
    .groupBy(ga4DailyEvents.eventName)
    .orderBy(desc(eventCountSum))
    .limit(filter.limit);
  return rows.map((row) => ({
    eventName: row.eventName,
    eventCount: row.eventCount ?? 0,
    isKeyEvent: (row.isKeyEvent ?? 0) === 1,
  }));
}

export type Ga4GrainCoverage = {
  coveredDates: string[];
  coveredThrough: string | null;
};

/** SUCCESS_*-covered dates for one grain in [from, to] plus the latest such
 *  date (null when nothing is covered). Drives partial badges. */
async function getGrainCoverage(
  projectId: string,
  propertyId: string,
  grain: Ga4SyncGrain,
  from: string,
  to: string,
): Promise<Ga4GrainCoverage> {
  const rows = await db
    .select({ date: ga4SyncCoverage.date })
    .from(ga4SyncCoverage)
    .where(
      and(
        eq(ga4SyncCoverage.projectId, projectId),
        eq(ga4SyncCoverage.propertyId, propertyId),
        eq(ga4SyncCoverage.grain, grain),
        inArray(ga4SyncCoverage.status, [...SUCCESS_COVERAGE_STATUSES]),
        gte(ga4SyncCoverage.date, from),
        lte(ga4SyncCoverage.date, to),
      ),
    )
    .orderBy(asc(ga4SyncCoverage.date));
  const coveredDates = rows.map((row) => row.date);
  return {
    coveredDates,
    coveredThrough: coveredDates[coveredDates.length - 1] ?? null,
  };
}

export const Ga4SyncRepository = {
  getActiveSyncRun,
  getLatestSyncRun,
  getLatestSuccessfulRun,
  createSyncRun,
  updateSyncRun,
  markStaleRunsFailed,
  seedPendingUnits,
  markUnits,
  getCoverageMap,
  getLastFullyCoveredDate,
  upsertSummaryRows,
  upsertAcquisitionRows,
  upsertLandingRows,
  upsertEventRows,
  getSummaryTotals,
  getEntityTotals,
  getDailySummarySeries,
  getAcquisitionGroups,
  getLandingGroups,
  getEventGroups,
  getGrainCoverage,
};
