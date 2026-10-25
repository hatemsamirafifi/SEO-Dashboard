/* eslint-disable max-lines -- run lifecycle (claim/lease/fence/finalize) lives
   in one repository module by design */
import { and, asc, desc, eq, gte, inArray, lte, sql } from "drizzle-orm";
import { z } from "zod";
import { db } from "@/db";
import {
  googleAdsConnections,
  googleAdsSyncRuns,
  googleAdsSyncUnits,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import {
  GOOGLE_ADS_GRAINS,
  GOOGLE_ADS_SYNC_ERROR_CLASSES,
  googleAdsUnitScopeSchema,
  isGoogleAdsIsoDate,
  isGoogleAdsIsoInstant,
  type GoogleAdsGrain,
  type GoogleAdsSyncErrorClass,
  type GoogleAdsUnitScope,
} from "./googleAdsAnalyticsModel";

// Google Ads durable sync ledger (master plan phase 7).
//
// Runs capture a deterministic identity (window + mode + scheduled slot +
// connection fingerprint). Competing triggers coalesce onto the unique
// ACTIVE claim per (project, customer, key); a run whose lease expired may
// be resumed by bumping the `attempt` fencing counter. Every unit/finalize
// write is scoped by runId + attempt, never by runId alone, so stale
// workers' writes become no-ops. Fingerprint fields (grant account, login
// customer, lease timestamps) are NEVER returned by the public shaped
// getters.

export type GoogleAdsSyncMode = "scheduled" | "manual" | "backfill";

export type GoogleAdsSyncFingerprint = {
  /** Immutable id of the google_ads_connections row at trigger time. */
  connectionId: string;
  grantAccountId: string;
  loginCustomerId: string | null;
  connectionUpdatedAt: string;
};

export type GoogleAdsSyncClaimInput = {
  scope: GoogleAdsUnitScope;
  mode: GoogleAdsSyncMode;
  window: { startDate: string; endDate: string };
  scheduledSlot: string | null;
  fingerprint: GoogleAdsSyncFingerprint;
  /** Lease duration in seconds (default 900). */
  leaseSeconds?: number;
};

export type GoogleAdsClaimOutcome =
  | {
      outcome: "created" | "coalesced" | "resumed";
      run: GoogleAdsSyncRunFull;
    }
  | {
      outcome: "disconnected" | "connection_changed";
      run: GoogleAdsSyncRunFull | null;
    };

export type GoogleAdsSyncRunFull = typeof googleAdsSyncRuns.$inferSelect;

export type GoogleAdsSyncRunPublic = {
  id: string;
  projectId: string;
  customerId: string;
  runKey: string;
  mode: string;
  windowStartDate: string;
  windowEndDate: string;
  scheduledSlot: string | null;
  attempt: number;
  status: string;
  startedAt: string;
  completedAt: string | null;
  unitsTotal: number;
  unitsSucceeded: number;
  unitsFailed: number;
  errorClass: string | null;
  errorMessage: string | null;
  createdAt: string;
  updatedAt: string;
};

export type GoogleAdsSyncUnit = typeof googleAdsSyncUnits.$inferSelect;

export type GoogleAdsSyncUnitStatus =
  | "pending"
  | "success_with_data"
  | "success_zero_rows"
  | "partial"
  | "failed";

export type GoogleAdsUnitPlan = { date: string; grain: GoogleAdsGrain };

// ---------------------------------------------------------------------------
// Deterministic run identity
// ---------------------------------------------------------------------------

function fnv1a32(input: string): string {
  let hash = 0x811c9dc5;
  const encoded = new TextEncoder().encode(input);
  for (const byte of encoded) {
    hash ^= byte;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash.toString(16).padStart(8, "0");
}

function composeRunKey(input: {
  windowStartDate: string;
  windowEndDate: string;
  mode: GoogleAdsSyncMode;
  scheduledSlot: string | null;
  fingerprint: GoogleAdsSyncFingerprint;
}): string {
  const root = `${input.windowStartDate}|${input.windowEndDate}|${input.mode}|${String(input.scheduledSlot)}|${input.fingerprint.connectionId}|${input.fingerprint.grantAccountId}|${String(input.fingerprint.loginCustomerId)}|${input.fingerprint.connectionUpdatedAt}`;
  return `${fnv1a32(root)}${fnv1a32(`${root.length}:${root}`)}`;
}

function nowIso(): string {
  return new Date().toISOString();
}

function leaseFromNow(seconds: number): string {
  return new Date(Date.now() + seconds * 1000).toISOString();
}

function isLeaseActive(leaseExpiresAt: string): boolean {
  return leaseExpiresAt > nowIso();
}

// ---------------------------------------------------------------------------
// Connection fingerprint fence
// ---------------------------------------------------------------------------

type FingerprintCheck =
  | { ok: true }
  | { ok: false; reason: "disconnected" | "connection_changed" };

async function verifyConnectionFingerprint(
  scope: GoogleAdsUnitScope,
  fingerprint: GoogleAdsSyncFingerprint,
): Promise<FingerprintCheck> {
  const rows = await db
    .select({
      id: googleAdsConnections.id,
      customerId: googleAdsConnections.customerId,
      grantAccountId: googleAdsConnections.grantAccountId,
      updatedAt: googleAdsConnections.updatedAt,
    })
    .from(googleAdsConnections)
    .where(
      and(
        eq(googleAdsConnections.projectId, scope.projectId),
        eq(googleAdsConnections.organizationId, scope.organizationId),
      ),
    )
    .limit(1);
  const connection = rows[0];
  if (!connection) return { ok: false, reason: "disconnected" };
  if (
    // The immutable id comparison is what keeps a deleted + re-created
    // connection row (same grant, rewritten or equal updatedAt) from
    // resurrecting an old claim.
    connection.customerId !== scope.customerId ||
    connection.id !== fingerprint.connectionId ||
    connection.grantAccountId !== fingerprint.grantAccountId ||
    connection.updatedAt !== fingerprint.connectionUpdatedAt
  ) {
    return { ok: false, reason: "connection_changed" };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Staging / fence bookkeeping
// ---------------------------------------------------------------------------

function isSyncErrorClass(value: string): value is GoogleAdsSyncErrorClass {
  return (GOOGLE_ADS_SYNC_ERROR_CLASSES as readonly string[]).includes(value);
}

function requireErrorClass(value: string): GoogleAdsSyncErrorClass {
  if (!isSyncErrorClass(value)) {
    throw new Error("Expected a bounded Google Ads sync error class");
  }
  return value;
}

async function markRunFenced(
  run: Pick<GoogleAdsSyncRunFull, "id" | "attempt">,
  reason: "disconnected" | "connection_changed",
): Promise<void> {
  await db
    .update(googleAdsSyncRuns)
    .set({
      status: "fenced",
      errorClass:
        reason === "disconnected" ? "DISCONNECTED" : "CONNECTION_CHANGED",
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, run.id),
        eq(googleAdsSyncRuns.attempt, run.attempt),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
      ),
    );
}

// ---------------------------------------------------------------------------
// Claim / coalesce / resume
// ---------------------------------------------------------------------------

/** The oldest active run that overlaps the trigger window. Overlap is scope
 *  (project, customer) + a shared day range — NOT identical run keys — so an
 *  overlapping scheduled run and backfill never work the same account/day
 *  units concurrently. */
async function findOverlappingActiveRun(
  scope: GoogleAdsUnitScope,
  window: { startDate: string; endDate: string },
): Promise<GoogleAdsSyncRunFull | null> {
  const rows = await db
    .select()
    .from(googleAdsSyncRuns)
    .where(
      and(
        eq(googleAdsSyncRuns.projectId, scope.projectId),
        eq(googleAdsSyncRuns.customerId, scope.customerId),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
        // Inclusive day-range overlap: run.start <= window.end AND
        // window.start <= run.end.
        lte(googleAdsSyncRuns.windowStartDate, window.endDate),
        gte(googleAdsSyncRuns.windowEndDate, window.startDate),
      ),
    )
    .orderBy(asc(googleAdsSyncRuns.createdAt))
    .limit(1);
  return rows[0] ?? null;
}

function insertClaimRunValues(
  input: GoogleAdsSyncClaimInput,
  runKey: string,
  leaseSeconds: number,
) {
  const s = input.scope;
  return {
    id: crypto.randomUUID(),
    projectId: s.projectId,
    organizationId: s.organizationId,
    customerId: s.customerId,
    runKey,
    mode: input.mode,
    windowStartDate: input.window.startDate,
    windowEndDate: input.window.endDate,
    scheduledSlot: input.scheduledSlot,
    fingerprintConnectionId: input.fingerprint.connectionId,
    fingerprintGrantAccountId: input.fingerprint.grantAccountId,
    fingerprintLoginCustomerId: input.fingerprint.loginCustomerId,
    fingerprintConnectionUpdatedAt: input.fingerprint.connectionUpdatedAt,
    attempt: 1,
    status: "running",
    leaseExpiresAt: leaseFromNow(leaseSeconds),
    heartbeatAt: nowIso(),
    startedAt: nowIso(),
  };
}

/** Claims the run identity for the current trigger, coalescing per account
 *  across OVERLAPPING windows (not only identical run keys):
 *
 * - An oldest active run whose window overlaps the trigger window first
 *   fences it (a run on a changed/deleted connection never resurrects) and
 *   otherwise coalesces onto it regardless of run key — never two concurrent
 *   runs over the same account/day units.
 * - That overlapping run has an EXPIRED lease: resumed by bumping the
 *   attempt fencing counter (stale workers' unit/finalize writes stop
 *   matching). The RESUMED run's own stored window governs unit planning.
 * - No overlapping run: verifies the trigger fingerprint against the CURRENT
 *   connection row, then inserts the run (claim fields coalesce on races). */
export async function claimRun(
  input: GoogleAdsSyncClaimInput,
): Promise<GoogleAdsClaimOutcome> {
  const scope = googleAdsUnitScopeSchema.parse(input.scope);
  if (
    !isGoogleAdsIsoDate(input.window.startDate) ||
    !isGoogleAdsIsoDate(input.window.endDate)
  ) {
    throw new Error("Expected ISO YYYY-MM-DD sync window dates");
  }
  if (input.window.startDate > input.window.endDate) {
    throw new Error("Sync window start date must not be after the end date");
  }
  if (
    input.scheduledSlot !== null &&
    !isGoogleAdsIsoInstant(input.scheduledSlot)
  ) {
    throw new Error("Expected an ISO instant for the scheduled slot");
  }
  if (!(["scheduled", "manual", "backfill"] as const).includes(input.mode)) {
    throw new Error("Expected a bounded Google Ads sync mode");
  }
  const leaseSeconds = Math.max(60, input.leaseSeconds ?? 900);
  const runKey = composeRunKey({
    windowStartDate: input.window.startDate,
    windowEndDate: input.window.endDate,
    mode: input.mode,
    scheduledSlot: input.scheduledSlot,
    fingerprint: input.fingerprint,
  });

  const run = await findOverlappingActiveRun(scope, input.window);
  const fence = await verifyConnectionFingerprint(scope, input.fingerprint);
  if (!fence.ok) {
    if (run) {
      await markRunFenced(run, fence.reason);
      const fresh = await db
        .select()
        .from(googleAdsSyncRuns)
        .where(eq(googleAdsSyncRuns.id, run.id))
        .limit(1);
      return { outcome: fence.reason, run: fresh[0] ?? run };
    }
    return { outcome: fence.reason, run: null };
  }

  if (run && isLeaseActive(run.leaseExpiresAt)) {
    return { outcome: "coalesced", run };
  }
  if (run) {
    const lease = leaseFromNow(leaseSeconds);
    const resumedRows = await db
      .update(googleAdsSyncRuns)
      .set({
        attempt: sql`${googleAdsSyncRuns.attempt} + 1`,
        leaseExpiresAt: lease,
        heartbeatAt: nowIso(),
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(googleAdsSyncRuns.id, run.id),
          eq(googleAdsSyncRuns.attempt, run.attempt),
          inArray(googleAdsSyncRuns.status, ["pending", "running"]),
          lte(googleAdsSyncRuns.leaseExpiresAt, nowIso()),
        ),
      )
      .returning();
    if (resumedRows.length === 0) {
      // A concurrent worker resumed it first: treat as coalesce.
      const claimed = await findOverlappingActiveRun(scope, input.window);
      return { outcome: "coalesced", run: claimed ?? run };
    }
    return {
      outcome: "resumed",
      run: resumedRows[0],
    };
  }

  const createdRows = await db
    .insert(googleAdsSyncRuns)
    .values(insertClaimRunValues(input, runKey, leaseSeconds))
    .onConflictDoNothing()
    .returning();
  if (createdRows.length === 0) {
    // Concurrent trigger claimed the same identity first: coalesce.
    const claimed = await findOverlappingActiveRun(scope, input.window);
    return claimed
      ? { outcome: "coalesced", run: claimed }
      : { outcome: "connection_changed", run: null };
  }
  return {
    outcome: "created",
    run: createdRows[0],
  };
}

export async function renewLease(
  runId: string,
  attempt: number,
  leaseSeconds: number,
): Promise<boolean> {
  const updated = await db
    .update(googleAdsSyncRuns)
    .set({
      leaseExpiresAt: leaseFromNow(Math.max(60, leaseSeconds)),
      heartbeatAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, runId),
        eq(googleAdsSyncRuns.attempt, attempt),
        inArray(googleAdsSyncRuns.status, ["running"]),
      ),
    )
    .returning({ id: googleAdsSyncRuns.id });
  return updated.length > 0;
}

export async function isRunClaimCurrent(
  runId: string,
  attempt: number,
): Promise<boolean> {
  const rows = await db
    .select({
      status: googleAdsSyncRuns.status,
      attempt: googleAdsSyncRuns.attempt,
    })
    .from(googleAdsSyncRuns)
    .where(and(eq(googleAdsSyncRuns.id, runId)))
    .limit(1);
  const run = rows[0];
  return run?.status === "running" && run.attempt === attempt;
}

// ---------------------------------------------------------------------------
// Unit planning + recording
// ---------------------------------------------------------------------------

export type GoogleAdsPlanOutcome =
  | { outcome: "planned"; pendingUnits: GoogleAdsUnitPlan[] }
  | { outcome: "stale" };

/** Plans the date+grain units for a run (replay-safe): existing success_*
 *  units are never re-planned; the returned list is exactly what still
 *  needs work for the CURRENT attempt. This bump stays bounded via the
 *  executeInBatches chunk insert. */
export async function planUnits(
  runId: string,
  attempt: number,
  units: readonly GoogleAdsUnitPlan[],
): Promise<GoogleAdsPlanOutcome> {
  const current = await isRunClaimCurrent(runId, attempt);
  if (!current) return { outcome: "stale" };
  const run = (
    await db
      .select({
        id: googleAdsSyncRuns.id,
        projectId: googleAdsSyncRuns.projectId,
        customerId: googleAdsSyncRuns.customerId,
        organizationId: googleAdsSyncRuns.organizationId,
      })
      .from(googleAdsSyncRuns)
      .where(eq(googleAdsSyncRuns.id, runId))
      .limit(1)
  )[0];
  if (!run) return { outcome: "stale" };
  const values = units.map((unit) => ({
    id: crypto.randomUUID(),
    projectId: run.projectId,
    organizationId: run.organizationId,
    runId,
    customerId: run.customerId,
    date: unit.date,
    grain: unit.grain,
    status: "pending" as const,
    attempt: 0,
  }));
  if (values.length > 0) {
    await executeInBatches(values, (tx, value) =>
      tx
        .insert(googleAdsSyncUnits)
        .values(value)
        // Replay-safe: existing unit rows are never reset; recording results
        // happens through recordUnitResult only.
        .onConflictDoNothing(),
    );
  }
  const pendingRows = await db
    .select({
      date: googleAdsSyncUnits.date,
      grain: googleAdsSyncUnits.grain,
    })
    .from(googleAdsSyncUnits)
    .where(
      and(
        eq(googleAdsSyncUnits.runId, runId),
        eq(googleAdsSyncUnits.status, "pending"),
      ),
    );
  await db
    .update(googleAdsSyncRuns)
    .set({ unitsTotal: values.length, updatedAt: nowIso() })
    .where(
      and(
        eq(googleAdsSyncRuns.id, runId),
        eq(googleAdsSyncRuns.attempt, attempt),
      ),
    );
  return {
    outcome: "planned",
    // Units come from planUnits calls with bounded grains; the text column
    // always holds one of those enum values.
    pendingUnits: pendingRows.map((row) => ({
      date: row.date,
      grain: z.enum(GOOGLE_ADS_GRAINS).parse(row.grain),
    })),
  };
}

export type GoogleAdsUnitResultInput = {
  status: GoogleAdsSyncUnitStatus;
  errorClass?: string;
  errorMessage?: string;
};

export type GoogleAdsUnitRecordOutcome =
  | { outcome: "recorded" }
  | { outcome: "stale" };

/** Records a date+grain unit result scoped by runId + attempt: stale
 *  attempts (run resumed/fenced meanwhile) are no-ops. */
export async function recordUnitResult(
  runId: string,
  attempt: number,
  unit: GoogleAdsUnitPlan,
  result: GoogleAdsUnitResultInput,
): Promise<GoogleAdsUnitRecordOutcome> {
  const run = (
    await db
      .select({
        id: googleAdsSyncRuns.id,
        projectId: googleAdsSyncRuns.projectId,
        customerId: googleAdsSyncRuns.customerId,
        organizationId: googleAdsSyncRuns.organizationId,
      })
      .from(googleAdsSyncRuns)
      .where(
        and(
          eq(googleAdsSyncRuns.id, runId),
          eq(googleAdsSyncRuns.attempt, attempt),
          inArray(googleAdsSyncRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1)
  )[0];
  if (!run) return { outcome: "stale" };
  await db
    .insert(googleAdsSyncUnits)
    .values({
      id: crypto.randomUUID(),
      projectId: run.projectId,
      organizationId: run.organizationId,
      runId,
      customerId: run.customerId,
      date: unit.date,
      grain: unit.grain,
      status: result.status,
      attempt,
      errorClass: result.errorClass ?? null,
      errorMessage: result.errorMessage ?? null,
    })
    .onConflictDoUpdate({
      target: [
        googleAdsSyncUnits.runId,
        googleAdsSyncUnits.date,
        googleAdsSyncUnits.grain,
      ],
      set: {
        status: result.status,
        attempt,
        errorClass: result.errorClass ?? null,
        errorMessage: result.errorMessage ?? null,
        updatedAt: nowIso(),
      },
    });
  await db
    .update(googleAdsSyncRuns)
    .set({ heartbeatAt: nowIso(), updatedAt: nowIso() })
    .where(
      and(
        eq(googleAdsSyncRuns.id, runId),
        eq(googleAdsSyncRuns.attempt, attempt),
      ),
    );
  return { outcome: "recorded" };
}

// ---------------------------------------------------------------------------
// Finalization
// ---------------------------------------------------------------------------

export type GoogleAdsFinalizeOutcome =
  | {
      outcome: "finalized";
      status: GoogleAdsFinalizeStatus;
      unitsTotal: number;
      unitsSucceeded: number;
      unitsFailed: number;
    }
  | { outcome: "stale" };

type GoogleAdsFinalizeStatus = "success" | "partial" | "failed";

/** Finalizes the run by deriving status from the units ledger:
 *  all success_* -> success; some success + some failed/partial -> partial;
 *  none succeeded -> failed. Pending units count as failed. */
export async function finalizeRun(
  runId: string,
  attempt: number,
): Promise<GoogleAdsFinalizeOutcome> {
  const run = (
    await db
      .select()
      .from(googleAdsSyncRuns)
      .where(
        and(
          eq(googleAdsSyncRuns.id, runId),
          eq(googleAdsSyncRuns.attempt, attempt),
          inArray(googleAdsSyncRuns.status, ["pending", "running"]),
        ),
      )
      .limit(1)
  )[0];
  if (!run) return { outcome: "stale" };
  const counts = await db
    .select({
      status: googleAdsSyncUnits.status,
      count: sql<number>`count(*)`,
    })
    .from(googleAdsSyncUnits)
    .where(eq(googleAdsSyncUnits.runId, runId))
    .groupBy(googleAdsSyncUnits.status);
  let succeeded = 0;
  let failed = 0;
  let pending = 0;
  for (const countRow of counts) {
    if (
      countRow.status === "success_with_data" ||
      countRow.status === "success_zero_rows"
    ) {
      succeeded += countRow.count;
    } else if (countRow.status === "pending") {
      pending += countRow.count;
    } else {
      failed += countRow.count;
    }
  }
  const status: GoogleAdsFinalizeStatus =
    succeeded > 0
      ? failed > 0 || pending > 0
        ? "partial"
        : "success"
      : "failed";
  const updated = await db
    .update(googleAdsSyncRuns)
    .set({
      status,
      errorClass: status === "success" ? null : "INTERNAL",
      errorMessage:
        status === "success" ? null : "units incomplete at finalization",
      completedAt: nowIso(),
      unitsTotal: succeeded + failed + pending,
      unitsSucceeded: succeeded,
      unitsFailed: failed + pending,
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, runId),
        eq(googleAdsSyncRuns.attempt, attempt),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
      ),
    )
    .returning({ id: googleAdsSyncRuns.id });
  if (updated.length === 0) return { outcome: "stale" };
  return {
    outcome: "finalized",
    status,
    unitsTotal: succeeded + failed + pending,
    unitsSucceeded: succeeded,
    unitsFailed: failed + pending,
  };
}

/** Abandons the run with a bounded error class (used for internal failures,
 *  disconnects/policy breaches that are not unit-dependent). */
export async function abandonRun(
  runId: string,
  attempt: number,
  errorClass: string,
  errorMessage: string | null,
): Promise<{ outcome: "finalized" | "stale" }> {
  const status = requireErrorClass(errorClass);
  const updated = await db
    .update(googleAdsSyncRuns)
    .set({
      status: "failed",
      errorClass: status,
      errorMessage,
      completedAt: nowIso(),
      updatedAt: nowIso(),
    })
    .where(
      and(
        eq(googleAdsSyncRuns.id, runId),
        eq(googleAdsSyncRuns.attempt, attempt),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
      ),
    )
    .returning({ id: googleAdsSyncRuns.id });
  return updated.length > 0 ? { outcome: "finalized" } : { outcome: "stale" };
}

// ---------------------------------------------------------------------------
// Safe reads (strip fingerprints, grant ids, lease/heartbeat fields)
// ---------------------------------------------------------------------------

function toPublicRun(row: GoogleAdsSyncRunFull): GoogleAdsSyncRunPublic {
  return {
    id: row.id,
    projectId: row.projectId,
    customerId: row.customerId,
    runKey: row.runKey,
    mode: row.mode,
    windowStartDate: row.windowStartDate,
    windowEndDate: row.windowEndDate,
    scheduledSlot: row.scheduledSlot,
    attempt: row.attempt,
    status: row.status,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
    unitsTotal: row.unitsTotal,
    unitsSucceeded: row.unitsSucceeded,
    unitsFailed: row.unitsFailed,
    errorClass: row.errorClass,
    errorMessage: row.errorMessage,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export async function getRunHistory(
  scope: GoogleAdsUnitScope,
  options: { limit?: number } = {},
): Promise<GoogleAdsSyncRunPublic[]> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  const limit = Math.min(50, Math.max(1, options.limit ?? 25));
  const rows = await db
    .select()
    .from(googleAdsSyncRuns)
    .where(
      and(
        eq(googleAdsSyncRuns.projectId, s.projectId),
        eq(googleAdsSyncRuns.customerId, s.customerId),
        eq(googleAdsSyncRuns.organizationId, s.organizationId),
      ),
    )
    .orderBy(
      desc(googleAdsSyncRuns.createdAt),
      desc(googleAdsSyncRuns.startedAt),
    )
    .limit(limit);
  return rows.map(toPublicRun);
}

export async function getCurrentRun(
  scope: GoogleAdsUnitScope,
  runKey: string,
): Promise<GoogleAdsSyncRunPublic | null> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  const rows = await db
    .select()
    .from(googleAdsSyncRuns)
    .where(
      and(
        eq(googleAdsSyncRuns.projectId, s.projectId),
        eq(googleAdsSyncRuns.customerId, s.customerId),
        eq(googleAdsSyncRuns.organizationId, s.organizationId),
        eq(googleAdsSyncRuns.runKey, runKey),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
      ),
    )
    .limit(1);
  return rows[0] ? toPublicRun(rows[0]) : null;
}

export async function listRunUnits(
  scope: GoogleAdsUnitScope,
  runId: string,
): Promise<GoogleAdsSyncUnit[]> {
  const s = googleAdsUnitScopeSchema.parse(scope);
  const rows = await db
    .select()
    .from(googleAdsSyncUnits)
    .where(
      and(
        eq(googleAdsSyncUnits.runId, runId),
        eq(googleAdsSyncUnits.projectId, s.projectId),
        eq(googleAdsSyncUnits.customerId, s.customerId),
        eq(googleAdsSyncUnits.organizationId, s.organizationId),
      ),
    );
  return rows;
}

export const GoogleAdsSyncRepository = {
  claimRun,
  renewLease,
  isRunClaimCurrent,
  planUnits,
  recordUnitResult,
  finalizeRun,
  abandonRun,
  getRunHistory,
  getCurrentRun,
  listRunUnits,
};
