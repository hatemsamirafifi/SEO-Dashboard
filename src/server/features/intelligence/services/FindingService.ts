import { waitUntil } from "cloudflare:workers";
import { captureServerEvent } from "@/server/lib/posthog";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import type { Finding } from "@/shared/intelligence";
import {
  ArtifactError,
  ArtifactStore,
  FINDINGS_SCHEMA_VERSION,
} from "../repositories/ArtifactStore";
import {
  ScanLedgerRepository,
  type IntelligenceRunRow,
} from "../repositories/ScanLedgerRepository";
import { runDetectionStage, type DetectorInputFetcher } from "./detectionStage";
import { fetchDetectorInput } from "../detectors/inputs";
import { OpportunityMaterializer } from "./OpportunityMaterializer";
import { InsightComposer } from "./InsightComposer";
import {
  SourceTokens,
  describeActiveMutations,
  hasActiveMutations,
  hashSourceState,
  type DetectionSourceState,
} from "./SourceTokens";

/**
 * Stage-1 detection service (final-plan §6). Owns the source-consistency
 * gate, single-shot detection, artifact freeze, and the park at
 * `materializing`. Stages 2–3 (materialize/compose) arrive in Tasks 8/11 and
 * read the frozen artifact only — never source repositories.
 */

export const DETECTION_MAX_RETRIES = 2;
export const SCAN_FLOOR_MS = 4 * 60 * 60 * 1000;
export const SCAN_FORCE_MS = 24 * 60 * 60 * 1000;
export const MANUAL_SCAN_LIMIT_MS = 15 * 60 * 1000;

export type TriggeredBy = "cron" | "manual";

export type ScanOutcome =
  | {
      ok: true;
      run: IntelligenceRunRow;
      inputHash: string;
      findingsCount: number;
    }
  | { ok: false; deferred: "active_mutation"; active: string[] }
  | { ok: false; deferred: false; run: IntelligenceRunRow };

export type ManualScanOutcome =
  | ScanOutcome
  | { ok: false; rateLimited: true; retryAfterMs: number };

function shortHash(hash: string): string {
  return hash.slice(0, 8);
}

function captureIntelligenceEvent(input: {
  event: string;
  projectId: string;
  organizationId: string;
  actorUserId?: string;
  properties?: Record<string, unknown>;
}): void {
  waitUntil(
    captureServerEvent({
      distinctId: input.actorUserId ?? input.organizationId,
      event: input.event,
      organizationId: input.organizationId,
      properties: { project_id: input.projectId, ...input.properties },
    }),
  );
}

function versionsEqual(
  first: DetectionSourceState,
  second: DetectionSourceState,
): boolean {
  const keys = ["gsc", "ga4", "rank", "audit", "backlinks"] as const;
  if (first.thresholdVersion !== second.thresholdVersion) return false;
  if (first.sourceSet.join(",") !== second.sourceSet.join(",")) return false;
  // Order-invariant without sorting: same key set, same per-key values.
  const firstKeys = Object.keys(first.detectorVersions);
  if (firstKeys.length !== Object.keys(second.detectorVersions).length) {
    return false;
  }
  if (
    !firstKeys.every(
      (key) => first.detectorVersions[key] === second.detectorVersions[key],
    )
  ) {
    return false;
  }
  return keys.every((key) => first.versions[key] === second.versions[key]);
}

function changedSources(
  before: DetectionSourceState,
  after: DetectionSourceState,
): string[] {
  const changed: string[] = [];
  const keys = ["gsc", "ga4", "rank", "audit", "backlinks"] as const;
  for (const key of keys) {
    if (before.versions[key] !== after.versions[key]) changed.push(key);
  }
  if (before.sourceSet.join(",") !== after.sourceSet.join(",")) {
    changed.push("sourceSet");
  }
  return changed;
}

export type DetectionAttemptMeta = {
  attempt: number;
  beforeHash8: string;
  afterHash8: string | null;
  changedSources: string[];
  activeReasons: string[];
};

async function executeDetection(input: {
  projectId: string;
  organizationId: string;
  run: IntelligenceRunRow;
  before: DetectionSourceState;
  actorUserId?: string;
  fetchInput?: DetectorInputFetcher;
}): Promise<ScanOutcome> {
  const attemptMeta: DetectionAttemptMeta[] = [];
  let accepted: DetectionSourceState | null = null;
  let findings: Finding[] = [];

  await ScanLedgerRepository.transitionStage({
    id: input.run.id,
    toStage: "detecting",
    toStatus: "detecting",
  });

  // Production default: the explicit per-detector input dispatcher. Tests
  // inject their own fetcher; unknown keys preserve the "no input fetcher"
  // skip path.
  const fetchInput: DetectorInputFetcher =
    input.fetchInput ??
    ((detectorKey, ctx) =>
      fetchDetectorInput(detectorKey, input.projectId, ctx));

  for (let attempt = 0; attempt <= DETECTION_MAX_RETRIES; attempt += 1) {
    const beforeHash = await hashSourceState(input.before);
    const stageFindings = await runDetectionStage({
      projectId: input.projectId,
      organizationId: input.organizationId,
      runId: input.run.id,
      state: input.before,
      fetchInput,
    });
    const after = await SourceTokens.assembleDetectionSourceState(
      input.projectId,
    );
    const afterHash = await hashSourceState(after);
    attemptMeta.push({
      attempt,
      beforeHash8: shortHash(beforeHash),
      afterHash8: shortHash(afterHash),
      changedSources: changedSources(input.before, after),
      activeReasons: describeActiveMutations(after),
    });
    if (versionsEqual(input.before, after)) {
      accepted = after;
      findings = stageFindings;
      break;
    }
    console.log(
      `[intelligence:scan] detection_retry project ${input.projectId} ` +
        `attempt=${attempt} H_before8=${shortHash(beforeHash)} ` +
        `H_after8=${shortHash(afterHash)} ` +
        `changed=${changedSources(input.before, after).join(",") || "none"} ` +
        `active=${describeActiveMutations(after).join(";") || "none"}`,
    );
    captureIntelligenceEvent({
      event: "intelligence:detection_retry",
      projectId: input.projectId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      properties: { attempt },
    });
    if (attempt < DETECTION_MAX_RETRIES) {
      // Re-detect against the fresh state: nothing is frozen yet, so no
      // artifact bytes exist to preserve. The loop re-reads versions via the
      // next iteration's `after` comparison base.
      input.before = after;
    }
  }

  if (!accepted) {
    const failed = await ScanLedgerRepository.failRun(input.run.id, {
      error: `SOURCE_CHANGED_DURING_DETECTION: sources kept changing across ${DETECTION_MAX_RETRIES + 1} attempts`,
      errorClass: "SOURCE_CHANGED_DURING_DETECTION",
      errorStage: "detecting",
    });
    captureIntelligenceEvent({
      event: "intelligence:detection_unstable",
      projectId: input.projectId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
    });
    return { ok: false, deferred: false, run: failed };
  }

  const inputHash = await hashSourceState(accepted);
  let pointers;
  try {
    pointers = await ArtifactStore.writeArtifact({
      projectId: input.projectId,
      runId: input.run.id,
      findings,
      inputHash,
      inputSourceVersions: accepted.versions,
      detectorVersions: accepted.detectorVersions,
      thresholdVersion: accepted.thresholdVersion,
    });
  } catch (error) {
    const errorClass =
      error instanceof ArtifactError ? error.errorClass : "ARTIFACT_CORRUPT";
    const failed = await ScanLedgerRepository.failRun(input.run.id, {
      error: `${errorClass}: ${error instanceof Error ? error.message : String(error)}`,
      errorClass,
      errorStage: "detecting",
    });
    captureIntelligenceEvent({
      event: "intelligence:artifact_corrupt",
      projectId: input.projectId,
      organizationId: input.organizationId,
      actorUserId: input.actorUserId,
      properties: { error_class: errorClass },
    });
    return { ok: false, deferred: false, run: failed };
  }

  const parked = await ScanLedgerRepository.commitStageOnePointer({
    id: input.run.id,
    inputHash,
    inputSourceVersionsJson: JSON.stringify(accepted.versions),
    detectorVersionsJson: JSON.stringify(accepted.detectorVersions),
    thresholdVersion: accepted.thresholdVersion,
    manifestKey: pointers.manifestKey,
    manifestHash: pointers.manifestHash,
    findingsSchemaVersion: FINDINGS_SCHEMA_VERSION,
    findingsCount: pointers.findingsCount,
    detectionAttemptMetaJson: JSON.stringify(attemptMeta),
  });
  console.log(
    `[intelligence:scan] detected project ${input.projectId} ` +
      `run=${input.run.id} H8=${shortHash(inputHash)} ` +
      `findings=${pointers.findingsCount} stage=materializing`,
  );
  captureIntelligenceEvent({
    event: "intelligence:scan",
    projectId: input.projectId,
    organizationId: input.organizationId,
    actorUserId: input.actorUserId,
    properties: {
      findings_count: pointers.findingsCount,
      input_hash8: shortHash(inputHash),
    },
  });

  // Stage 2 runs inline: the artifact is frozen, so materialization reads
  // R2 + opportunity rows only. A crash between the park above and the
  // advance below resumes at `materializing` (never re-detects).
  try {
    const materialized = await OpportunityMaterializer.materializeRun({
      runId: parked.id,
    });
    console.log(
      `[intelligence:scan] materialized project ${input.projectId} ` +
        `run=${input.run.id} opportunities=${materialized.materializedIds.length} ` +
        `stage=composing`,
    );
  } catch (error) {
    const failed = await ScanLedgerRepository.failRun(input.run.id, {
      error: `MATERIALIZE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      errorClass: "MATERIALIZE_FAILED",
      errorStage: "materializing",
    });
    return { ok: false, deferred: false, run: failed };
  }

  // Stage 3 runs inline: compose reads the artifact + live opportunity
  // linkage only. Terminal status lands here (completed, or partial when a
  // detector failed); crashes beforehand resume at `composing`.
  try {
    const composed = await InsightComposer.composeRun({ runId: parked.id });
    const terminal = await ScanLedgerRepository.getRun(parked.id);
    if (!terminal)
      throw new Error(`Intelligence run not found: ${parked.id}`);
    console.log(
      `[intelligence:scan] composed project ${input.projectId} ` +
        `run=${input.run.id} insights=${composed.insightKeys.length} ` +
        `status=${terminal.status}`,
    );
    return {
      ok: true,
      run: terminal,
      inputHash,
      findingsCount: pointers.findingsCount,
    };
  } catch (error) {
    const failed = await ScanLedgerRepository.failRun(input.run.id, {
      error: `COMPOSE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
      errorClass: "COMPOSE_FAILED",
      errorStage: "composing",
    });
    return { ok: false, deferred: false, run: failed };
  }
}

export async function runScan(input: {
  projectId: string;
  organizationId: string;
  triggeredBy: TriggeredBy;
  actorUserId?: string;
  fetchInput?: DetectorInputFetcher;
}): Promise<ScanOutcome> {
  const before = await SourceTokens.assembleDetectionSourceState(
    input.projectId,
  );
  if (input.triggeredBy === "cron" && hasActiveMutations(before)) {
    const active = describeActiveMutations(before);
    console.log(
      `[intelligence:scan] deferred_active_mutation project ${input.projectId} ` +
        `active=${active.join(";")}`,
    );
    return { ok: false, deferred: "active_mutation", active };
  }
  const run = await ScanLedgerRepository.createRun({
    projectId: input.projectId,
    organizationId: input.organizationId,
    triggeredBy: input.triggeredBy,
  });
  return executeDetection({
    projectId: input.projectId,
    organizationId: input.organizationId,
    run,
    before,
    actorUserId: input.actorUserId,
    fetchInput: input.fetchInput,
  });
}

/**
 * Resume a crashed run. Detecting without a manifest pointer means nothing
 * froze: re-run detection on the existing row. Materializing with a manifest
 * pointer re-runs ONLY Stage 2 from frozen bytes (idempotent upserts, never
 * re-detection). Composing with a manifest re-runs ONLY Stage 3 the same
 * way. Terminal runs are not resumed.
 */
export async function resumeScan(
  runId: string,
  options?: { fetchInput?: DetectorInputFetcher },
): Promise<
  ScanOutcome | { ok: false; deferred: true; reason: string; stage: string }
> {
  const run = await ScanLedgerRepository.getRun(runId);
  if (!run) throw new Error(`Intelligence run not found: ${runId}`);
  if (
    run.status === "completed" ||
    run.status === "partial" ||
    run.status === "failed"
  ) {
    return { ok: false, deferred: true, reason: "terminal", stage: run.status };
  }
  if (run.manifestKey !== null) {
    if (run.currentStage === "materializing") {
      try {
        await OpportunityMaterializer.materializeRun({ runId: run.id });
      } catch (error) {
        const failed = await ScanLedgerRepository.failRun(run.id, {
          error: `MATERIALIZE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
          errorClass: "MATERIALIZE_FAILED",
          errorStage: "materializing",
        });
        return { ok: false, deferred: false, run: failed };
      }
    } else if (run.currentStage !== "composing") {
      return {
        ok: false,
        deferred: true,
        reason: "frozen_artifact_owned_by_stage",
        stage: run.currentStage,
      };
    }
    try {
      await InsightComposer.composeRun({ runId: run.id });
    } catch (error) {
      const failed = await ScanLedgerRepository.failRun(run.id, {
        error: `COMPOSE_FAILED: ${error instanceof Error ? error.message : String(error)}`,
        errorClass: "COMPOSE_FAILED",
        errorStage: "composing",
      });
      return { ok: false, deferred: false, run: failed };
    }
    const advanced = await ScanLedgerRepository.getRun(run.id);
    if (!advanced) throw new Error(`Intelligence run not found: ${runId}`);
    return {
      ok: true,
      run: advanced,
      inputHash: advanced.inputHash ?? "",
      findingsCount: advanced.findingsCount,
    };
  }
  const owner = await ProjectRepository.getProjectById(run.projectId);
  if (!owner) throw new Error(`Project not found: ${run.projectId}`);
  const before = await SourceTokens.assembleDetectionSourceState(run.projectId);
  return executeDetection({
    projectId: run.projectId,
    organizationId: owner.organizationId,
    run,
    before,
    fetchInput: options?.fetchInput,
  });
}

/** Manual refresh bypasses `changed` but honors 1 per 15 min per project. */
export async function triggerManualScan(input: {
  projectId: string;
  organizationId: string;
  actorUserId: string;
  fetchInput?: DetectorInputFetcher;
}): Promise<ManualScanOutcome> {
  const latest = await ScanLedgerRepository.getLatestRun(input.projectId);
  if (
    latest &&
    latest.triggeredBy === "manual" &&
    Date.parse(latest.startedAt) > Date.now() - MANUAL_SCAN_LIMIT_MS
  ) {
    return {
      ok: false,
      rateLimited: true,
      retryAfterMs:
        MANUAL_SCAN_LIMIT_MS - (Date.now() - Date.parse(latest.startedAt)),
    };
  }
  return runScan({
    projectId: input.projectId,
    organizationId: input.organizationId,
    triggeredBy: "manual",
    actorUserId: input.actorUserId,
    fetchInput: input.fetchInput,
  });
}

export const FindingService = {
  runScan,
  resumeScan,
  triggerManualScan,
  runDetectionStage,
};
