import { and, desc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import { intelligenceRunDetectors, intelligenceRuns } from "@/db/schema";
import { runBatch } from "@/db/runBatch";

export type IntelligenceRunRow = typeof intelligenceRuns.$inferSelect;
export type IntelligenceRunDetectorRow =
  typeof intelligenceRunDetectors.$inferSelect;

/** Stage machine (final-plan §6). */
export const INTELLIGENCE_STAGES = [
  "pending",
  "detecting",
  "materializing",
  "composing",
] as const;
export type IntelligenceStage = (typeof INTELLIGENCE_STAGES)[number];

export const INTELLIGENCE_STATUSES = [
  "pending",
  "detecting",
  "materializing",
  "composing",
  "completed",
  "partial",
  "failed",
] as const;
export type IntelligenceStatus = (typeof INTELLIGENCE_STATUSES)[number];

export const INTELLIGENCE_DETECTOR_STATUSES = [
  "pending",
  "completed",
  "skipped",
  "failed",
] as const;
export type IntelligenceDetectorStatus =
  (typeof INTELLIGENCE_DETECTOR_STATUSES)[number];

const STAGE_ORDER: Record<IntelligenceStage, number> = {
  pending: 0,
  detecting: 1,
  materializing: 2,
  composing: 3,
};

export class InvalidStageTransitionError extends Error {}

/** Explicit ISO-8601 (see Ga4SyncRepository.createSyncRun): timestamps are
 *  compared lexicographically for the 4h scheduler floor on both dialects. */
function nowIso(): string {
  return new Date().toISOString();
}

async function createRun(input: {
  id?: string;
  projectId: string;
  organizationId: string;
  triggeredBy?: string;
}): Promise<IntelligenceRunRow> {
  const id = input.id ?? crypto.randomUUID();
  const timestamp = nowIso();
  const [row] = await db
    .insert(intelligenceRuns)
    .values({
      id,
      projectId: input.projectId,
      organizationId: input.organizationId,
      status: "pending",
      currentStage: "pending",
      triggeredBy: input.triggeredBy ?? "cron",
      startedAt: timestamp,
      createdAt: timestamp,
      updatedAt: timestamp,
    })
    .returning();
  if (!row) throw new Error("Failed to insert intelligence run");
  return row;
}

async function getRun(id: string): Promise<IntelligenceRunRow | null> {
  const rows = await db
    .select()
    .from(intelligenceRuns)
    .where(eq(intelligenceRuns.id, id))
    .limit(1);
  return rows[0] ?? null;
}

async function getLatestRun(
  projectId: string,
): Promise<IntelligenceRunRow | null> {
  const rows = await db
    .select()
    .from(intelligenceRuns)
    .where(eq(intelligenceRuns.projectId, projectId))
    .orderBy(desc(intelligenceRuns.startedAt))
    .limit(1);
  return rows[0] ?? null;
}

/** Latest completed/partial run carrying an input hash — the scheduler's
 *  `changed` predicate and staleness labels read this single indexed row. */
async function getLatestSuccessfulRun(
  projectId: string,
): Promise<IntelligenceRunRow | null> {
  const rows = await db
    .select()
    .from(intelligenceRuns)
    .where(
      and(
        eq(intelligenceRuns.projectId, projectId),
        inArray(intelligenceRuns.status, ["completed", "partial"]),
      ),
    )
    .orderBy(desc(intelligenceRuns.completedAt))
    .limit(5);
  return rows.find((row) => row.inputHash !== null) ?? null;
}

async function listRecentRuns(
  projectId: string,
  limit: number,
): Promise<IntelligenceRunRow[]> {
  return db
    .select()
    .from(intelligenceRuns)
    .where(eq(intelligenceRuns.projectId, projectId))
    .orderBy(desc(intelligenceRuns.startedAt))
    .limit(limit);
}

/**
 * Guarded forward transition: pending→detecting→materializing→composing→
 * completed, composing→partial, or any→failed. Anything else throws
 * `InvalidStageTransitionError` (backward moves would silently re-detect).
 */
async function transitionStage(input: {
  id: string;
  toStage?: IntelligenceStage;
  toStatus?: IntelligenceStatus;
}): Promise<IntelligenceRunRow> {
  const run = await getRun(input.id);
  if (!run) throw new Error(`Intelligence run not found: ${input.id}`);
  const toStage = input.toStage ?? run.currentStage;
  const toStatus = input.toStatus ?? run.status;
  const valid = isValidTransition(
    run.currentStage,
    run.status,
    toStage,
    toStatus,
  );
  if (!valid) {
    throw new InvalidStageTransitionError(
      `Invalid intelligence transition ${run.currentStage}/${run.status} → ${toStage}/${toStatus}`,
    );
  }
  const patch: Partial<typeof intelligenceRuns.$inferInsert> = {
    currentStage: toStage,
    status: toStatus,
    updatedAt: nowIso(),
  };
  if (toStatus === "completed" || toStatus === "partial" || toStatus === "failed") {
    patch.completedAt = nowIso();
  }
  await db
    .update(intelligenceRuns)
    .set(patch)
    .where(eq(intelligenceRuns.id, input.id));
  const updated = await getRun(input.id);
  if (!updated) throw new Error(`Intelligence run not found: ${input.id}`);
  return updated;
}

function isValidTransition(
  fromStage: string,
  fromStatus: string,
  toStage: string,
  toStatus: string,
): boolean {
  if (toStatus === "failed") return true;
  if (fromStatus === "failed") return false;
  // Idempotent re-entry (resume re-asserts the detecting stage).
  if (fromStage === toStage && fromStatus === toStatus) return true;
  if (toStatus === "partial") {
    return fromStage === "composing" && toStage === "composing";
  }
  if (toStatus === "completed") {
    return fromStage === "composing" && toStage === "composing";
  }
  const fromOrder = STAGE_ORDER[fromStage as IntelligenceStage];
  const toOrder = STAGE_ORDER[toStage as IntelligenceStage];
  if (fromOrder === undefined || toOrder === undefined) return false;
  // Forward one stage at a time; status tracks the stage while in flight.
  return (
    toOrder === fromOrder + 1 &&
    (toStatus === toStage || toStatus === fromStatus)
  );
}

async function recordDetectorOutcome(input: {
  runId: string;
  detectorKey: string;
  status: IntelligenceDetectorStatus;
  findingsCount?: number;
  chunkKeys?: string[];
  skipReason?: string | null;
  error?: string | null;
}): Promise<void> {
  const timestamp = nowIso();
  const finished =
    input.status === "completed" ||
    input.status === "skipped" ||
    input.status === "failed";
  await db
    .insert(intelligenceRunDetectors)
    .values({
      runId: input.runId,
      detectorKey: input.detectorKey,
      status: input.status,
      findingsCount: input.findingsCount ?? 0,
      chunkKeysJson:
        input.chunkKeys === undefined ? null : JSON.stringify(input.chunkKeys),
      skipReason: input.skipReason ?? null,
      error: input.error ?? null,
      startedAt: timestamp,
      completedAt: finished ? timestamp : null,
    })
    .onConflictDoUpdate({
      target: [
        intelligenceRunDetectors.runId,
        intelligenceRunDetectors.detectorKey,
      ],
      set: {
        status: input.status,
        findingsCount: input.findingsCount ?? 0,
        chunkKeysJson:
          input.chunkKeys === undefined
            ? null
            : JSON.stringify(input.chunkKeys),
        skipReason: input.skipReason ?? null,
        error: input.error ?? null,
        completedAt: finished ? timestamp : null,
      },
    });
}

async function getDetectorOutcomes(
  runId: string,
): Promise<IntelligenceRunDetectorRow[]> {
  return db
    .select()
    .from(intelligenceRunDetectors)
    .where(eq(intelligenceRunDetectors.runId, runId));
}

async function failRun(
  id: string,
  failure: { error: string; errorClass: string; errorStage: string },
): Promise<IntelligenceRunRow> {
  await db
    .update(intelligenceRuns)
    .set({
      status: "failed",
      error: failure.error,
      errorClass: failure.errorClass,
      errorStage: failure.errorStage,
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(eq(intelligenceRuns.id, id));
  const updated = await getRun(id);
  if (!updated) throw new Error(`Intelligence run not found: ${id}`);
  return updated;
}

async function commitStageOnePointer(input: {
  id: string;
  inputHash: string;
  inputSourceVersionsJson: string;
  detectorVersionsJson: string;
  thresholdVersion: number;
  manifestKey: string;
  manifestHash: string;
  findingsSchemaVersion: number;
  findingsCount: number;
  detectionAttemptMetaJson: string;
}): Promise<IntelligenceRunRow> {
  const run = await getRun(input.id);
  if (!run) throw new Error(`Intelligence run not found: ${input.id}`);
  if (run.currentStage !== "detecting") {
    throw new InvalidStageTransitionError(
      `Stage-1 pointer commit requires detecting stage, found ${run.currentStage}`,
    );
  }
  // Stage boundaries are the transaction boundaries: pointer + stage move
  // commit together so R2-ok/DB-fail leaves harmless orphans (swept by the
  // 30-day unreferenced cleanup) rather than a run pointing at nothing.
  await runBatch((tx) => [
    tx
      .update(intelligenceRuns)
      .set({
        inputHash: input.inputHash,
        inputSourceVersionsJson: input.inputSourceVersionsJson,
        detectorVersionsJson: input.detectorVersionsJson,
        thresholdVersion: input.thresholdVersion,
        manifestKey: input.manifestKey,
        manifestHash: input.manifestHash,
        findingsSchemaVersion: input.findingsSchemaVersion,
        findingsCount: input.findingsCount,
        detectionAttemptMetaJson: input.detectionAttemptMetaJson,
        currentStage: "materializing",
        status: "materializing",
        updatedAt: nowIso(),
      })
      .where(eq(intelligenceRuns.id, input.id)),
  ]);
  const updated = await getRun(input.id);
  if (!updated) throw new Error(`Intelligence run not found: ${input.id}`);
  return updated;
}

export const ScanLedgerRepository = {
  createRun,
  getRun,
  getLatestRun,
  getLatestSuccessfulRun,
  listRecentRuns,
  transitionStage,
  recordDetectorOutcome,
  getDetectorOutcomes,
  failRun,
  commitStageOnePointer,
};
