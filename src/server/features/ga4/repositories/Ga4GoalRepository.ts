import { and, asc, eq, isNull } from "drizzle-orm";
import { db } from "@/db";
import { ga4ProjectGoals } from "@/db/schema";

export type Ga4GoalRow = typeof ga4ProjectGoals.$inferSelect;
export type Ga4GoalInsert = typeof ga4ProjectGoals.$inferInsert;

async function create(input: {
  projectId: string;
  organizationId: string;
  name: string;
  eventName: string;
  matchKeyEventOnly: boolean;
}): Promise<Ga4GoalRow> {
  const [row] = await db
    .insert(ga4ProjectGoals)
    .values({ id: crypto.randomUUID(), ...input })
    .returning();
  if (!row) throw new Error("Failed to create ga4_project_goal");
  return row;
}

async function listByProject(
  projectId: string,
  organizationId: string,
  includeArchived: boolean,
): Promise<Ga4GoalRow[]> {
  const conditions = [
    eq(ga4ProjectGoals.projectId, projectId),
    eq(ga4ProjectGoals.organizationId, organizationId),
    ...(includeArchived ? [] : [isNull(ga4ProjectGoals.archivedAt)]),
  ];
  return db
    .select()
    .from(ga4ProjectGoals)
    .where(and(...conditions))
    .orderBy(asc(ga4ProjectGoals.createdAt));
}

async function getByIdForProject(
  id: string,
  projectId: string,
  organizationId: string,
): Promise<Ga4GoalRow | null> {
  const rows = await db
    .select()
    .from(ga4ProjectGoals)
    .where(
      and(
        eq(ga4ProjectGoals.id, id),
        eq(ga4ProjectGoals.projectId, projectId),
        eq(ga4ProjectGoals.organizationId, organizationId),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function findActiveByName(
  projectId: string,
  organizationId: string,
  name: string,
): Promise<Ga4GoalRow | null> {
  const rows = await db
    .select()
    .from(ga4ProjectGoals)
    .where(
      and(
        eq(ga4ProjectGoals.projectId, projectId),
        eq(ga4ProjectGoals.organizationId, organizationId),
        eq(ga4ProjectGoals.name, name),
        isNull(ga4ProjectGoals.archivedAt),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function countActiveByProject(
  projectId: string,
  organizationId: string,
): Promise<number> {
  const rows = await db
    .select({ id: ga4ProjectGoals.id })
    .from(ga4ProjectGoals)
    .where(
      and(
        eq(ga4ProjectGoals.projectId, projectId),
        eq(ga4ProjectGoals.organizationId, organizationId),
        isNull(ga4ProjectGoals.archivedAt),
      ),
    );
  return rows.length;
}

async function updateById(
  id: string,
  patch: Partial<
    Pick<Ga4GoalInsert, "name" | "eventName" | "matchKeyEventOnly">
  >,
): Promise<Ga4GoalRow | null> {
  const [row] = await db
    .update(ga4ProjectGoals)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(ga4ProjectGoals.id, id))
    .returning();
  return row ?? null;
}

async function archiveById(id: string, archivedAt: string) {
  await db
    .update(ga4ProjectGoals)
    .set({ archivedAt, updatedAt: new Date().toISOString() })
    .where(eq(ga4ProjectGoals.id, id));
}

export const Ga4GoalRepository = {
  create,
  listByProject,
  getByIdForProject,
  findActiveByName,
  countActiveByProject,
  updateById,
  archiveById,
};
