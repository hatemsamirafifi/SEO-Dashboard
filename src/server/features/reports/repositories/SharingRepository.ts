import { desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportEvents, reportShares } from "@/db/schema";

export type ReportShareRow = typeof reportShares.$inferSelect;
export type ReportShareInsert = typeof reportShares.$inferInsert;
export type ReportEventRow = typeof reportEvents.$inferSelect;
export type ReportEventInsert = typeof reportEvents.$inferInsert;

export const REPORT_EVENT_TYPES = [
  "created",
  "shared",
  "revoked",
  "viewed",
  "exported_pdf",
] as const;
export type ReportEventType = (typeof REPORT_EVENT_TYPES)[number];

async function insertShare(values: ReportShareInsert): Promise<ReportShareRow> {
  const [row] = await db.insert(reportShares).values(values).returning();
  if (!row) throw new Error("Failed to insert report share");
  return row;
}

async function findShareById(id: string): Promise<ReportShareRow | null> {
  const rows = await db
    .select()
    .from(reportShares)
    .where(eq(reportShares.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function findShareByTokenHash(
  tokenHash: string,
): Promise<ReportShareRow | null> {
  const rows = await db
    .select()
    .from(reportShares)
    .where(eq(reportShares.tokenHash, tokenHash))
    .limit(1);
  return rows[0] ?? null;
}

async function listSharesByReport(reportId: string): Promise<ReportShareRow[]> {
  return db
    .select()
    .from(reportShares)
    .where(eq(reportShares.reportId, reportId))
    .orderBy(desc(reportShares.createdAt));
}

async function revokeShare(
  id: string,
  nowIso: string,
): Promise<ReportShareRow | null> {
  await db
    .update(reportShares)
    .set({ revokedAt: nowIso })
    .where(eq(reportShares.id, id));
  return findShareById(id);
}

async function incrementViewCount(id: string): Promise<void> {
  const current = await findShareById(id);
  if (!current) return;
  await db
    .update(reportShares)
    .set({ viewCount: current.viewCount + 1 })
    .where(eq(reportShares.id, id));
}

async function insertEvent(values: ReportEventInsert): Promise<ReportEventRow> {
  const [row] = await db.insert(reportEvents).values(values).returning();
  if (!row) throw new Error("Failed to insert report event");
  return row;
}

async function listEventsByReport(reportId: string): Promise<ReportEventRow[]> {
  return db
    .select()
    .from(reportEvents)
    .where(eq(reportEvents.reportId, reportId))
    .orderBy(desc(reportEvents.createdAt));
}

export const SharingRepository = {
  insertShare,
  findShareById,
  findShareByTokenHash,
  listSharesByReport,
  revokeShare,
  incrementViewCount,
  insertEvent,
  listEventsByReport,
};
