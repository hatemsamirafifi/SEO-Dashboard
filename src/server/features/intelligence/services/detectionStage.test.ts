import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client);
  return { db: database.db };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const statement of build(database.db)) await statement;
  },
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

import { runDetectionStage } from "./detectionStage";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import type { DetectionSourceState } from "./SourceTokens";
import type { DetectorDef, FindingDraft } from "../detectors/types";

function state(
  overrides: Partial<DetectionSourceState> = {},
): DetectionSourceState {
  return {
    versions: {
      gsc: null,
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
    },
    sourceSet: [],
    detectorVersions: {},
    thresholdVersion: 1,
    activeMutations: {
      gsc: { isMutating: false, activeRunIds: [] },
      ga4: { isMutating: false, activeRunIds: [] },
      rank: { isMutating: false, activeRunIds: [] },
      audit: { isMutating: false, activeRunIds: [] },
      backlinks: { isMutating: false, activeRunIds: [] },
    },
    ...overrides,
  };
}

function stateWithVersions(): DetectionSourceState {
  return state({
    versions: {
      gsc: "sync-1",
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
    },
    sourceSet: ["gsc"],
  });
}

function draft(entityKey: string): FindingDraft {
  return {
    entityKey,
    entity: { query: entityKey },
    explanationFact: `Entity ${entityKey} crossed its threshold.`,
    evidence: {
      metrics: { clicks: 10 },
      periods: { from: "2026-01-01", to: "2026-01-07" },
      sources: ["gsc"],
      thresholdsApplied: { minImpressions: 100 },
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: { coverage: 1 },
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 80,
    coverageFlags: {},
  };
}

function detector(
  overrides: Partial<DetectorDef> & { detectorKey: string },
): DetectorDef {
  return {
    version: 1,
    requiredSources: [],
    optionalCorroborators: [],
    minConfidenceToEmit: 0,
    coverage: [],
    detect: () => [],
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0053_minor_korath.sql"),
    "utf8",
  );
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.client.execute(statement);
  }
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  vi.restoreAllMocks();
  for (const table of ["intelligence_run_detectors", "intelligence_runs"]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
});

describe("runDetectionStage", () => {
  it("completes, fails, and skips detectors with per-detector outcomes", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });

    const findings = await runDetectionStage({
      projectId: "project-1",
      organizationId: "org-1",
      runId: run.id,
      state: stateWithVersions(),
      detectors: [
        detector({
          detectorKey: "test_ok",
          version: 3,
          requiredSources: ["gsc"],
          detect: () => [draft("entity-1")],
        }),
        detector({
          detectorKey: "test_boom",
          requiredSources: ["gsc"],
          detect: () => {
            throw new Error("detector exploded");
          },
        }),
        detector({
          detectorKey: "test_missing",
          requiredSources: ["ga4"],
          detect: () => [draft("entity-2")],
        }),
      ],
      fetchInput: async () => ({ rows: [] }),
    });

    expect(findings).toHaveLength(1);
    expect(findings[0]?.detectorKey).toBe("test_ok");
    expect(findings[0]?.detectorVersion).toBe(3);
    expect(findings[0]?.findingKey).toHaveLength(64);

    const rows = await ScanLedgerRepository.getDetectorOutcomes(run.id);
    const outcomes = Object.fromEntries(
      rows.map((row) => [row.detectorKey, row]),
    );
    expect(outcomes.test_ok).toMatchObject({
      status: "completed",
      findingsCount: 1,
    });
    expect(outcomes.test_boom?.status).toBe("failed");
    expect(outcomes.test_missing?.status).toBe("skipped");
    expect(outcomes.test_missing?.skipReason).toContain("ga4");
  });

  it("skips detectors when no input fetcher is registered", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });

    const findings = await runDetectionStage({
      projectId: "project-1",
      organizationId: "org-1",
      runId: run.id,
      state: stateWithVersions(),
      detectors: [
        detector({
          detectorKey: "test_ok",
          requiredSources: ["gsc"],
          detect: () => [draft("entity-1")],
        }),
      ],
    });

    expect(findings).toHaveLength(0);
    const rows = await ScanLedgerRepository.getDetectorOutcomes(run.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.status).toBe("skipped");
  });
});
