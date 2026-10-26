import { and, desc, eq, gte, inArray, isNotNull, sql } from "drizzle-orm";
import { db } from "@/db";
import { opportunities, opportunityEvents } from "@/db/schema";

export type OpportunityRow = typeof opportunities.$inferSelect;
export type OpportunityEventRow = typeof opportunityEvents.$inferSelect;

export type OpportunityStatus =
  | "open"
  | "in_progress"
  | "completed"
  | "dismissed";

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
  // Spec 021: user triage (assignee/effort) and autopilot completion
  // evidence — both idempotent via eventKey, neither changes lifecycle.
  "triage_changed",
  "completion_evidence",
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

export type OpportunityListFilters = {
  status?: OpportunityStatus;
  type?: string;
  // Spec 010 (contracts/opportunities-filters.md): composable dimensions.
  // Single values narrow; arrays are OR-within-dimension (empty = all);
  // every dimension AND-composes with the others. `source` matches
  // opportunities whose stored sources array contains the value exactly.
  page?: string;
  keyword?: string;
  source?: string;
  priority?: string;
  statuses?: OpportunityStatus[];
  types?: string[];
  priorities?: string[];
  // Spec 021 (next actions): recency bounds are inclusive ISO lower bounds —
  // `recentSince` on lastDetectedAt (a confirmed long-lived item stays
  // visible), `detectedSince` on firstDetectedAt (newly detected rows).
  // `reopened` narrows to occurrences with a stored recurrence chain.
  recentSince?: string;
  detectedSince?: string;
  reopened?: boolean;
};

/** Escape LIKE wildcards in a filter value (KeywordResearchRepository precedent). */
function escapeLike(value: string) {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

async function listByProject(
  projectId: string,
  filters?: OpportunityListFilters,
): Promise<OpportunityRow[]> {
  const conditions = [eq(opportunities.projectId, projectId)];
  const statusValues = [
    ...(filters?.status ? [filters.status] : []),
    ...(filters?.statuses ?? []),
  ];
  if (statusValues.length > 0) {
    conditions.push(inArray(opportunities.status, statusValues));
  }
  const typeValues = [
    ...(filters?.type ? [filters.type] : []),
    ...(filters?.types ?? []),
  ];
  if (typeValues.length > 0) {
    conditions.push(inArray(opportunities.type, typeValues));
  }
  if (filters?.page) conditions.push(eq(opportunities.page, filters.page));
  if (filters?.keyword)
    conditions.push(eq(opportunities.keyword, filters.keyword));
  if (filters?.priority)
    conditions.push(eq(opportunities.priority, filters.priority));
  if (filters?.priorities && filters.priorities.length > 0) {
    conditions.push(inArray(opportunities.priority, filters.priorities));
  }
  if (filters?.source) {
    // Exact array-element match over the JSON-encoded sources column, valid
    // on both dialects: serialized elements are always double-quoted, so a
    // quote-wrapped LIKE matches whole elements only, never substrings.
    conditions.push(
      sql`${opportunities.sourcesJson} like ${`%"${escapeLike(filters.source)}"%`} escape '\\'`,
    );
  }
  if (filters?.recentSince) {
    conditions.push(gte(opportunities.lastDetectedAt, filters.recentSince));
  }
  if (filters?.detectedSince) {
    conditions.push(gte(opportunities.firstDetectedAt, filters.detectedSince));
  }
  if (filters?.reopened) {
    conditions.push(isNotNull(opportunities.recurrenceOfId));
  }
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
    .where(
      and(eq(opportunities.id, id), eq(opportunities.projectId, projectId)),
    )
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

/** Append-only with idempotency keys: resume/retry replays record once.
 *  Returns whether this call inserted a row (false = idempotent replay). */
async function insertEventIgnoreConflict(
  event: OpportunityEventInsert,
): Promise<boolean> {
  const inserted = await db
    .insert(opportunityEvents)
    .values(event)
    .onConflictDoNothing()
    .returning({ id: opportunityEvents.id });
  return inserted.length > 0;
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
