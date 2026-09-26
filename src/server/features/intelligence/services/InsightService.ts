import { stableHash } from "@/shared/intelligence";
import { AppError } from "@/server/lib/errors";
import {
  InsightRepository,
  type InsightRow,
} from "../repositories/InsightRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";

/**
 * Dashboard insight read model (final-plan §11). Reads stored rows plus
 * per-user prefs; never triggers scans, never reads source metrics.
 * Dismissal hides by version (bumps re-surface) or by active snooze.
 */

export const INSIGHT_STALE_AFTER_MS = 24 * 60 * 60 * 1000;

export type DashboardInsightView = InsightRow & {
  /** Dismissed an older version — resurfaced with an "updated" badge. */
  updatedSinceDismiss: boolean;
  findingKeys: string[];
  opportunityIds: string[];
  entityRefs: string[];
  sources: string[];
};

function parseStringList(json: string | null): string[] {
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const out: string[] = [];
  for (const entry of parsed) {
    if (typeof entry === "string") out.push(entry);
  }
  return out;
}

export type DashboardBanner = {
  skipped: Array<{ detectorKey: string; reason: string | null }>;
  failed: Array<{ detectorKey: string; error: string | null }>;
  lastCompletedAt: string | null;
  hasSuccessfulScan: boolean;
  /** No successful scan within 24h (age threshold). */
  stale: boolean;
  ga4Connected: boolean;
};

function isSnoozed(snoozedUntil: string | null, now: number): boolean {
  if (!snoozedUntil) return false;
  const ms = Date.parse(snoozedUntil);
  return Number.isFinite(ms) && ms > now;
}

export async function getDashboardInsights(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  ga4Connected: boolean;
}): Promise<{
  insights: DashboardInsightView[];
  dismissedCount: number;
  banner: DashboardBanner;
}> {
  const now = Date.now();
  const [rows, prefs] = await Promise.all([
    InsightRepository.listVisibleByProject(input.projectId),
    InsightRepository.listPreferencesByProject(input.userId, input.projectId),
  ]);
  const prefByKey = new Map(prefs.map((pref) => [pref.insightKey, pref]));
  const insights: DashboardInsightView[] = [];
  let dismissedCount = 0;
  for (const row of rows) {
    const pref = prefByKey.get(row.insightKey);
    const dismissedVersion = pref?.dismissedContentVersion ?? 0;
    const snoozed = isSnoozed(pref?.snoozedUntil ?? null, now);
    if (dismissedVersion >= row.contentVersion || snoozed) {
      dismissedCount += 1;
      continue;
    }
    insights.push({
      ...row,
      updatedSinceDismiss:
        dismissedVersion > 0 && dismissedVersion < row.contentVersion,
      findingKeys: parseStringList(row.findingKeysJson),
      opportunityIds: parseStringList(row.opportunityIdsJson),
      entityRefs: parseStringList(row.entityRefsJson),
      sources: parseStringList(row.sourcesJson),
    });
  }

  const latest = await ScanLedgerRepository.getLatestRun(input.projectId);
  const outcomes = latest
    ? await ScanLedgerRepository.getDetectorOutcomes(latest.id)
    : [];
  const lastSuccess = await ScanLedgerRepository.getLatestSuccessfulRun(
    input.projectId,
  );
  const lastCompletedAt = lastSuccess?.completedAt ?? null;
  return {
    insights,
    dismissedCount,
    banner: {
      skipped: outcomes
        .filter((o) => o.status === "skipped")
        .map((o) => ({ detectorKey: o.detectorKey, reason: o.skipReason })),
      failed: outcomes
        .filter((o) => o.status === "failed")
        .map((o) => ({ detectorKey: o.detectorKey, error: o.error })),
      lastCompletedAt,
      hasSuccessfulScan: lastCompletedAt !== null,
      stale:
        !lastCompletedAt ||
        now - Date.parse(lastCompletedAt) > INSIGHT_STALE_AFTER_MS,
      ga4Connected: input.ga4Connected,
    },
  };
}

export async function dismissInsight(input: {
  projectId: string;
  organizationId: string;
  userId: string;
  insightKey: string;
  snoozedUntil?: string | null;
}): Promise<{ ok: true }> {
  const row = await InsightRepository.findByKey(
    input.projectId,
    input.insightKey,
  );
  if (!row || row.resolvedAt) {
    throw new AppError("NOT_FOUND", "Insight not found");
  }
  const snoozedUntil = input.snoozedUntil ?? null;
  if (snoozedUntil !== null) {
    const ms = Date.parse(snoozedUntil);
    if (!Number.isFinite(ms)) {
      throw new AppError("VALIDATION_ERROR", "Invalid snooze date");
    }
  }
  const hash = await stableHash({
    userId: input.userId,
    projectId: input.projectId,
    insightKey: input.insightKey,
    dismissedContentVersion: row.contentVersion,
    snoozedUntil,
  });
  await InsightRepository.upsertPreference({
    userId: input.userId,
    projectId: input.projectId,
    insightKey: input.insightKey,
    dismissedContentVersion: row.contentVersion,
    snoozedUntil,
    hash,
  });
  return { ok: true };
}

export const InsightService = {
  getDashboardInsights,
  dismissInsight,
};
