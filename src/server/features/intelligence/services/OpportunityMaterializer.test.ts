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

import type { Finding } from "@/shared/intelligence";
import { ArtifactStore } from "../repositories/ArtifactStore";
import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  OpportunityMaterializer,
  materializeFinding,
} from "./OpportunityMaterializer";

function ctrFinding(overrides: Partial<Finding> = {}): Finding {
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

async function writeScanArtifact(
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

async function newRun(): Promise<string> {
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

describe("materializeFinding", () => {
  it("creates an occurrence with scores, copy, refs, and a detected event", async () => {
    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const row = await OpportunityRepository.getById(result.id);
    expect(row?.logicalKey).toBe("low_ctr_query:best shoes");
    expect(row?.status).toBe("open");
    expect(row?.occurrenceNumber).toBe(1);
    expect(row?.type).toBe("ctr");
    expect(row?.keyword).toBe("best shoes");
    expect(row?.recommendation.length).toBeGreaterThan(0);
    // impact = round(100 × (30×logScale(5000) + 25×proximity(8.5)) / 55)
    expect(row?.impactScore).toBeGreaterThan(0);
    expect(row?.priority).toBe("High");
    expect(JSON.parse(row?.impactFactorsJson ?? "{}")).toMatchObject({
      businessIntent: null,
      conversionSignal: null,
    });
    const events = await OpportunityRepository.listEventsByOccurrence(
      result.id,
    );
    expect(events.map((e) => e.type)).toEqual(["detected"]);
  });

  it("updates in place on redetection, preserving status and clearing stale", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");
    await OpportunityRepository.updateById(first.id, {
      status: "in_progress",
      stale: true,
      staleAt: "2026-01-02T00:00:00.000Z",
      consecutiveMisses: 2,
      lastDetectedAt: "2025-12-01T00:00:00.000Z",
    });

    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("updated");
    const row = await OpportunityRepository.getById(first.id);
    expect(row?.status).toBe("in_progress");
    expect(row?.consecutiveMisses).toBe(0);
    expect(row?.stale).toBe(false);
    const events = await OpportunityRepository.listEventsByOccurrence(
      first.id,
    );
    const types = events.map((e) => e.type);
    expect(types).toContain("redetected");
    expect(types).toContain("stale_cleared");
  });

  it("emits rescored only on a ≥10 impact delta", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");

    // Same evidence one hour later: no thresholds trip, no new events.
    await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });
    let events = await OpportunityRepository.listEventsByOccurrence(first.id);
    expect(events.map((e) => e.type)).toEqual(["detected"]);

    // Collapsed impressions rescore past the delta.
    await materializeFinding({
      finding: ctrFinding({
        evidence: {
          metrics: { impressions: 120, clicks: 0, ctr: 0, position: 8.5 },
          sources: ["gsc"],
          thresholdsApplied: { minImpressions: 100, ctrFloor: 0.01 },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      scanId: "run-3",
      projectId: "project-1",
      organizationId: "org-1",
    });
    events = await OpportunityRepository.listEventsByOccurrence(first.id);
    expect(events.map((e) => e.type)).toContain("rescored");
  });

  it("recurs after terminal states without touching history", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");
    await OpportunityRepository.updateById(first.id, {
      status: "completed",
      completedAt: "2026-01-02T00:00:00.000Z",
    });

    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-3",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("recurred");
    if (result.outcome !== "recurred") return;
    const row = await OpportunityRepository.getById(result.id);
    expect(row?.occurrenceNumber).toBe(2);
    expect(row?.recurrenceOfId).toBe(first.id);
    expect(row?.status).toBe("open");
    const old = await OpportunityRepository.getById(first.id);
    expect(old?.status).toBe("completed");
    const events = await OpportunityRepository.listEventsByOccurrence(
      result.id,
    );
    expect(events.map((e) => e.type)).toEqual(["detected", "recurred"]);
  });

  it("supersedes across detector versions", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");

    const result = await materializeFinding({
      finding: ctrFinding({ detectorVersion: 2 }),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("superseded");
    if (result.outcome !== "superseded") return;
    const old = await OpportunityRepository.getById(first.id);
    expect(old?.status).toBe("dismissed");
    expect(old?.supersededById).toBe(result.id);
    const events = await OpportunityRepository.listEventsByOccurrence(
      first.id,
    );
    expect(events.map((e) => e.type)).toContain("superseded");
  });

  it("skips findings without templates or factors", async () => {
    const result = await materializeFinding({
      finding: ctrFinding({ detectorKey: "future_detector" }),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(
      await OpportunityRepository.listActiveByProject("project-1"),
    ).toHaveLength(0);
  });
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
