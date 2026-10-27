import { and, desc, eq, inArray, isNotNull } from "drizzle-orm";
import { db } from "@/db";
import {
  aiSearchRuns,
  audits,
  backlinkSnapshots,
  ga4Connections,
  ga4Syncs,
  googleAdsConnections,
  googleAdsSyncRuns,
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
  "ai_search",
  "google_ads",
] as const;
export type IntelligenceSource = (typeof INTELLIGENCE_SOURCES)[number];

/**
 * Additive variant (master plan phase 5): `google_ads` is required whenever
 * `assembleDetectionSourceState` builds the record, but stays OPTIONAL in the
 * type so pre-Ads consumers (stored Reports/Autopilot state fixtures) keep
 * compiling and hash-reading unchanged — a missing key is never a Google Ads
 * token. Sequence numbers identify run order in the canonical list above;
 * hashes only ever see sourceSet + versions content.
 */
type PreAdsSource = Exclude<IntelligenceSource, "google_ads">;
export type SourceVersions = Record<PreAdsSource, string | null> & {
  google_ads?: string | null;
};

export type ActiveMutation = {
  isMutating: boolean;
  activeRunIds: string[];
};

export type ActiveMutations = Record<PreAdsSource, ActiveMutation> & {
  google_ads?: ActiveMutation;
};

export type DetectionSourceState = {
  versions: SourceVersions;
  /** Sorted; connect/disconnect (null↔non-null flips) changes identity. */
  sourceSet: IntelligenceSource[];
  detectorVersions: Record<string, number>;
  thresholdVersion: number;
  activeMutations: ActiveMutations;
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
    if (
      run &&
      (best === null || (run.completedAt ?? "") > (best.completedAt ?? ""))
    ) {
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
      if ((run.status as string) === "partial" && run.completedAt) {
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
    .toSorted((a, b) =>
      (a.completedAt ?? "") < (b.completedAt ?? "") ? 1 : -1,
    );
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

/** AI search (spec 020): latest recorded observation (observed_at DESC,
 *  id DESC tiebreak) — the newest committed consumable mutation. */
async function selectAiSearchVersion(projectId: string): Promise<string | null> {
  const rows = await db
    .select({ id: aiSearchRuns.id, observedAt: aiSearchRuns.observedAt })
    .from(aiSearchRuns)
    .where(eq(aiSearchRuns.projectId, projectId))
    .orderBy(desc(aiSearchRuns.observedAt), desc(aiSearchRuns.id))
    .limit(1);
  const run = rows[0];
  return run ? `ai_search:${run.id}` : null;
}

/**
 * Google Ads (master plan phase 5): the version token comes from the sync run
 * ledger, scoped to the project's CURRENTLY selected customer id. A run
 * qualifies only when it finalized at least one unit (`units_succeeded > 0`
 * and a non-null `completed_at`); zero-success and unfinalized runs never
 * advance the token. Ordered by completed_at DESC with a deterministic id
 * DESC tiebreak. No connection row → no token (never a synthetic empty run).
 */
async function selectGoogleAdsVersion(
  projectId: string,
): Promise<string | null> {
  const connections = await db
    .select({ customerId: googleAdsConnections.customerId })
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId))
    .limit(2);
  const connection = connections[0];
  if (!connection) return null;
  const rows = await db
    .select({
      id: googleAdsSyncRuns.id,
      completedAt: googleAdsSyncRuns.completedAt,
      unitsSucceeded: googleAdsSyncRuns.unitsSucceeded,
    })
    .from(googleAdsSyncRuns)
    .where(
      and(
        eq(googleAdsSyncRuns.projectId, projectId),
        eq(googleAdsSyncRuns.customerId, connection.customerId),
        isNotNull(googleAdsSyncRuns.completedAt),
      ),
    )
    .orderBy(desc(googleAdsSyncRuns.completedAt), desc(googleAdsSyncRuns.id))
    .limit(25);
  return rows.find((row) => (row.unitsSucceeded ?? 0) > 0)?.id ?? null;
}

/**
 * Google Ads active mutation: pending/running runs for the project's
 * connected customer id only (runs for a customer the project no longer has
 * selected must not gate the detect stage).
 */
async function selectGoogleAdsMutation(
  projectId: string,
): Promise<ActiveMutation> {
  const connections = await db
    .select({ customerId: googleAdsConnections.customerId })
    .from(googleAdsConnections)
    .where(eq(googleAdsConnections.projectId, projectId))
    .limit(2);
  const connection = connections[0];
  if (!connection) return { isMutating: false, activeRunIds: [] };
  const rows = await db
    .select({ id: googleAdsSyncRuns.id })
    .from(googleAdsSyncRuns)
    .where(
      and(
        eq(googleAdsSyncRuns.projectId, projectId),
        eq(googleAdsSyncRuns.customerId, connection.customerId),
        inArray(googleAdsSyncRuns.status, ["pending", "running"]),
      ),
    )
    .limit(5);
  return {
    isMutating: rows.length > 0,
    activeRunIds: rows.map((row) => row.id),
  };
}
}

async function selectActiveMutations(
  projectId: string,
  auditActiveRunIds: string[],
): Promise<ActiveMutations> {
  const [gscActive, ga4Active, rankActive, googleAdsActive] = await Promise.all(
    [
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
      selectGoogleAdsMutation(projectId),
    ],
  );
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
    // Backlink snapshots and AI-search observations are synchronous writes
    // with no in-flight marker; the before/after version comparison is the
    // mutation signal.
    backlinks: { isMutating: false, activeRunIds: [] },
    ai_search: { isMutating: false, activeRunIds: [] },
    google_ads: googleAdsActive,
  };
}

export async function assembleDetectionSourceState(
  projectId: string,
): Promise<DetectionSourceState> {
  const [gsc, ga4, rank, audit, backlinks, aiSearch, googleAds] = await Promise.all([
    selectGscVersion(projectId),
    selectGa4Version(projectId),
    selectRankVersion(projectId),
    selectAuditVersion(projectId),
    selectBacklinksVersion(projectId),
    selectAiSearchVersion(projectId),
    selectGoogleAdsVersion(projectId),
  ]);
  const versions: SourceVersions = {
    gsc,
    ga4,
    rank,
    audit: audit.version,
    backlinks,
    ai_search: aiSearch,
    google_ads: googleAds,
  };
  // Canonical order (sorted): connect/disconnect flips change identity via
  // the hashed sourceSet, never via insertion order.
  const sourceSet = INTELLIGENCE_SOURCES.filter(
    // Loose !=: a pre-Ads state may literally omit the google_ads key.
    (source) => versions[source] != null,
  ).toSorted((a, b) => (a < b ? -1 : 1));
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
  return INTELLIGENCE_SOURCES.some(
    (source) => state.activeMutations[source]?.isMutating ?? false,
  );
}

export function describeActiveMutations(state: DetectionSourceState): string[] {
  return INTELLIGENCE_SOURCES.filter(
    (source) => state.activeMutations[source]?.isMutating ?? false,
  ).map(
    (source) =>
      `${source}:${state.activeMutations[source]?.activeRunIds.join(",")}`,
  );
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
  selectAiSearchVersion,
  selectGoogleAdsVersion,
  selectGoogleAdsMutation,
};

export type { DetectionSourceState as SourceState };
