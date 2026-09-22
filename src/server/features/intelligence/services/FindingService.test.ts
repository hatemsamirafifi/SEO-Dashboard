import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

const r2 = vi.hoisted(() => ({
  objects: new Map<string, string>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const body = r2.objects.get(key);
        if (body === undefined) return null;
        return { text: async () => body };
      },
      head: async (key: string) => (r2.objects.has(key) ? { key } : null),
      put: async (key: string, body: string) => {
        r2.objects.set(key, body);
      },
    },
  },
  waitUntil: vi.fn(),
}));

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

import { FindingService } from "./FindingService";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
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
  r2.objects.clear();
  vi.restoreAllMocks();
  for (const table of [
    "intelligence_run_detectors",
    "intelligence_runs",
    "projects",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
});

describe("FindingService.runScan", () => {
  it("cron defers without creating a run when a source is mutating", async () => {
    const mutating = state({
      activeMutations: {
        ...state().activeMutations,
        gsc: { isMutating: true, activeRunIds: ["sync-9"] },
      },
    });
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      mutating,
    );

    const outcome = await FindingService.runScan({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome).toMatchObject({ deferred: "active_mutation" });
    expect(await ScanLedgerRepository.getLatestRun("project-1")).toBeNull();
    expect(r2.objects.size).toBe(0);
  });

  it("parks a stable empty-registry scan at materializing with a frozen manifest", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state(),
    );

    const outcome = await FindingService.runScan({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.currentStage).toBe("materializing");
    expect(outcome.findingsCount).toBe(0);
    expect(outcome.inputHash).toHaveLength(64);
    const manifestKey = outcome.run.manifestKey;
    expect(manifestKey).toMatch(
      /^intelligence-runs\/project-1\/.+\/manifest-[0-9a-f]{64}\.json$/,
    );
    if (typeof manifestKey !== "string") {
      throw new Error("expected a manifest key");
    }
    // Frozen bytes exist in R2: manifest + zero chunks for empty findings.
    expect(r2.objects.has(manifestKey)).toBe(true);
    expect(r2.objects.size).toBe(1);
    const stored = await ScanLedgerRepository.getRun(outcome.run.id);
    expect(stored?.detectionAttemptMetaJson).toContain('"attempt":0');
  });

  it("retries once when sources settle, then parks", async () => {
    const first = stateWithVersions();
    const second = state({
      ...stateWithVersions(),
      versions: { ...stateWithVersions().versions, rank: "run-2" },
      sourceSet: ["gsc", "rank"],
    });
    const assemble = vi.spyOn(SourceTokens, "assembleDetectionSourceState");
    // runScan pre-check -> A; attempt 0 after -> B (changed); attempt 1
    // after -> B (stable).
    assemble
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second)
      .mockResolvedValue(second);

    const outcome = await FindingService.runScan({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.currentStage).toBe("materializing");
    expect(assemble).toHaveBeenCalledTimes(3);
  });

  it("fails with SOURCE_CHANGED_DURING_DETECTION when sources never settle", async () => {
    const assemble = vi.spyOn(SourceTokens, "assembleDetectionSourceState");
    assemble.mockImplementation(async () => stateWithVersions());
    // Every call returns a distinct version object so the gate never passes.
    let counter = 0;
    assemble.mockImplementation(async () =>
      state({
        versions: {
          gsc: `sync-${counter++}`,
          ga4: null,
          rank: null,
          audit: null,
          backlinks: null,
        },
        sourceSet: ["gsc"],
      }),
    );

    const outcome = await FindingService.runScan({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });

    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.deferred).toBe(false);
    if (outcome.deferred !== false) return;
    expect(outcome.run.status).toBe("failed");
    expect(outcome.run.errorClass).toBe("SOURCE_CHANGED_DURING_DETECTION");
    // 1 pre-check + 3 attempts.
    expect(assemble).toHaveBeenCalledTimes(4);
  });
});

describe("FindingService.triggerManualScan", () => {
  it("rate-limits a second manual scan within 15 minutes", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state(),
    );

    const first = await FindingService.triggerManualScan({
      projectId: "project-1",
      organizationId: "org-1",
      actorUserId: "user-1",
    });
    expect(first.ok).toBe(true);

    const second = await FindingService.triggerManualScan({
      projectId: "project-1",
      organizationId: "org-1",
      actorUserId: "user-1",
    });
    expect(second.ok).toBe(false);
    if (second.ok) return;
    expect(second).toMatchObject({ rateLimited: true });
  });
});

describe("FindingService.resumeScan", () => {
  it("re-runs detection for a crashed detecting run with no manifest", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state(),
    );
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });

    const outcome = await FindingService.resumeScan(run.id);

    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.run.id).toBe(run.id);
    expect(outcome.run.currentStage).toBe("materializing");
  });

  it("defers without re-detecting once the artifact is frozen", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      state(),
    );
    const first = await FindingService.runScan({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const objectsBefore = r2.objects.size;

    const outcome = await FindingService.resumeScan(first.run.id);

    expect(outcome).toMatchObject({
      ok: false,
      deferred: true,
      reason: "frozen_artifact_owned_by_stage",
    });
    // No new artifact bytes: frozen bytes are never rewritten.
    expect(r2.objects.size).toBe(objectsBefore);
  });

  it("defers terminal runs without touching them", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
    await ScanLedgerRepository.failRun(run.id, {
      error: "boom",
      errorClass: "DETECTOR_THREW",
      errorStage: "detecting",
    });

    const outcome = await FindingService.resumeScan(run.id);

    expect(outcome).toMatchObject({
      ok: false,
      deferred: true,
      reason: "terminal",
    });
  });
});
