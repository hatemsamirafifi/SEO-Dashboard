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

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

import { runScheduledIntelligenceScan } from "./scheduledIntelligenceScan";
import { FindingService } from "./FindingService";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { runRowFixture } from "../intelligenceTestFixtures";
import { SourceTokens } from "./SourceTokens";
import type { DetectionSourceState } from "./SourceTokens";

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
  await database.client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL,
       domain TEXT,
       location_code INTEGER NOT NULL DEFAULT 2840,
       language_code TEXT NOT NULL DEFAULT 'en',
       created_at TEXT NOT NULL DEFAULT (current_timestamp),
       archived_at TEXT
     )`,
  );
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  vi.restoreAllMocks();
  for (const table of [
    "intelligence_run_detectors",
    "intelligence_runs",
    "projects",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
});

describe("runScheduledIntelligenceScan", () => {
  it("scans projects with no successful run yet", async () => {
    await database.client?.execute(
      "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
    );
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state(),
    );
    const runScan = vi.spyOn(FindingService, "runScan").mockResolvedValue({
      ok: true,
      run: runRowFixture(),
      inputHash: "x",
      findingsCount: 0,
    });

    await runScheduledIntelligenceScan();

    expect(runScan).toHaveBeenCalledTimes(1);
    expect(runScan).toHaveBeenCalledWith({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
  });

  it("skips projects with an active mutation", async () => {
    await database.client?.execute(
      "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
    );
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state({
        activeMutations: {
          ...state().activeMutations,
          rank: { isMutating: true, activeRunIds: ["run-1"] },
        },
      }),
    );
    const runScan = vi.spyOn(FindingService, "runScan");

    await runScheduledIntelligenceScan();

    expect(runScan).not.toHaveBeenCalled();
    expect(await ScanLedgerRepository.getLatestRun("project-1")).toBeNull();
  });

  it("skips unchanged sources inside the 4h floor, scans after it", async () => {
    await database.client?.execute(
      "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
    );
    const stable = state({
      versions: {
        gsc: "sync-1",
        ga4: null,
        rank: null,
        audit: null,
        backlinks: null,
      },
      sourceSet: ["gsc"],
    });
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      stable,
    );
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    // Simulate a just-completed successful run with the same input hash.
    const { hashSourceState } = await import("./SourceTokens");
    const inputHash = await hashSourceState(stable);
    await database.client?.execute(
      `UPDATE intelligence_runs SET status = 'completed', current_stage = 'composing',
       input_hash = '${inputHash}', completed_at = '${new Date().toISOString()}'
       WHERE id = '${run.id}'`,
    );
    const runScan = vi.spyOn(FindingService, "runScan");

    await runScheduledIntelligenceScan();
    expect(runScan).not.toHaveBeenCalled();

    // Backdate completion beyond the floor: unchanged sources still skip
    // unless forced; force window is 24h so move past 4h but not 24h.
    const fiveHoursAgo = new Date(
      Date.now() - 5 * 60 * 60 * 1000,
    ).toISOString();
    await database.client?.execute(
      `UPDATE intelligence_runs SET completed_at = '${fiveHoursAgo}' WHERE id = '${run.id}'`,
    );
    // State unchanged -> still skip (changed=false, forced=false).
    await runScheduledIntelligenceScan();
    expect(runScan).not.toHaveBeenCalled();

    // New source version -> changed=true, eligible -> scan runs.
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state({
        versions: {
          gsc: "sync-2",
          ga4: null,
          rank: null,
          audit: null,
          backlinks: null,
        },
        sourceSet: ["gsc"],
      }),
    );
    runScan.mockResolvedValue({
      ok: true,
      run: runRowFixture(),
      inputHash: "y",
      findingsCount: 0,
    });
    await runScheduledIntelligenceScan();
    expect(runScan).toHaveBeenCalledTimes(1);
  });

  it("treats a composing-parked run as the floor baseline", async () => {
    await database.client?.execute(
      "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
    );
    const stable = state({
      versions: {
        gsc: "sync-1",
        ga4: null,
        rank: null,
        audit: null,
        backlinks: null,
      },
      sourceSet: ["gsc"],
    });
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      stable,
    );
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    // Parked at composing (Task 11 owns compose): hashed, never terminal.
    const { hashSourceState } = await import("./SourceTokens");
    const inputHash = await hashSourceState(stable);
    await database.client?.execute(
      `UPDATE intelligence_runs SET status = 'composing', current_stage = 'composing',
       input_hash = '${inputHash}', updated_at = '${new Date().toISOString()}'
       WHERE id = '${run.id}'`,
    );
    const runScan = vi.spyOn(FindingService, "runScan");

    // Unchanged sources inside the floor → skip (no 15-minute rescan storm).
    await runScheduledIntelligenceScan();
    expect(runScan).not.toHaveBeenCalled();
  });
});
