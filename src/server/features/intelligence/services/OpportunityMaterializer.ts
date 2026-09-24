import { waitUntil } from "cloudflare:workers";
import {
  PRIORITIES,
  stableHash,
  type OpportunityPriority,
} from "@/shared/intelligence";
import { captureServerEvent } from "@/server/lib/posthog";
import { ArtifactStore } from "../repositories/ArtifactStore";
import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  contentHashOf,
  logicalKeyOf,
  materializeFinding,
  recordEvent,
  type MaterializeOneResult,
} from "./materializeFinding";

/**
 * Stage-2 run orchestration (final-plan §6): loads the frozen artifact,
 * materializes every finding, applies miss/stale tracking, and advances the
 * run to `composing`. Single-finding ops live in materializeFinding.ts.
 * Re-exported for compatibility with existing call sites and tests.
 */
export { materializeFinding, type MaterializeOneResult };

export const STALE_AFTER_MISSES = 3;

export type MaterializeStats = {
  created: number;
  updated: number;
  recurred: number;
  superseded: number;
  skipped: number;
  staleMarked: number;
};

function nowIso(): string {
  return new Date().toISOString();
}

function parseStagedIds(stageStateJson: string | null): string[] | null {
  if (!stageStateJson) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stageStateJson);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  if (!("materializedOpportunityIds" in parsed)) return null;
  const ids: unknown = parsed.materializedOpportunityIds;
  if (!Array.isArray(ids)) return null;
  const out: string[] = [];
  for (const id of ids) {
    if (typeof id !== "string") return null;
    out.push(id);
  }
  return out;
}

function isPriority(value: string): value is OpportunityPriority {
  return (PRIORITIES as readonly string[]).includes(value);
}

/**
 * Runs Stage 2 for one scan: loads the frozen artifact, materializes every
 * finding, applies miss/stale tracking over detectors that completed, then
 * advances the run to `composing` with the materialized IDs in
 * `stage_state_json` (Task 11 input). Fully idempotent — safe to resume.
 */
export async function materializeRun(input: { runId: string }): Promise<{
  runId: string;
  materializedIds: string[];
  stats: MaterializeStats;
}> {
  const run = await ScanLedgerRepository.getRun(input.runId);
  if (!run) throw new Error(`Intelligence run not found: ${input.runId}`);
  if (run.currentStage === "composing") {
    // Idempotent replay: Stage 2 already committed for this run (its IDs
    // are staged for Task 11). Report zero deltas, write nothing.
    const staged = parseStagedIds(run.stageStateJson);
    if (staged) {
      return {
        runId: run.id,
        materializedIds: staged,
        stats: {
          created: 0,
          updated: 0,
          recurred: 0,
          superseded: 0,
          skipped: 0,
          staleMarked: 0,
        },
      };
    }
  }
  if (
    run.currentStage !== "materializing" ||
    !run.manifestKey ||
    !run.manifestHash
  ) {
    throw new Error(
      `Run ${input.runId} is not ready to materialize (stage ${run.currentStage})`,
    );
  }
  const { findings } = await ArtifactStore.loadArtifact(
    run.manifestKey,
    run.manifestHash,
  );
  const outcomes = await ScanLedgerRepository.getDetectorOutcomes(run.id);
  const completedDetectors = new Set(
    outcomes.filter((o) => o.status === "completed").map((o) => o.detectorKey),
  );

  const stats: MaterializeStats = {
    created: 0,
    updated: 0,
    recurred: 0,
    superseded: 0,
    skipped: 0,
    staleMarked: 0,
  };
  const materializedIds: string[] = [];
  const seenKeys = new Set<string>();
  for (const finding of findings) {
    seenKeys.add(logicalKeyOf(finding));
    const result = await materializeFinding({
      finding,
      scanId: run.id,
      projectId: run.projectId,
      organizationId: run.organizationId,
    });
    if (result.outcome === "skipped") {
      stats.skipped += 1;
      continue;
    }
    stats[result.outcome] += 1;
    materializedIds.push(result.id);
  }

  // Miss/stale pass: only detectors that completed count. Skipped/failed
  // detectors leave their opportunities untouched (never a miss).
  const active = await OpportunityRepository.listActiveByProject(run.projectId);
  for (const row of active) {
    if (seenKeys.has(row.logicalKey)) continue;
    if (!completedDetectors.has(row.detectorKey)) continue;
    const misses = row.consecutiveMisses + 1;
    if (!isPriority(row.priority)) {
      throw new Error(`Invalid stored priority: ${row.priority}`);
    }
    if (misses >= STALE_AFTER_MISSES && !row.stale) {
      await OpportunityRepository.updateById(row.id, {
        consecutiveMisses: misses,
        stale: true,
        staleAt: nowIso(),
      });
      await recordEvent({
        occurrenceId: row.id,
        type: "stale_marked",
        scanId: run.id,
        contentHash: await contentHashOf({
          impact: row.impactScore,
          confidence: row.confidenceScore,
          priority: row.priority,
          evidenceHash: await stableHash(row.evidenceJson),
          status: row.status,
        }),
      });
      stats.staleMarked += 1;
    } else {
      await OpportunityRepository.updateById(row.id, {
        consecutiveMisses: misses,
      });
    }
  }

  await ScanLedgerRepository.completeMaterializeStage({
    id: run.id,
    opportunityIds: materializedIds,
  });
  console.log(
    `[intelligence:materialize] run=${run.id} ` +
      `created=${stats.created} updated=${stats.updated} ` +
      `recurred=${stats.recurred} superseded=${stats.superseded} ` +
      `skipped=${stats.skipped} stale=${stats.staleMarked}`,
  );
  waitUntil(
    captureServerEvent({
      distinctId: run.organizationId,
      event: "opportunity:materialize",
      organizationId: run.organizationId,
      properties: {
        project_id: run.projectId,
        run_id: run.id,
        ...stats,
      },
    }),
  );
  return { runId: run.id, materializedIds, stats };
}

export const OpportunityMaterializer = {
  materializeRun,
  materializeFinding,
};
