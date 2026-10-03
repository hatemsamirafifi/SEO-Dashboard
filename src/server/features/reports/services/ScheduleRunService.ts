import { and, eq } from "drizzle-orm";
import { db } from "@/db";
import { reportScheduleRuns } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import type { ReportScheduleRunState } from "@/shared/reports";

type ReportScheduleRunRow = typeof reportScheduleRuns.$inferSelect;

type ClaimOutcome = "owned" | "fresh-conflict" | "already-terminal";

/** A non-terminal claim older than this is presumed crashed and reclaimable. */
const STALE_CLAIM_WINDOW_MS = 60 * 60 * 1000;

const TERMINAL_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "partially_delivered",
  "failed",
  "skipped",
]);

const NO_REENTRY_STATES: ReadonlySet<string> = new Set([
  "delivered",
  "partially_delivered",
  "skipped",
]);

const ALLOWED_TRANSITIONS: Record<string, ReadonlySet<string>> = {
  claimed: new Set(["generating", "failed", "skipped"]),
  generating: new Set(["delivering", "failed"]),
  delivering: new Set([
    "delivered",
    "partially_delivered",
    "failed",
    "skipped",
  ]),
  failed: new Set(["claimed"]),
  delivered: new Set(),
  partially_delivered: new Set(),
  skipped: new Set(),
};

function isUniqueViolation(error: unknown): boolean {
  // Drizzle wraps driver errors (outer message is "Failed query: …"), so walk
  // the cause chain: libsql/SQLite surfaces code SQLITE_CONSTRAINT_UNIQUE
  // (rawCode 2067), Postgres surfaces 23505. Same repository code, both
  // dialects — the constraint is the enforcement point per research R1.
  let current: unknown = error;
  while (current instanceof Error) {
    const withCode = current as Error & { code?: unknown; rawCode?: unknown };
    if (
      withCode.code === "SQLITE_CONSTRAINT_UNIQUE" ||
      withCode.code === "23505" ||
      withCode.rawCode === 2067 ||
      /UNIQUE constraint failed/i.test(current.message)
    ) {
      return true;
    }
    current = withCode.cause;
  }
  return false;
}

async function getRunById(runId: string): Promise<ReportScheduleRunRow | null> {
  const rows = await db
    .select()
    .from(reportScheduleRuns)
    .where(eq(reportScheduleRuns.id, runId))
    .limit(1);
  return rows[0] ?? null;
}

async function getRunByScheduleAndDate(
  scheduleId: string,
  scheduledFor: string,
): Promise<ReportScheduleRunRow | null> {
  const rows = await db
    .select()
    .from(reportScheduleRuns)
    .where(
      and(
        eq(reportScheduleRuns.scheduleId, scheduleId),
        eq(reportScheduleRuns.scheduledFor, scheduledFor),
      ),
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Claim the run for one (schedule, due date). The claim IS the insert
 * (research R1): a unique-violation means another invocation won, and the
 * outcome describes what the winner's row says. Failed rows are retried on
 * the same row; terminal non-failed rows no-op.
 */
export async function claimRun(input: {
  scheduleId: string;
  scheduledFor: string;
}): Promise<{ outcome: ClaimOutcome; run: ReportScheduleRunRow }> {
  const now = new Date().toISOString();
  try {
    const [row] = await db
      .insert(reportScheduleRuns)
      .values({
        id: crypto.randomUUID(),
        scheduleId: input.scheduleId,
        scheduledFor: input.scheduledFor,
        state: "claimed",
        claimedAt: now,
      })
      .returning();
    if (!row) throw new Error("Failed to insert schedule run");
    return { outcome: "owned", run: row };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
  const existing = await getRunByScheduleAndDate(
    input.scheduleId,
    input.scheduledFor,
  );
  if (!existing) {
    throw new Error("Schedule run claim lost its row after unique conflict");
  }
  if (NO_REENTRY_STATES.has(existing.state)) {
    return { outcome: "already-terminal", run: existing };
  }
  if (existing.state === "failed") {
    // Retry reuses the same row: the constraint forbids a second one.
    const [row] = await db
      .update(reportScheduleRuns)
      .set({ state: "claimed", claimedAt: now, failureClass: null })
      .where(eq(reportScheduleRuns.id, existing.id))
      .returning();
    if (!row) throw new Error("Failed to retry schedule run");
    return { outcome: "owned", run: row };
  }
  const claimedAt = Date.parse(existing.claimedAt);
  const stale =
    Number.isNaN(claimedAt) || Date.now() - claimedAt > STALE_CLAIM_WINDOW_MS;
  if (stale) {
    const [row] = await db
      .update(reportScheduleRuns)
      .set({ state: "claimed", claimedAt: now })
      .where(eq(reportScheduleRuns.id, existing.id))
      .returning();
    if (!row) throw new Error("Failed to reclaim schedule run");
    return { outcome: "owned", run: row };
  }
  return { outcome: "fresh-conflict", run: existing };
}

export async function transitionRun(input: {
  runId: string;
  to: ReportScheduleRunState;
  reportId?: string;
  failureClass?: string;
  skipReason?: string;
}): Promise<ReportScheduleRunRow> {
  const current = await getRunById(input.runId);
  if (!current) throw new AppError("NOT_FOUND", "Schedule run not found");
  const allowed = ALLOWED_TRANSITIONS[current.state] ?? new Set<string>();
  if (!allowed.has(input.to)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `Cannot transition schedule run from ${current.state} to ${input.to}`,
    );
  }
  const terminal = TERMINAL_STATES.has(input.to);
  const [row] = await db
    .update(reportScheduleRuns)
    .set({
      state: input.to,
      reportId: input.reportId ?? current.reportId,
      failureClass: input.failureClass ?? current.failureClass,
      skipReason: input.skipReason ?? current.skipReason,
      completedAt: terminal ? new Date().toISOString() : current.completedAt,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(reportScheduleRuns.id, input.runId))
    .returning();
  if (!row) throw new Error("Failed to transition schedule run");
  return row;
}

/** Test-only helper: age a claim past the staleness window. */
export async function backdateClaimForTest(
  runId: string,
  claimedAt: string,
): Promise<void> {
  await db
    .update(reportScheduleRuns)
    .set({ claimedAt })
    .where(eq(reportScheduleRuns.id, runId));
}

export const ScheduleRunService = {
  claimRun,
  transitionRun,
  backdateClaimForTest,
};
