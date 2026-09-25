import { and, count, eq, gt, isNull } from "drizzle-orm";
import { db } from "@/db";
import {
  dashboardInsights,
  insightUserPreferences,
  intelligenceRuns,
} from "@/db/schema";

export type InsightRow = typeof dashboardInsights.$inferSelect;
export type InsightPreferenceRow = typeof insightUserPreferences.$inferSelect;

export type InsightInsert = typeof dashboardInsights.$inferInsert;
export type InsightPreferenceInsert = typeof insightUserPreferences.$inferInsert;

async function findByKey(
  projectId: string,
  insightKey: string,
): Promise<InsightRow | null> {
  const rows = await db
    .select()
    .from(dashboardInsights)
    .where(
      and(
        eq(dashboardInsights.projectId, projectId),
        eq(dashboardInsights.insightKey, insightKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/** Current (unresolved) rows for compose + resolve passes. */
async function listUnresolvedByProject(
  projectId: string,
): Promise<InsightRow[]> {
  return db
    .select()
    .from(dashboardInsights)
    .where(
      and(
        eq(dashboardInsights.projectId, projectId),
        isNull(dashboardInsights.resolvedAt),
      ),
    )
    .orderBy(dashboardInsights.insightKey);
}

async function listVisibleByProject(
  projectId: string,
): Promise<InsightRow[]> {
  return listUnresolvedByProject(projectId);
}

async function insertRow(values: InsightInsert): Promise<InsightRow> {
  const [row] = await db.insert(dashboardInsights).values(values).returning();
  if (!row) throw new Error("Failed to insert dashboard_insight");
  return row;
}

async function updateById(
  id: string,
  patch: Partial<InsightInsert>,
): Promise<InsightRow | null> {
  await db
    .update(dashboardInsights)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(dashboardInsights.id, id));
  const rows = await db
    .select()
    .from(dashboardInsights)
    .where(eq(dashboardInsights.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getPreference(
  userId: string,
  projectId: string,
  insightKey: string,
): Promise<InsightPreferenceRow | null> {
  const rows = await db
    .select()
    .from(insightUserPreferences)
    .where(
      and(
        eq(insightUserPreferences.userId, userId),
        eq(insightUserPreferences.projectId, projectId),
        eq(insightUserPreferences.insightKey, insightKey),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function listPreferencesByProject(
  userId: string,
  projectId: string,
): Promise<InsightPreferenceRow[]> {
  return db
    .select()
    .from(insightUserPreferences)
    .where(
      and(
        eq(insightUserPreferences.userId, userId),
        eq(insightUserPreferences.projectId, projectId),
      ),
    );
}

async function upsertPreference(
  values: InsightPreferenceInsert,
): Promise<InsightPreferenceRow> {
  await db
    .insert(insightUserPreferences)
    .values(values)
    .onConflictDoUpdate({
      target: [
        insightUserPreferences.userId,
        insightUserPreferences.projectId,
        insightUserPreferences.insightKey,
      ],
      set: {
        dismissedContentVersion: values.dismissedContentVersion,
        snoozedUntil: values.snoozedUntil,
        hash: values.hash,
        updatedAt: new Date().toISOString(),
      },
    });
  const row = await getPreference(
    values.userId,
    values.projectId,
    values.insightKey,
  );
  if (!row) throw new Error("Failed to upsert insight preference");
  return row;
}

/** Runs started after a timestamp (reopen "N scans" reasons). */
async function countRunsSince(
  projectId: string,
  sinceIso: string,
): Promise<number> {
  const rows = await db
    .select({ value: count() })
    .from(intelligenceRuns)
    .where(
      and(
        eq(intelligenceRuns.projectId, projectId),
        gt(intelligenceRuns.startedAt, sinceIso),
      ),
    );
  return rows[0]?.value ?? 0;
}

export const InsightRepository = {
  findByKey,
  listUnresolvedByProject,
  listVisibleByProject,
  insertRow,
  updateById,
  getPreference,
  listPreferencesByProject,
  upsertPreference,
  countRunsSince,
};
