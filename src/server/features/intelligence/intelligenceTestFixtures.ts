import type { IntelligenceRunRow } from "./repositories/ScanLedgerRepository";

/** Complete ledger row for service/server-function tests (no `as` casts). */
export function runRowFixture(
  overrides: Partial<IntelligenceRunRow> = {},
): IntelligenceRunRow {
  return {
    id: "run-1",
    projectId: "project-1",
    organizationId: "org-1",
    status: "materializing",
    currentStage: "materializing",
    inputHash: "a".repeat(64),
    inputSourceVersionsJson: "{}",
    detectorVersionsJson: "{}",
    thresholdVersion: 1,
    manifestKey:
      "intelligence-runs/project-1/run-1/manifest-" + "b".repeat(64) + ".json",
    manifestHash: "b".repeat(64),
    findingsSchemaVersion: 3,
    findingsCount: 0,
    detectionAttemptMetaJson: "[]",
    stageStateJson: null,
    error: null,
    errorClass: null,
    errorStage: null,
    triggeredBy: "cron",
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}
