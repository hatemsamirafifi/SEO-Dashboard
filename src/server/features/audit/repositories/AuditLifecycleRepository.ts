/**
 * Audit row lifecycle: creation, progress, cancellation, and the terminal
 * transitions (finalize / fail). Split from AuditRepository so the audit
 * row's state machine lives in one place next to the counters it writes.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/db";
import { audits, auditPages } from "@/db/schema";
import {
  ZERO_URL_COUNTERS,
  type AuditUrlCounters,
  type FinalAuditStatus,
} from "@/server/lib/audit/finalize";
import type { AuditConfig } from "@/server/lib/audit/types";

async function createAudit(data: {
  id: string;
  projectId: string;
  startedByUserId: string;
  startUrl: string;
  workflowInstanceId: string;
  config: AuditConfig;
  pagesTotal: number;
  lighthouseTotal: number;
}) {
  await db.insert(audits).values({
    id: data.id,
    projectId: data.projectId,
    startedByUserId: data.startedByUserId,
    startUrl: data.startUrl,
    workflowInstanceId: data.workflowInstanceId,
    config: JSON.stringify(data.config),
    status: "running",
    pagesTotal: data.pagesTotal,
    lighthouseTotal: data.lighthouseTotal,
    currentPhase: "discovery",
  });
}

async function updateAuditProgress(
  auditId: string,
  workflowInstanceId: string,
  data: {
    pagesCrawled?: number;
    pagesTotal?: number;
    lighthouseTotal?: number;
    lighthouseCompleted?: number;
    lighthouseFailed?: number;
    currentPhase?: string;
  },
) {
  await db
    .update(audits)
    .set(data)
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
      ),
    );
}

/**
 * Terminal write for a finished crawl: counters land unconditionally (a
 * cancelled run keeps truthful metrics, D8), the status flip is guarded to
 * running rows so a user-cancelled audit is never overwritten by the
 * workflow's own finalize.
 */
async function finalizeAuditRun(
  auditId: string,
  workflowInstanceId: string,
  data: { status: FinalAuditStatus; counters: AuditUrlCounters },
) {
  await db
    .update(audits)
    .set({
      ...data.counters,
      completedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
      ),
    );

  await db
    .update(audits)
    .set({
      status: data.status,
      currentPhase: data.status === "cancelled" ? "cancelled" : "completed",
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        eq(audits.status, "running"),
      ),
    );
}

/**
 * Aggregate audit_pages into the finalize counters. The bucket mapping is
 * the normative partition from src/server/lib/audit/finalize.ts:
 * urls_fetched = urls_analyzed + urls_blocked + urls_failed + urls_skipped,
 * with rendering_required carved out of "ok" rows so the partition is exact.
 * Aggregated in SQL so counters always reconcile with the persisted rows.
 */
async function getAuditPageCounters(
  auditId: string,
): Promise<AuditUrlCounters> {
  const rows = await db
    .select({
      fetched: sql<number>`count(*)`,
      analyzed: sql<number>`sum(case when ${auditPages.fetchClass} = 'ok' then 1 else 0 end)`,
      blocked: sql<number>`sum(case when ${auditPages.fetchClass} = 'blocked' then 1 else 0 end)`,
      failed: sql<number>`sum(case when ${auditPages.fetchClass} = 'error' then 1 else 0 end)`,
      skipped: sql<number>`sum(case when ${auditPages.fetchClass} = 'rate_limited' then 1 else 0 end)`,
      renderingRequired: sql<number>`sum(case when ${auditPages.extractionState} = 'RENDERING_REQUIRED' then 1 else 0 end)`,
      extractionComplete: sql<number>`sum(case when ${auditPages.extractionState} = 'STATIC_COMPLETE' then 1 else 0 end)`,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));

  const row = rows[0] ?? null;
  if (!row) return ZERO_URL_COUNTERS;

  return {
    urlsDiscovered: toCount(row.fetched),
    urlsFetched: toCount(row.fetched),
    urlsAnalyzed: toCount(row.analyzed),
    urlsBlocked: toCount(row.blocked),
    urlsFailed: toCount(row.failed),
    urlsSkipped: toCount(row.skipped),
    urlsRenderingRequired: toCount(row.renderingRequired),
    urlsExtractionComplete: toCount(row.extractionComplete),
  };
}

function toCount(value: unknown): number {
  return value == null ? 0 : Number(value);
}

/**
 * Cooperative stop flag: the workflow reads this between batches (outside a
 * durable step so every replay sees a fresh answer). Between the DB write
 * here and the next crawl batch, nothing but the user's intent moves this
 * value off "running".
 */
async function getAuditCancelFlag(auditId: string): Promise<boolean> {
  const rows = await db
    .select({ status: audits.status })
    .from(audits)
    .where(eq(audits.id, auditId))
    .limit(1);
  const status = rows[0]?.status;
  return status === "cancelled";
}

/**
 * User-side cancellation. Only a running audit flips to cancelled; the
 * return tells the caller whether it captured the transition or raced a
 * terminal state.
 */
async function cancelAudit(
  auditId: string,
  projectId: string,
): Promise<boolean> {
  const rows = await db
    .update(audits)
    .set({
      status: "cancelled",
      currentPhase: "cancelled",
      completedAt: new Date().toISOString(),
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.projectId, projectId),
        eq(audits.status, "running"),
      ),
    )
    .returning({ id: audits.id });
  return rows.length > 0;
}

async function failAudit(auditId: string, workflowInstanceId: string) {
  // Only a running audit can transition to failed: the getStatus reconciler
  // races the workflow's own finalize, and without this guard it could flip
  // a just-completed audit to failed.
  await db
    .update(audits)
    .set({
      status: "failed",
      completedAt: new Date().toISOString(),
      currentPhase: "failed",
    })
    .where(
      and(
        eq(audits.id, auditId),
        eq(audits.workflowInstanceId, workflowInstanceId),
        eq(audits.status, "running"),
      ),
    );
}

async function getAuditForWorkflow(
  auditId: string,
  workflowInstanceId: string,
) {
  return db.query.audits.findFirst({
    where: and(
      eq(audits.id, auditId),
      eq(audits.workflowInstanceId, workflowInstanceId),
    ),
  });
}

export {
  cancelAudit,
  createAudit,
  failAudit,
  finalizeAuditRun,
  getAuditCancelFlag,
  getAuditForWorkflow,
  getAuditPageCounters,
  updateAuditProgress,
};
