import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  autopilotRunAttempts,
  autopilotRuns,
  autopilotSteps,
} from "@/db/schema";

export type AutopilotRunRow = typeof autopilotRuns.$inferSelect;
export type AutopilotRunInsert = typeof autopilotRuns.$inferInsert;
export type AutopilotAttemptRow = typeof autopilotRunAttempts.$inferSelect;
export type AutopilotAttemptInsert = typeof autopilotRunAttempts.$inferInsert;
export type AutopilotStepRow = typeof autopilotSteps.$inferSelect;
export type AutopilotStepInsert = typeof autopilotSteps.$inferInsert;

async function insertRun(values: AutopilotRunInsert): Promise<AutopilotRunRow> {
  const [row] = await db.insert(autopilotRuns).values(values).returning();
  if (!row) throw new Error("Failed to insert autopilot run");
  return row;
}

async function getRun(id: string): Promise<AutopilotRunRow | null> {
  const rows = await db
    .select()
    .from(autopilotRuns)
    .where(eq(autopilotRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getRunForProject(
  id: string,
  projectId: string,
): Promise<AutopilotRunRow | null> {
  const rows = await db
    .select()
    .from(autopilotRuns)
    .where(
      and(eq(autopilotRuns.id, id), eq(autopilotRuns.projectId, projectId)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function listRunsByProject(
  projectId: string,
  limit = 50,
): Promise<AutopilotRunRow[]> {
  return db
    .select()
    .from(autopilotRuns)
    .where(eq(autopilotRuns.projectId, projectId))
    .orderBy(desc(autopilotRuns.startedAt))
    .limit(limit);
}

async function listRunningRuns(projectId: string): Promise<AutopilotRunRow[]> {
  return db
    .select()
    .from(autopilotRuns)
    .where(
      and(
        eq(autopilotRuns.projectId, projectId),
        eq(autopilotRuns.status, "running"),
      ),
    );
}

async function updateRun(
  id: string,
  patch: Partial<AutopilotRunInsert>,
): Promise<AutopilotRunRow | null> {
  await db
    .update(autopilotRuns)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(autopilotRuns.id, id));
  return getRun(id);
}

async function insertAttempt(
  values: AutopilotAttemptInsert,
): Promise<AutopilotAttemptRow> {
  const [row] = await db
    .insert(autopilotRunAttempts)
    .values(values)
    .returning();
  if (!row) throw new Error("Failed to insert autopilot attempt");
  return row;
}

async function getAttempt(id: string): Promise<AutopilotAttemptRow | null> {
  const rows = await db
    .select()
    .from(autopilotRunAttempts)
    .where(eq(autopilotRunAttempts.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function listAttemptsByRun(
  runId: string,
): Promise<AutopilotAttemptRow[]> {
  return db
    .select()
    .from(autopilotRunAttempts)
    .where(eq(autopilotRunAttempts.runId, runId))
    .orderBy(autopilotRunAttempts.attemptNumber);
}

async function updateAttempt(
  id: string,
  patch: Partial<AutopilotAttemptInsert>,
): Promise<AutopilotAttemptRow | null> {
  await db
    .update(autopilotRunAttempts)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(eq(autopilotRunAttempts.id, id));
  return getAttempt(id);
}

async function insertStepIgnoreConflict(
  values: AutopilotStepInsert,
): Promise<void> {
  await db.insert(autopilotSteps).values(values).onConflictDoNothing();
}

async function getStep(
  attemptId: string,
  seq: number,
): Promise<AutopilotStepRow | null> {
  const rows = await db
    .select()
    .from(autopilotSteps)
    .where(
      and(eq(autopilotSteps.attemptId, attemptId), eq(autopilotSteps.seq, seq)),
    )
    .limit(1);
  return rows[0] ?? null;
}

async function listStepsByAttempt(
  attemptId: string,
): Promise<AutopilotStepRow[]> {
  return db
    .select()
    .from(autopilotSteps)
    .where(eq(autopilotSteps.attemptId, attemptId))
    .orderBy(autopilotSteps.seq);
}

async function listStepsByRun(runId: string): Promise<AutopilotStepRow[]> {
  return db
    .select()
    .from(autopilotSteps)
    .where(eq(autopilotSteps.runId, runId))
    .orderBy(autopilotSteps.seq);
}

async function updateStep(
  attemptId: string,
  seq: number,
  patch: Partial<AutopilotStepInsert>,
): Promise<AutopilotStepRow | null> {
  await db
    .update(autopilotSteps)
    .set({ ...patch, updatedAt: new Date().toISOString() })
    .where(
      and(eq(autopilotSteps.attemptId, attemptId), eq(autopilotSteps.seq, seq)),
    );
  return getStep(attemptId, seq);
}

export const AutopilotRepository = {
  insertRun,
  getRun,
  getRunForProject,
  listRunsByProject,
  listRunningRuns,
  updateRun,
  insertAttempt,
  getAttempt,
  listAttemptsByRun,
  updateAttempt,
  insertStepIgnoreConflict,
  getStep,
  listStepsByAttempt,
  listStepsByRun,
  updateStep,
};
