import { and, desc, eq, inArray, lte } from "drizzle-orm";
import { db } from "@/db";
import { reportScheduleRuns, reportSchedules } from "@/db/schema";

export type ReportScheduleRow = typeof reportSchedules.$inferSelect;
type ReportScheduleInsert = typeof reportSchedules.$inferInsert;
type ReportScheduleRunRow = typeof reportScheduleRuns.$inferSelect;
type ReportScheduleRunInsert = typeof reportScheduleRuns.$inferInsert;

async function insertSchedule(
  values: ReportScheduleInsert,
): Promise<ReportScheduleRow> {
  const [row] = await db.insert(reportSchedules).values(values).returning();
  if (!row) throw new Error("Failed to insert report schedule");
  return row;
}

async function getScheduleByIdForProject(
  id: string,
  projectId: string,
): Promise<ReportScheduleRow | null> {
  const rows = await db
    .select()
    .from(reportSchedules)
    .where(
      and(eq(reportSchedules.id, id), eq(reportSchedules.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function updateSchedule(
  id: string,
  projectId: string,
  patch: Partial<ReportScheduleInsert>,
): Promise<ReportScheduleRow | null> {
  const rows = await db
    .update(reportSchedules)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      and(eq(reportSchedules.id, id), eq(reportSchedules.projectId, projectId)),
    )
    .returning();
  return rows[0] ?? null;
}

async function listSchedulesByProject(
  projectId: string,
): Promise<ReportScheduleRow[]> {
  return db
    .select()
    .from(reportSchedules)
    .where(eq(reportSchedules.projectId, projectId))
    .orderBy(desc(reportSchedules.createdAt));
}

/** Schedules due at or before `nowIso` that are still active (cron pass).
 *  Uses the (active, nextDueAt) due index — the pass's only query shape. */
async function listDueSchedules(nowIso: string): Promise<ReportScheduleRow[]> {
  return db
    .select()
    .from(reportSchedules)
    .where(
      and(
        eq(reportSchedules.active, true),
        lte(reportSchedules.nextDueAt, nowIso),
      ),
    )
    .orderBy(reportSchedules.nextDueAt);
}

/** Latest run row per schedule id (for the management list's last-run chip). */
async function latestRunsByScheduleIds(
  scheduleIds: string[],
): Promise<ReportScheduleRunRow[]> {
  if (scheduleIds.length === 0) return [];
  return db
    .select()
    .from(reportScheduleRuns)
    .where(inArray(reportScheduleRuns.scheduleId, scheduleIds))
    .orderBy(desc(reportScheduleRuns.claimedAt));
}

export const ReportScheduleRepository = {
  insertSchedule,
  getScheduleByIdForProject,
  updateSchedule,
  listSchedulesByProject,
  listDueSchedules,
  latestRunsByScheduleIds,
};
