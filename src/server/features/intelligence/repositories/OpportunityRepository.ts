import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { opportunities, opportunityEvents } from "@/db/schema";

export type OpportunityRow = typeof opportunities.$inferSelect;
export type OpportunityEventRow = typeof opportunityEvents.$inferSelect;

export type OpportunityStatus = "open" | "in_progress" | "completed" | "dismissed";

const ACTIVE_STATUSES: OpportunityStatus[] = ["open", "in_progress"];

export const OPPORTUNITY_EVENT_TYPES = [
  "detected",
  "redetected",
  "rescored",
  "evidence_updated",
  "status_changed",
  "stale_marked",
  "stale_cleared",
  "completed",
  "dismissed",
  "recurred",
  "superseded",
] as const;
export type OpportunityEventType = (typeof OPPORTUNITY_EVENT_TYPES)[number];

async function findActiveByKey(
  projectId: string,
  logicalKey: string,
): Promise<OpportunityRow | null> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.projectId, projectId),
        eq(opportunities.logicalKey, logicalKey),
        inArray(opportunities.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(desc(opportunities.occurrenceNumber))
    .limit(1);
  return rows[0] ?? null;
}

async function findLatestByKey(
  projectId: string,
  logicalKey: string,
): Promise<OpportunityRow | null> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.projectId, projectId),
        eq(opportunities.logicalKey, logicalKey),
      ),
    )
    .orderBy(desc(opportunities.occurrenceNumber))
    .limit(1);
  return rows[0] ?? null;
}

async function listActiveByProject(
  projectId: string,
): Promise<OpportunityRow[]> {
  return db
    .select()
    .from(opportunities)
    .where(
      and(
        eq(opportunities.projectId, projectId),
        inArray(opportunities.status, ACTIVE_STATUSES),
      ),
    )
    .orderBy(opportunities.logicalKey);
}

async function listByProject(
  projectId: string,
  filters?: { status?: OpportunityStatus; type?: string },
): Promise<OpportunityRow[]> {
  const conditions = [eq(opportunities.projectId, projectId)];
  if (filters?.status) conditions.push(eq(opportunities.status, filters.status));
  if (filters?.type) conditions.push(eq(opportunities.type, filters.type));
  return db
    .select()
    .from(opportunities)
    .where(and(...conditions))
    .orderBy(opportunities.createdAt);
}

async function getById(id: string): Promise<OpportunityRow | null> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(eq(opportunities.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getByIdForProject(
  id: string,
  projectId: string,
): Promise<OpportunityRow | null> {
  const rows = await db
    .select()
    .from(opportunities)
    .where(and(eq(opportunities.id, id), eq(opportunities.projectId, projectId)))
    .limit(1);
  return rows[0] ?? null;
}

export type OpportunityInsert = typeof opportunities.$inferInsert;

/**
 * Race-safe first step of the plan's upsert protocol: concurrent
 * materializations of the same key collide silently here; the caller then
 * SELECTs the winner and applies the idempotent in-place update.
 */
async function insertIgnoreConflict(values: OpportunityInsert): Promise<void> {
  await db.insert(opportunities).values(values).onConflictDoNothing();
}

async function updateById(
  id: string,
  patch: Partial<OpportunityInsert>,
): Promise<OpportunityRow | null> {
  await db
    .update(opportunities)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(opportunities.id, id));
  return getById(id);
}

export type OpportunityEventInsert = typeof opportunityEvents.$inferInsert;

/** Append-only with idempotency keys: resume/retry replays record once. */
async function insertEventIgnoreConflict(
  event: OpportunityEventInsert,
): Promise<void> {
  await db.insert(opportunityEvents).values(event).onConflictDoNothing();
}

async function listEventsByOccurrence(
  occurrenceId: string,
): Promise<OpportunityEventRow[]> {
  return db
    .select()
    .from(opportunityEvents)
    .where(eq(opportunityEvents.occurrenceId, occurrenceId))
    .orderBy(opportunityEvents.createdAt);
}

export const OpportunityRepository = {
  findActiveByKey,
  findLatestByKey,
  listActiveByProject,
  listByProject,
  getById,
  getByIdForProject,
  insertIgnoreConflict,
  updateById,
  insertEventIgnoreConflict,
  listEventsByOccurrence,
};
