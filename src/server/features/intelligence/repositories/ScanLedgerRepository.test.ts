import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

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
  runBatch: async (
    build: (tx: unknown) => Promise<unknown>[] | unknown[],
  ) => {
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

import {
  InvalidStageTransitionError,
  ScanLedgerRepository,
} from "./ScanLedgerRepository";

function migrationStatements(file: string): string[] {
  return readFileSync(resolve(process.cwd(), file), "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function migrateTestDatabase() {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO projects (id) VALUES ('project-1')",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO organization (id) VALUES ('org-1')",
  );
  for (const statement of migrationStatements(
    "drizzle/0053_minor_korath.sql",
  )) {
    await database.client.execute(statement);
  }
}

async function resetTables() {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of ["intelligence_run_detectors", "intelligence_runs"]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
}

beforeAll(migrateTestDatabase);
beforeEach(resetTables);
afterAll(() => database.client?.close());

describe("ScanLedgerRepository", () => {
  it("creates runs with explicit ISO timestamps", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });
    expect(run.status).toBe("pending");
    expect(run.currentStage).toBe("pending");
    expect(run.triggeredBy).toBe("manual");
    expect(run.startedAt).toContain("T");
  });

  it("advances forward through the stage machine only", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    const detecting = await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    expect(detecting.currentStage).toBe("detecting");
    await expect(
      ScanLedgerRepository.transitionStage({
        id: run.id,
        toStage: "pending",
      }),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);
    await expect(
      ScanLedgerRepository.transitionStage({
        id: run.id,
        toStage: "composing",
      }),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);
  });

  it("fails runs from any stage with class and stage recorded", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    const failed = await ScanLedgerRepository.failRun(run.id, {
      error: "SOURCE_CHANGED_DURING_DETECTION: gsc changed",
      errorClass: "SOURCE_CHANGED_DURING_DETECTION",
      errorStage: "detecting",
    });
    expect(failed.status).toBe("failed");
    expect(failed.errorClass).toBe("SOURCE_CHANGED_DURING_DETECTION");
    expect(failed.errorStage).toBe("detecting");
    expect(failed.completedAt).not.toBeNull();
  });

  it("upserts detector outcomes by (run_id, detector_key)", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    await ScanLedgerRepository.recordDetectorOutcome({
      runId: run.id,
      detectorKey: "low_ctr_query",
      status: "skipped",
      skipReason: "required source FAILED",
    });
    await ScanLedgerRepository.recordDetectorOutcome({
      runId: run.id,
      detectorKey: "low_ctr_query",
      status: "completed",
      findingsCount: 3,
      chunkKeys: ["k1"],
    });
    const outcomes = await ScanLedgerRepository.getDetectorOutcomes(run.id);
    expect(outcomes).toHaveLength(1);
    expect(outcomes[0]).toMatchObject({
      status: "completed",
      findingsCount: 3,
      skipReason: null,
    });
  });

  it("commits the Stage-1 pointer and parks at materializing atomically", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    const parked = await ScanLedgerRepository.commitStageOnePointer({
      id: run.id,
      inputHash: "h".repeat(64),
      inputSourceVersionsJson: "{}",
      detectorVersionsJson: "{}",
      thresholdVersion: 1,
      manifestKey: "intelligence-runs/project-1/r/manifest-h.json",
      manifestHash: "h".repeat(64),
      findingsSchemaVersion: 3,
      findingsCount: 0,
      detectionAttemptMetaJson: "[]",
    });
    expect(parked.currentStage).toBe("materializing");
    expect(parked.status).toBe("materializing");
    expect(parked.manifestHash).toBe("h".repeat(64));
  });

  it("refuses pointer commits outside the detecting stage", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    await expect(
      ScanLedgerRepository.commitStageOnePointer({
        id: run.id,
        inputHash: "h",
        inputSourceVersionsJson: "{}",
        detectorVersionsJson: "{}",
        thresholdVersion: 1,
        manifestKey: "k",
        manifestHash: "h",
        findingsSchemaVersion: 3,
        findingsCount: 0,
        detectionAttemptMetaJson: "[]",
      }),
    ).rejects.toBeInstanceOf(InvalidStageTransitionError);
  });

  it("reads the latest successful run by completion for scheduler guards", async () => {
    const first = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
    });
    await ScanLedgerRepository.transitionStage({
      id: first.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    await ScanLedgerRepository.commitStageOnePointer({
      id: first.id,
      inputHash: "a".repeat(64),
      inputSourceVersionsJson: "{}",
      detectorVersionsJson: "{}",
      thresholdVersion: 1,
      manifestKey: "k1",
      manifestHash: "a".repeat(64),
      findingsSchemaVersion: 3,
      findingsCount: 0,
      detectionAttemptMetaJson: "[]",
    });
    await ScanLedgerRepository.transitionStage({
      id: first.id,
      toStage: "composing",
      toStatus: "composing",
    });
    await ScanLedgerRepository.transitionStage({
      id: first.id,
      toStage: "composing",
      toStatus: "completed",
    });
    const latest =
      await ScanLedgerRepository.getLatestSuccessfulRun("project-1");
    expect(latest?.id).toBe(first.id);
    expect(latest?.inputHash).toBe("a".repeat(64));
  });
});
