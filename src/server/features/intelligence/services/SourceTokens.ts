import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  audits,
  backlinkSnapshots,
  ga4Connections,
  ga4Syncs,
  gscSearchPerformanceSyncs,
  rankCheckRuns,
  rankSnapshots,
  rankTrackingConfigs,
} from "@/db/schema";
import { Ga4SyncRepository } from "@/server/features/ga4/repositories/Ga4SyncRepository";
import { GscSearchPerformanceRepository } from "@/server/features/gsc/repositories/GscSearchPerformanceRepository";
import { stableHash } from "@/shared/intelligence";
import { detectorVersions } from "../detectors/registry";
import { THRESHOLD_VERSION } from "@/shared/intelligence-thresholds";

/**
 * Source version tokens (final-plan §7). Governing rule: versions represent
 * the latest committed consumable data mutation — not "latest completed run".
 * Partial runs that finalize valid units advance the token; zero-success runs
 * never do. Timestamps order; IDs identify (never lexical MAX(id)).
 */

export const INTELLIGENCE_SOURCES = [
  "gsc",
  "ga4",
  "rank",
  "audit",
  "backlinks",
] as const;
export type IntelligenceSource = (typeof INTELLIGENCE_SOURCES)[number];

export type SourceVersions = Record<IntelligenceSource, string | null>;

export type ActiveMutation = {
  isMutating: boolean;
  activeRunIds: string[];
};

export type DetectionSourceState = {
  versions: SourceVersions;
  /** Sorted; connect/disconnect (null↔non-null flips) changes identity. */
  sourceSet: IntelligenceSource[];
  detectorVersions: Record<string, number>;
  thresholdVersion: number;
  activeMutations: Record<IntelligenceSource, ActiveMutation>;
};

/** GSC: latest run finalizing ≥1 unit (successful_units > 0), newest first. */
async function selectGscVersion(projectId: string): Promise<string | null> {
  const rows = await db
    .select({
      id: gscSearchPerformanceSyncs.id,
      completedAt: gscSearchPerformanceSyncs.completedAt,
      successfulUnits: gscSearchPerformanceSyncs.successfulUnits,
    })
    .from(gscSearchPerformanceSyncs)
    .where(
      and(
        eq(gscSearchPerformanceSyncs.projectId, projectId),
        isNotNull(gscSearchPerformanceSyncs.completedAt),
      ),
    )
    .orderBy(desc(gscSearchPerformanceSyncs.completedAt))
    .limit(25);
  return rows.find((row) => (row.successfulUnits ?? 0) > 0)?.id ?? null;
}

/** GA4: reuses the Task 3 §7 selector (latest run with successful_units > 0).
 *  The property dimension is handled by scanning every connection property. */
async function selectGa4Version(projectId: string): Promise<string | null> {
  const connections = await db
    .select({
      propertyId: ga4Connections.propertyId,
      organizationId: ga4Connections.organizationId,
    })
    .from(ga4Connections)
    .where(eq(ga4Connections.projectId, projectId));
  let best: { id: string; completedAt: string | null } | null = null;
  for (const connection of connections) {
    const run = await Ga4SyncRepository.getLatestSuccessfulRun(
      projectId,
      connection.propertyId,
    );
    if (run && (best === null || (run.completedAt ?? "") > (best.completedAt ?? ""))) {
      best = { id: run.id, completedAt: run.completedAt };
    }
  }
  return best?.id ?? null;
}

/**
 * Rank: per config, the latest qualifying run (completed, or partial WITH
 * committed snapshots — partial runs persist per-batch snapshots), newest
 * first; canonical-sort by configId; token = stableHash(array).
 */
async function selectRankVersion(projectId: string): Promise<string | null> {
  const configs = await db
    .select({ configId: rankTrackingConfigs.id })
    .from(rankTrackingConfigs)
    .where(eq(rankTrackingConfigs.projectId, projectId));
  if (configs.length === 0) return null;

  const entries: Array<{
    configId: string;
    runId: string;
    completedAt: string;
  }> = [];
  for (const config of configs) {
    const runs = await db
      .select({
        runId: rankCheckRuns.id,
        status: rankCheckRuns.status,
        completedAt: rankCheckRuns.completedAt,
      })
      .from(rankCheckRuns)
      .where(
        and(
          eq(rankCheckRuns.configId, config.configId),
          isNotNull(rankCheckRuns.completedAt),
        ),
      )
      .orderBy(desc(rankCheckRuns.completedAt))
      .limit(10);
    for (const run of runs) {
      if (run.status === "completed" && run.completedAt) {
        entries.push({
          configId: config.configId,
          runId: run.runId,
          completedAt: run.completedAt,
        });
        break;
      }
      if (run.status === "partial" && run.completedAt) {
        const snapshots = await db
          .select({ id: rankSnapshots.id })
          .from(rankSnapshots)
          .where(eq(rankSnapshots.runId, run.runId))
          .limit(1);
        if (snapshots.length > 0) {
          entries.push({
            configId: config.configId,
            runId: run.runId,
            completedAt: run.completedAt,
          });
          break;
        }
      }
    }
  }
  if (entries.length === 0) return null;
  entries.sort((a, b) => (a.configId < b.configId ? -1 : 1));
  return stableHash(entries);
}

/** Audit: latest COMPLETED audit only (partial crawls would distort joins);
 *  running/failed runs feed `active` only. */
async function selectAuditVersion(
  projectId: string,
): Promise<{ version: string | null; activeRunIds: string[] }> {
  const rows = await db
    .select({
      id: audits.id,
      status: audits.status,
      completedAt: audits.completedAt,
    })
    .from(audits)
    .where(eq(audits.projectId, projectId))
    .orderBy(desc(audits.startedAt))
    .limit(25);
  const activeRunIds = rows
    .filter((row) => row.status === "running")
    .map((row) => row.id);
  const completed = rows
    .filter((row) => row.status === "completed" && row.completedAt !== null)
    .sort((a, b) => ((a.completedAt ?? "") < (b.completedAt ?? "") ? 1 : -1));
  return { version: completed[0]?.id ?? null, activeRunIds };
}

/** Backlinks: latest committed snapshot (captured_at DESC, id DESC tiebreak). */
async function selectBacklinksVersion(
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({
      id: backlinkSnapshots.id,
      capturedAt: backlinkSnapshots.capturedAt,
    })
    .from(backlinkSnapshots)
    .where(eq(backlinkSnapshots.projectId, projectId))
    .orderBy(desc(backlinkSnapshots.capturedAt), desc(backlinkSnapshots.id))
    .limit(1);
  const snapshot = rows[0];
  return snapshot ? `backlinks:${snapshot.id}` : null;
}

async function selectActiveMutations(
  projectId: string,
  auditActiveRunIds: string[],
): Promise<Record<IntelligenceSource, ActiveMutation>> {
  const [gscActive, ga4Active, rankActive] = await Promise.all([
    GscSearchPerformanceRepository.getActiveSyncRun(projectId),
    db
      .select({ id: ga4Syncs.id })
      .from(ga4Syncs)
      .where(
        and(
          eq(ga4Syncs.projectId, projectId),
          inArray(ga4Syncs.status, ["pending", "running"]),
        ),
      )
      .limit(5),
    db
      .select({ id: rankCheckRuns.id })
      .from(rankCheckRuns)
      .where(
        and(
          eq(rankCheckRuns.projectId, projectId),
          inArray(rankCheckRuns.status, ["pending", "running"]),
        ),
      )
      .limit(5),
  ]);
  return {
    gsc: {
      isMutating: gscActive !== null,
      activeRunIds: gscActive ? [gscActive.id] : [],
    },
    ga4: {
      isMutating: ga4Active.length > 0,
      activeRunIds: ga4Active.map((row) => row.id),
    },
    rank: {
      isMutating: rankActive.length > 0,
      activeRunIds: rankActive.map((row) => row.id),
    },
    audit: {
      isMutating: auditActiveRunIds.length > 0,
      activeRunIds: auditActiveRunIds,
    },
    // Backlink snapshots are synchronous writes with no in-flight marker;
    // the before/after version comparison is the mutation signal.
    backlinks: { isMutating: false, activeRunIds: [] },
  };
}

export async function assembleDetectionSourceState(
  projectId: string,
): Promise<DetectionSourceState> {
  const [gsc, ga4, rank, audit, backlinks] = await Promise.all([
    selectGscVersion(projectId),
    selectGa4Version(projectId),
    selectRankVersion(projectId),
    selectAuditVersion(projectId),
    selectBacklinksVersion(projectId),
  ]);
  const versions: SourceVersions = {
    gsc,
    ga4,
    rank,
    audit: audit.version,
    backlinks,
  };
  const sourceSet = (Object.entries(versions) as Array<
    [IntelligenceSource, string | null]
  >)
    .filter(([, version]) => version !== null)
    .map(([source]) => source)
    .sort();
  const activeMutations = await selectActiveMutations(
    projectId,
    audit.activeRunIds,
  );
  return {
    versions,
    sourceSet,
    detectorVersions: detectorVersions(),
    thresholdVersion: THRESHOLD_VERSION,
    activeMutations,
  };
}

/**
 * Accepted input hash: stableHash over versions + sourceSet + detector and
 * threshold versions. Active run ids are logged on retries, never hashed.
 */
export async function hashSourceState(
  state: Pick<
    DetectionSourceState,
    "versions" | "sourceSet" | "detectorVersions" | "thresholdVersion"
  >,
): Promise<string> {
  return stableHash({
    versions: state.versions,
    sourceSet: state.sourceSet,
    detectorVersions: state.detectorVersions,
    thresholdVersion: state.thresholdVersion,
  });
}

export function hasActiveMutations(state: DetectionSourceState): boolean {
  return Object.values(state.activeMutations).some(
    (mutation) => mutation.isMutating,
  );
}

export function describeActiveMutations(state: DetectionSourceState): string[] {
  return (Object.entries(state.activeMutations) as Array<
    [IntelligenceSource, ActiveMutation]
  >)
    .filter(([, mutation]) => mutation.isMutating)
    .map(([source, mutation]) => `${source}:${mutation.activeRunIds.join(",")}`);
}

export const SourceTokens = {
  assembleDetectionSourceState,
  hashSourceState,
  hasActiveMutations,
  describeActiveMutations,
  selectGscVersion,
  selectGa4Version,
  selectRankVersion,
  selectAuditVersion,
  selectBacklinksVersion,
};

export type { DetectionSourceState as SourceState };
