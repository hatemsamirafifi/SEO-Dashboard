import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { reports } from "@/db/schema";

export type ReportRow = typeof reports.$inferSelect;
export type ReportInsert = typeof reports.$inferInsert;

async function insertRow(values: ReportInsert): Promise<ReportRow> {
  const [row] = await db.insert(reports).values(values).returning();
  if (!row) throw new Error("Failed to insert report");
  return row;
}

async function getById(id: string): Promise<ReportRow | null> {
  const rows = await db
    .select()
    .from(reports)
    .where(eq(reports.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getByIdForProject(
  id: string,
  projectId: string,
): Promise<ReportRow | null> {
  const rows = await db
    .select()
    .from(reports)
    .where(and(eq(reports.id, id), eq(reports.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

async function listByProject(projectId: string): Promise<ReportRow[]> {
  return db
    .select()
    .from(reports)
    .where(eq(reports.projectId, projectId))
    .orderBy(desc(reports.createdAt));
}

async function deleteByIdForProject(
  id: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .delete(reports)
    .where(and(eq(reports.id, id), eq(reports.projectId, projectId)))
    .returning({ id: reports.id });
  return rows.length > 0;
}

export const ReportRepository = {
  insertRow,
  getById,
  getByIdForProject,
  listByProject,
  deleteByIdForProject,
};
