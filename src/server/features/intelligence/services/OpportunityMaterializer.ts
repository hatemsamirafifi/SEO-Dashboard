import { waitUntil } from "cloudflare:workers";
import { SCORE_VERSION } from "@/shared/opportunity-weights";
import {
  canonicalJson,
  confidenceBandOf,
  impactBandOf,
  PRIORITIES,
  priorityMatrix,
  stableHash,
  type Finding,
  type OpportunityPriority,
} from "@/shared/intelligence";
import { captureServerEvent } from "@/server/lib/posthog";
import { ArtifactStore } from "../repositories/ArtifactStore";
import {
  OpportunityRepository,
  type OpportunityRow,
} from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  OPPORTUNITY_TEMPLATES,
  decayConfidence,
  scoreImpact,
  type ImpactFactors,
} from "./opportunityTemplates";

/**
 * Stage-2 opportunity materializer (final-plan §§6/10). Input = the parsed
 * frozen artifact ONLY (+ active-opportunity rows for upsert targeting) — no
 * source-metric reads (import ban, tested). Every write is idempotent, so a
 * crash between stages resumes at `current_stage` without duplication.
 */

export const STALE_AFTER_MISSES = 3;

export type MaterializeStats = {
  created: number;
  updated: number;
  recurred: number;
  superseded: number;
  skipped: number;
  staleMarked: number;
};

function logicalKeyOf(finding: Finding): string {
  return `${finding.detectorKey}:${finding.entityKey}`;
}

async function evidenceHash(finding: Finding): Promise<string> {
  return stableHash(finding.evidence);
}

async function eventKey(
  occurrenceId: string,
  type: string,
  scanId: string,
  contentHash: string,
): Promise<string> {
  return stableHash(`${occurrenceId}|${type}|${scanId}|${contentHash}`);
}

async function contentHashOf(input: {
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceHash: string;
  status: string;
}): Promise<string> {
  return stableHash(input);
}

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

function factorsJson(factors: ImpactFactors): string {
  return canonicalJson({
    trafficPotential: factors.trafficPotential,
    proximity: factors.proximity,
    decline: factors.decline,
    businessIntent: factors.businessIntent,
    conversionSignal: factors.conversionSignal,
  });
}

async function recordEvent(input: {
  occurrenceId: string;
  type: string;
  scanId: string;
  contentHash: string;
  payload?: Record<string, string | number | boolean | null>;
}): Promise<void> {
  await OpportunityRepository.insertEventIgnoreConflict({
    id: crypto.randomUUID(),
    occurrenceId: input.occurrenceId,
    type: input.type,
    eventKey: await eventKey(
      input.occurrenceId,
      input.type,
      input.scanId,
      input.contentHash,
    ),
    scanId: input.scanId,
    payloadJson: input.payload ? canonicalJson(input.payload) : null,
  });
}

export type MaterializeOneResult =
  | { outcome: "created" | "updated" | "recurred" | "superseded"; id: string }
  | { outcome: "skipped"; reason: string };

/**
 * Materializes one frozen finding into the opportunity ledger. Race-safe:
 * INSERT … ON CONFLICT DO NOTHING, then SELECT the winner and apply the
 * idempotent in-place update.
 */
export async function materializeFinding(input: {
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
}): Promise<MaterializeOneResult> {
  const { finding, scanId, projectId, organizationId } = input;
  const template = OPPORTUNITY_TEMPLATES[finding.detectorKey];
  if (!template) {
    return { outcome: "skipped", reason: `no template: ${finding.detectorKey}` };
  }
  const logicalKey = logicalKeyOf(finding);
  const factors = template.factorsOf(finding);
  const impact = scoreImpact(factors);
  if (impact === null) {
    return { outcome: "skipped", reason: "empty impact factor set" };
  }
  let confidence: number;
  let confidenceInputs: Record<string, string | number | boolean>;
  if (finding.detectorKey === "content_decay") {
    const decayed = decayConfidence(finding);
    if (!decayed) {
      return { outcome: "skipped", reason: "decay volume floor" };
    }
    confidence = decayed.score ?? finding.confidenceScore;
    confidenceInputs = {
      coverage: decayed.inputs.coverage,
      volume: decayed.inputs.volume,
      magnitude: decayed.inputs.magnitude,
      persistence: decayed.inputs.persistence,
      rankSessionMoves: decayed.inputs.rankSessionMoves,
      entityConsistency: decayed.inputs.entityConsistency,
      truncationStatus: decayed.inputs.truncationStatus,
      agreement: decayed.inputs.agreement,
    };
  } else {
    confidence = finding.confidenceScore;
    confidenceInputs = {
      ...finding.evidence.confidenceInputs,
      detectorVersion: finding.detectorVersion,
    };
  }
  const priority = priorityMatrix(impactBandOf(impact), confidenceBandOf(confidence));
  const evidenceJson = canonicalJson(finding.evidence);
  const hash = await evidenceHash(finding);
  const now = nowIso();

  const active = await OpportunityRepository.findActiveByKey(
    projectId,
    logicalKey,
  );
  if (active && active.detectorVersion === finding.detectorVersion) {
    return updateInPlace({
      row: active,
      finding,
      scanId,
      template,
      impact,
      confidence,
      priority,
      evidenceJson,
      evidenceHash: hash,
      factors,
      confidenceInputs,
      now,
    });
  }
  if (active) {
    return supersede({
      row: active,
      finding,
      scanId,
      projectId,
      organizationId,
      template,
      impact,
      confidence,
      priority,
      evidenceJson,
      evidenceHash: hash,
      factors,
      confidenceInputs,
      now,
    });
  }
  const latest = await OpportunityRepository.findLatestByKey(
    projectId,
    logicalKey,
  );
  return createOccurrence({
    finding,
    scanId,
    projectId,
    organizationId,
    template,
    impact,
    confidence,
    priority,
    evidenceJson,
    evidenceHash: hash,
    factors,
    confidenceInputs,
    now,
    occurrenceNumber: (latest?.occurrenceNumber ?? 0) + 1,
    recurrenceOfId: latest?.id ?? null,
  });
}

async function updateInPlace(input: {
  row: OpportunityRow;
  finding: Finding;
  scanId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
}): Promise<MaterializeOneResult> {
  const { row, finding, scanId } = input;
  // Decisions come from the PRE-update row so replays are idempotent.
  const bandChanged =
    row.priority !== input.priority ||
    confidenceBandOf(row.confidenceScore) !==
      confidenceBandOf(input.confidence);
  const redetected =
    Date.parse(input.now) - Date.parse(row.lastDetectedAt) >= 86_400_000 ||
    bandChanged;
  const rescored =
    Math.abs(input.impact - row.impactScore) >= 10 || bandChanged;
  const evidenceChanged = input.evidenceJson !== row.evidenceJson;
  const wasStale = row.stale;

  await OpportunityRepository.updateById(row.id, {
    impactScore: input.impact,
    confidenceScore: input.confidence,
    priority: input.priority,
    title: input.template.title(finding),
    explanationFact: finding.explanationFact,
    recommendation: input.template.recommendation(finding),
    evidenceJson: input.evidenceJson,
    keyword: input.template.keywordOf(finding),
    page: input.template.pageOf(finding),
    sourceMetricsJson: canonicalJson(finding.evidence.metrics),
    sourcesJson: JSON.stringify(finding.evidence.sources),
    impactFactorsJson: factorsJson(input.factors),
    confidenceInputsJson: canonicalJson(input.confidenceInputs),
    lastSeenScanId: scanId,
    lastDetectedAt: input.now,
    consecutiveMisses: 0,
    stale: false,
    staleAt: null,
  });

  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: row.status,
  });
  if (redetected) {
    await recordEvent({
      occurrenceId: row.id,
      type: "redetected",
      scanId,
      contentHash: content,
    });
  }
  if (rescored) {
    await recordEvent({
      occurrenceId: row.id,
      type: "rescored",
      scanId,
      contentHash: content,
      payload: { impactScore: input.impact, confidenceScore: input.confidence },
    });
  }
  if (evidenceChanged) {
    await recordEvent({
      occurrenceId: row.id,
      type: "evidence_updated",
      scanId,
      contentHash: content,
    });
  }
  if (wasStale) {
    await recordEvent({
      occurrenceId: row.id,
      type: "stale_cleared",
      scanId,
      contentHash: content,
    });
  }
  return { outcome: "updated", id: row.id };
}

async function createOccurrence(input: {
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
  occurrenceNumber: number;
  recurrenceOfId: string | null;
}): Promise<MaterializeOneResult> {
  const { finding, scanId } = input;
  const id = crypto.randomUUID();
  await OpportunityRepository.insertIgnoreConflict({
    id,
    projectId: input.projectId,
    organizationId: input.organizationId,
    logicalKey: logicalKeyOf(finding),
    occurrenceNumber: input.occurrenceNumber,
    type: input.template.type,
    detectorKey: finding.detectorKey,
    detectorVersion: finding.detectorVersion,
    scoreVersion: SCORE_VERSION,
    status: "open",
    impactScore: input.impact,
    confidenceScore: input.confidence,
    priority: input.priority,
    title: input.template.title(finding),
    explanationFact: finding.explanationFact,
    recommendation: input.template.recommendation(finding),
    evidenceJson: input.evidenceJson,
    keyword: input.template.keywordOf(finding),
    page: input.template.pageOf(finding),
    sourceMetricsJson: canonicalJson(finding.evidence.metrics),
    sourcesJson: JSON.stringify(finding.evidence.sources),
    impactFactorsJson: factorsJson(input.factors),
    confidenceInputsJson: canonicalJson(input.confidenceInputs),
    lastSeenScanId: scanId,
    firstDetectedAt: input.now,
    lastDetectedAt: input.now,
    recurrenceOfId: input.recurrenceOfId,
  });
  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: "open",
  });
  await recordEvent({
    occurrenceId: id,
    type: "detected",
    scanId,
    contentHash: content,
  });
  if (input.recurrenceOfId) {
    await recordEvent({
      occurrenceId: id,
      type: "recurred",
      scanId,
      contentHash: content,
      payload: { recurrenceOfId: input.recurrenceOfId },
    });
    return { outcome: "recurred", id };
  }
  return { outcome: "created", id };
}

async function supersede(input: {
  row: OpportunityRow;
  finding: Finding;
  scanId: string;
  projectId: string;
  organizationId: string;
  template: (typeof OPPORTUNITY_TEMPLATES)[string];
  impact: number;
  confidence: number;
  priority: OpportunityPriority;
  evidenceJson: string;
  evidenceHash: string;
  factors: ImpactFactors;
  confidenceInputs: Record<string, string | number | boolean>;
  now: string;
}): Promise<MaterializeOneResult> {
  const created = await createOccurrence({
    ...input,
    occurrenceNumber: input.row.occurrenceNumber + 1,
    recurrenceOfId: null,
  });
  if (created.outcome !== "created") return created;
  const newId = created.id;
  await OpportunityRepository.updateById(input.row.id, {
    status: "dismissed",
    dismissedAt: input.now,
    dismissalReason: `detector version ${input.row.detectorVersion} → ${input.finding.detectorVersion}`,
    supersededById: newId,
  });
  const content = await contentHashOf({
    impact: input.impact,
    confidence: input.confidence,
    priority: input.priority,
    evidenceHash: input.evidenceHash,
    status: "dismissed",
  });
  await recordEvent({
    occurrenceId: input.row.id,
    type: "superseded",
    scanId: input.scanId,
    contentHash: content,
    payload: { supersededById: newId },
  });
  return { outcome: "superseded", id: newId };
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
  if (run.currentStage !== "materializing" || !run.manifestKey || !run.manifestHash) {
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
