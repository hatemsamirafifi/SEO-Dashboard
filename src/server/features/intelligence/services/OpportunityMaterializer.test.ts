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

import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { OpportunityMaterializer } from "./OpportunityMaterializer";
import { materializeFinding } from "./materializeFinding";
import {
  ctrFinding,
  newRun,
  writeScanArtifact,
} from "./materializerTestFixtures";

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  for (const file of [
    "drizzle/0053_minor_korath.sql",
    "drizzle/0054_mighty_mole_man.sql",
  ]) {
    const migration = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.client.execute(statement);
    }
  }
  await database.client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL
     )`,
  );
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  r2.objects.clear();
  vi.restoreAllMocks();
  for (const table of [
    "opportunity_events",
    "opportunities",
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

describe("materializeRun", () => {
  it("advances to composing with staged IDs and idempotent replay", async () => {
    const runId = await newRun();
    await writeScanArtifact(runId, [ctrFinding()]);

    const first = await OpportunityMaterializer.materializeRun({ runId });
    expect(first.stats).toMatchObject({ created: 1 });
    expect(first.materializedIds).toHaveLength(1);
    const run = await ScanLedgerRepository.getRun(runId);
    expect(run?.currentStage).toBe("composing");
    expect(run?.status).toBe("composing");
    expect(JSON.parse(run?.stageStateJson ?? "{}")).toMatchObject({
      materializedOpportunityIds: first.materializedIds,
    });

    // Resume replay: already-staged run → zero deltas, zero writes.
    const second = await OpportunityMaterializer.materializeRun({ runId });
    expect(second.stats).toMatchObject({
      created: 0,
      updated: 0,
      recurred: 0,
      superseded: 0,
      skipped: 0,
      staleMarked: 0,
    });
    expect(second.materializedIds).toEqual(first.materializedIds);
    expect(
      await OpportunityRepository.listActiveByProject("project-1"),
    ).toHaveLength(1);
    const events = await OpportunityRepository.listEventsByOccurrence(
      first.materializedIds[0] ?? "",
    );
    expect(events.map((e) => e.type)).toEqual(["detected"]);
  });

  it("marks stale on the third consecutive miss, never on skips", async () => {
    const created = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-0",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (created.outcome !== "created") throw new Error("setup failed");

    // Two empty runs with the detector completed → misses 1, 2.
    for (let i = 0; i < 2; i += 1) {
      const runId = await newRun();
      await writeScanArtifact(runId, []);
      const outcome = await OpportunityMaterializer.materializeRun({ runId });
      expect(outcome.stats.staleMarked).toBe(0);
    }
    let row = await OpportunityRepository.getById(created.id);
    expect(row?.consecutiveMisses).toBe(2);
    expect(row?.stale).toBe(false);

    // Third miss → stale + event.
    const runId = await newRun();
    await writeScanArtifact(runId, []);
    const outcome = await OpportunityMaterializer.materializeRun({ runId });
    expect(outcome.stats.staleMarked).toBe(1);
    row = await OpportunityRepository.getById(created.id);
    expect(row?.stale).toBe(true);
    expect(row?.staleAt).not.toBeNull();
    const events = await OpportunityRepository.listEventsByOccurrence(
      created.id,
    );
    expect(events.map((e) => e.type)).toContain("stale_marked");
  });

  it("refuses runs that are not parked at materializing", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });
    await expect(
      OpportunityMaterializer.materializeRun({ runId: run.id }),
    ).rejects.toThrow("not ready to materialize");
  });
});
