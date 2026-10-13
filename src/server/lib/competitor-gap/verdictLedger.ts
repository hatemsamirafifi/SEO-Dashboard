// Spec 014 (G5/P36) — durable verdict ledger for competitor-gap spikes.
//
// The append-only `competitor_gap_verdicts` table is the authoritative gate
// for Part B (detector) and Part C (workflow). This module owns:
// 1. deterministic verdict evaluation (contracts/spike-and-verdict.md),
// 2. append-only persistence via runBatch (P4),
// 3. latest-verdict reads for the runtime gate (P39-scoped).
//
// Trace rows emitted elsewhere are observability only (P42).

import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { competitorGapVerdicts } from "@/db/schema";
import { runBatch } from "@/db/runBatch";
import {
  isCompetitorGapVerdict,
  type CompetitorGapGateState,
  type CompetitorGapSpikeEvidence,
  type CompetitorGapSpikeManifest,
  type CompetitorGapSpikeThresholds,
  type CompetitorGapVerdict,
  type CompetitorGapVerdictRow,
} from "@/shared/competitorGap";

/**
 * Deterministic verdict evaluation (contracts/spike-and-verdict.md).
 *
 * BLOCKED if ANY:
 *  - a dimension is `unavailable` (measurement failed — P8/P9: failure is
 *    never data; an unmeasured dimension cannot justify a go),
 *  - identity: collisionsObserved > identityCollisionsAllowed,
 *  - identity: nonDeterministicMappings > 0 (determinism is absolute),
 *  - cache: repeatCacheHitRate < required,
 *  - cache: repeatAnalysisPaidCalls > 0,
 *  - cost: measuredCreditsPerAnalysis > maxCostPerAnalysisCredits,
 *  - quality: keywordCoverageRatio < minKeywordCoverageRatio,
 *  - coverage: firstPartyCoverageRatio < minFirstPartyCoverageRatio.
 * Otherwise READY.
 *
 * Strict comparisons only: boundary equality passes.
 */
export function evaluateVerdict(input: {
  evidence: CompetitorGapSpikeEvidence;
  thresholds: CompetitorGapSpikeThresholds;
}): CompetitorGapVerdict {
  const { evidence, thresholds } = input;

  // Every dimension must have been successfully measured.
  const dimensions = [
    evidence.quality,
    evidence.coverage,
    evidence.cost,
    evidence.identity,
    evidence.cache,
  ] as const;
  for (const dimension of dimensions) {
    if (dimension.status === "unavailable") {
      return "COMPETITOR_GAP_BLOCKED";
    }
  }

  if (evidence.quality.status !== "measured") {
    return "COMPETITOR_GAP_BLOCKED"; // unreachable; narrows the type
  }
  if (evidence.coverage.status !== "measured") {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.cost.status !== "measured") {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.identity.status !== "measured") {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.cache.status !== "measured") {
    return "COMPETITOR_GAP_BLOCKED";
  }

  if (
    evidence.identity.value.collisionsObserved >
    thresholds.identityCollisionsAllowed
  ) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.identity.value.nonDeterministicMappings > 0) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.cache.value.repeatCacheHitRate < thresholds.repeatCacheHitRate) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (evidence.cache.value.repeatAnalysisPaidCalls > 0) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (
    evidence.cost.value.measuredCreditsPerAnalysis >
    thresholds.maxCostPerAnalysisCredits
  ) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (
    evidence.quality.value.keywordCoverageRatio <
    thresholds.minKeywordCoverageRatio
  ) {
    return "COMPETITOR_GAP_BLOCKED";
  }
  if (
    evidence.coverage.value.firstPartyCoverageRatio <
    thresholds.minFirstPartyCoverageRatio
  ) {
    return "COMPETITOR_GAP_BLOCKED";
  }

  return "COMPETITOR_GAP_READY";
}

/**
 * Append one verdict row. Deterministic id from the manifest (hash of the
 * manifest JSON + recordedAt) so identical spike runs are auditable and a
 * re-run of the same manifest never silently overwrites: recordedAt differs,
 * so the id differs, and both rows persist (FR-003).
 */
export async function recordVerdict(input: {
  evidence: CompetitorGapSpikeEvidence;
  thresholds: CompetitorGapSpikeThresholds;
  manifest: CompetitorGapSpikeManifest;
  recordedAt?: string;
}): Promise<CompetitorGapVerdictRow> {
  const verdict = evaluateVerdict({
    evidence: input.evidence,
    thresholds: input.thresholds,
  });
  const recordedAt = input.recordedAt ?? new Date().toISOString();
  const id = verdictRowId(input.manifest, recordedAt);

  await runBatch((tx) => [
    tx.insert(competitorGapVerdicts).values({
      id,
      organizationId: input.manifest.organizationId,
      projectId: input.manifest.projectId,
      verdict,
      evidence: JSON.stringify(input.evidence),
      thresholds: JSON.stringify(input.thresholds),
      inputManifest: JSON.stringify(input.manifest),
      recordedAt,
    }),
  ]);

  return {
    id,
    organizationId: input.manifest.organizationId,
    projectId: input.manifest.projectId,
    verdict,
    evidence: input.evidence,
    thresholds: input.thresholds,
    inputManifest: input.manifest,
    recordedAt,
  };
}

/** Deterministic row id: manifest hash + recordedAt (append, never mutate). */
function verdictRowId(
  manifest: CompetitorGapSpikeManifest,
  recordedAt: string,
): string {
  const manifestJson = JSON.stringify(manifest);
  // FNV-1a over the manifest: stable across isolates, no async crypto needed.
  let hash = 0x811c9dc5;
  for (let index = 0; index < manifestJson.length; index += 1) {
    hash ^= manifestJson.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `cgv_${hash.toString(16)}_${recordedAt}`;
}

/**
 * Latest verdict row for (organizationId, projectId), or null when no spike
 * has run. Scoped reads only (P39) — no cross-project leakage.
 */
export async function latestVerdict(params: {
  organizationId: string;
  projectId: string;
}): Promise<CompetitorGapVerdictRow | null> {
  const rows = await db
    .select()
    .from(competitorGapVerdicts)
    .where(
      and(
        eq(competitorGapVerdicts.organizationId, params.organizationId),
        eq(competitorGapVerdicts.projectId, params.projectId),
      ),
    )
    .orderBy(desc(competitorGapVerdicts.recordedAt))
    .limit(1);

  return parseVerdictRow(rows[0] ?? null);
}

/** Parse a persisted row, treating corrupt JSON as a miss (never a fake READY). */
function parseVerdictRow(
  row:
    | {
        id: string;
        organizationId: string;
        projectId: string;
        verdict: string;
        evidence: string;
        thresholds: string;
        inputManifest: string;
        recordedAt: string;
      }
    | null,
): CompetitorGapVerdictRow | null {
  if (!row) return null;
  if (!isCompetitorGapVerdict(row.verdict)) return null;
  try {
    return {
      id: row.id,
      organizationId: row.organizationId,
      projectId: row.projectId,
      verdict: row.verdict,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON.parse returns unknown; trusted at this boundary only after parse succeeds
      evidence: JSON.parse(row.evidence) as CompetitorGapSpikeEvidence,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same
      thresholds: JSON.parse(row.thresholds) as CompetitorGapSpikeThresholds,
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- same
      inputManifest: JSON.parse(
        row.inputManifest,
      ) as CompetitorGapSpikeManifest,
      recordedAt: row.recordedAt,
    };
  } catch {
    return null;
  }
}

/**
 * Runtime gate state for Part B/C availability (contracts/spike-and-verdict).
 * NO_VERDICT and BLOCKED both hold the gate; only a latest READY row opens it.
 */
export async function competitorGapGateState(params: {
  organizationId: string;
  projectId: string;
}): Promise<{
  state: CompetitorGapGateState;
  verdictRow: CompetitorGapVerdictRow | null;
}> {
  const verdictRow = await latestVerdict(params);
  if (!verdictRow) return { state: "NO_VERDICT", verdictRow: null };
  return {
    state: verdictRow.verdict === "COMPETITOR_GAP_READY" ? "READY" : "BLOCKED",
    verdictRow,
  };
}