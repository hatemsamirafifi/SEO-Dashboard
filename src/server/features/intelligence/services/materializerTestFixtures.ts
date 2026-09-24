import type { Finding } from "@/shared/intelligence";
import { ArtifactStore } from "../repositories/ArtifactStore";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";

/** Shared fixtures for materializer tests (no drift between suites). */

export function ctrFinding(overrides: Partial<Finding> = {}): Finding {
  return {
    findingKey: "a".repeat(64),
    detectorKey: "low_ctr_query",
    detectorVersion: 1,
    projectId: "project-1",
    entityKey: "best shoes",
    entity: { query: "best shoes" },
    explanationFact: 'Query "best shoes" has low CTR.',
    evidence: {
      metrics: { impressions: 5000, clicks: 20, ctr: 0.004, position: 8.5 },
      periods: { from: "2026-01-01", to: "2026-01-28" },
      sources: ["gsc"],
      sourceRefs: { gscFactIds: ["fact-1"] },
      thresholdsApplied: { minImpressions: 100, ctrFloor: 0.01 },
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: { coverageDays: 28 },
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 70,
    coverageFlags: {},
    ...overrides,
  };
}

export async function newRun(): Promise<string> {
  const run = await ScanLedgerRepository.createRun({
    projectId: "project-1",
    organizationId: "org-1",
    triggeredBy: "manual",
  });
  await ScanLedgerRepository.transitionStage({
    id: run.id,
    toStage: "detecting",
    toStatus: "detecting",
  });
  return run.id;
}

export async function writeScanArtifact(
  runId: string,
  findings: Finding[],
): Promise<void> {
  const pointers = await ArtifactStore.writeArtifact({
    projectId: "project-1",
    runId,
    findings,
    inputHash: "c".repeat(64),
    inputSourceVersions: { gsc: "sync-1" },
    detectorVersions: { low_ctr_query: 1 },
    thresholdVersion: 2,
  });
  await ScanLedgerRepository.commitStageOnePointer({
    id: runId,
    inputHash: "c".repeat(64),
    inputSourceVersionsJson: JSON.stringify({ gsc: "sync-1" }),
    detectorVersionsJson: JSON.stringify({ low_ctr_query: 1 }),
    thresholdVersion: 2,
    manifestKey: pointers.manifestKey,
    manifestHash: pointers.manifestHash,
    findingsSchemaVersion: 3,
    findingsCount: pointers.findingsCount,
    detectionAttemptMetaJson: "[]",
  });
  await ScanLedgerRepository.recordDetectorOutcome({
    runId,
    detectorKey: "low_ctr_query",
    status: "completed",
    findingsCount: pointers.findingsCount,
  });
}
