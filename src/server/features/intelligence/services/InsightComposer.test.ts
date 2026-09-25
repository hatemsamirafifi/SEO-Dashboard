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
import { InsightRepository } from "../repositories/InsightRepository";
import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import {
  InsightComposer,
  composeRun,
  isMaterialChange,
} from "./InsightComposer";

function finding(
  detectorKey: string,
  entityKey: string,
  overrides: Partial<Finding> = {},
): Finding {
  return {
    findingKey: `${detectorKey}-${entityKey}`.padEnd(64, "0").slice(0, 64),
    detectorKey,
    detectorVersion: 1,
    projectId: "project-1",
    entityKey,
    entity: { keyword: entityKey },
    explanationFact: `Observed ${entityKey} during the same period.`,
    evidence: {
      metrics: { clicks: 200 },
      periods: { from: "2026-01-01", to: "2026-01-28" },
      sources: ["gsc"],
      thresholdsApplied: {},
      correlations: [],
      evidenceType: "observational",
      partialData: [],
      confidenceInputs: {},
    },
    detectedAt: "2026-01-01T00:00:00.000Z",
    confidenceScore: 70,
    coverageFlags: {},
    ...overrides,
  };
}

async function parkRun(
  runId: string,
  findings: Finding[],
  outcomes: Array<{ detectorKey: string; status: "completed" | "skipped" | "failed" }>,
): Promise<void> {
  const pointers = await ArtifactStore.writeArtifact({
    projectId: "project-1",
    runId,
    findings,
    inputHash: "d".repeat(64),
    inputSourceVersions: {},
    detectorVersions: {},
    thresholdVersion: 2,
  });
  await ScanLedgerRepository.commitStageOnePointer({
    id: runId,
    inputHash: "d".repeat(64),
    inputSourceVersionsJson: "{}",
    detectorVersionsJson: "{}",
    thresholdVersion: 2,
    manifestKey: pointers.manifestKey,
    manifestHash: pointers.manifestHash,
    findingsSchemaVersion: 3,
    findingsCount: pointers.findingsCount,
    detectionAttemptMetaJson: "[]",
  });
  for (const outcome of outcomes) {
    await ScanLedgerRepository.recordDetectorOutcome({
      runId,
      detectorKey: outcome.detectorKey,
      status: outcome.status,
    });
  }
  // Stage-2 completion (opportunity writes are out of scope here).
  await ScanLedgerRepository.completeMaterializeStage({
    id: runId,
    opportunityIds: [],
  });
}

async function newParkedRun(
  findings: Finding[],
  outcomes: Array<{ detectorKey: string; status: "completed" | "skipped" | "failed" }>,
): Promise<string> {
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
  await parkRun(run.id, findings, outcomes);
  return run.id;
}

async function seedOpportunity(logicalKey: string): Promise<string> {
  const id = `occ-${logicalKey.replace(/[^a-z0-9]/gi, "").slice(0, 12)}`;
  await OpportunityRepository.insertIgnoreConflict({
    id,
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey,
    type: "ranking",
    detectorKey: "ranking_drop",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 60,
    confidenceScore: 70,
    priority: "High",
    title: "t",
    explanationFact: "f",
    recommendation: "r",
    evidenceJson: "{}",
    sourcesJson: "[]",
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
  });
  return id;
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  for (const file of [
    "drizzle/0053_minor_korath.sql",
    "drizzle/0054_mighty_mole_man.sql",
    "drizzle/0055_certain_infant_terrible.sql",
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
    "insight_user_preferences",
    "dashboard_insights",
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

describe("composeRun", () => {
  it("creates grouped rows with linkage and completes the run", async () => {
    const occId = await seedOpportunity("ranking_drop:kw-a");
    const runId = await newParkedRun(
      [finding("ranking_drop", "kw-a"), finding("ranking_drop", "kw-b")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );

    const result = await composeRun({ runId });

    expect(result.stats).toMatchObject({ created: 1 });
    expect(result.insightKeys).toEqual(["dashboard:ranking_drop"]);
    const row = await InsightRepository.findByKey(
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(row?.contentVersion).toBe(1);
    expect(row?.severity).toBe("high");
    expect(JSON.parse(row?.findingKeysJson ?? "[]")).toHaveLength(2);
    expect(JSON.parse(row?.opportunityIdsJson ?? "[]")).toEqual([occId]);
    expect(row?.resolvedAt).toBeNull();
    const run = await ScanLedgerRepository.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.completedAt).not.toBeNull();
  });

  it("marks partial when a detector failed", async () => {
    const runId = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [
        { detectorKey: "ranking_drop", status: "completed" },
        { detectorKey: "low_ctr_query", status: "failed" },
      ],
    );
    await composeRun({ runId });
    const run = await ScanLedgerRepository.getRun(runId);
    expect(run?.status).toBe("partial");
  });

  it("touches without bumping on identical recompose", async () => {
    const run1 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    await composeRun({ runId: run1 });
    // Same bytes, new run: no material change.
    const run2 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    const result = await composeRun({ runId: run2 });

    expect(result.stats).toMatchObject({ updated: 1, versionBumped: 0 });
    const row = await InsightRepository.findByKey(
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(row?.contentVersion).toBe(1);
    expect(row?.scanId).toBe(run2);
  });

  it("bumps on severity change", async () => {
    const run1 = await newParkedRun(
      [finding("ranking_drop", "kw-a", { confidenceScore: 60 })],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    await composeRun({ runId: run1 });
    const run2 = await newParkedRun(
      [finding("ranking_drop", "kw-a", { confidenceScore: 90 })],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    const result = await composeRun({ runId: run2 });

    expect(result.stats).toMatchObject({ versionBumped: 1 });
    const row = await InsightRepository.findByKey(
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(row?.contentVersion).toBe(2);
    expect(row?.severity).toBe("critical");
  });

  it("resolves absent keys after covering composes, never on skips", async () => {
    const run1 = await newParkedRun(
      [
        finding("ranking_drop", "kw-a"),
        finding("content_decay", "/guide", {
          entity: { page: "/guide" },
        }),
      ],
      [
        { detectorKey: "ranking_drop", status: "completed" },
        { detectorKey: "content_decay", status: "completed" },
      ],
    );
    await composeRun({ runId: run1 });
    // run2 covers ranking only; decay outcome skipped → its key survives.
    const run2 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [
        { detectorKey: "ranking_drop", status: "completed" },
        { detectorKey: "content_decay", status: "skipped" },
      ],
    );
    const result = await composeRun({ runId: run2 });
    expect(result.stats.resolved).toBe(0);
    // run3 covers ranking only with decay completed-but-empty → resolves.
    const run3 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [
        { detectorKey: "ranking_drop", status: "completed" },
        { detectorKey: "content_decay", status: "completed" },
      ],
    );
    const result3 = await composeRun({ runId: run3 });
    expect(result3.stats.resolved).toBe(1);
    const rows = await InsightRepository.listUnresolvedByProject("project-1");
    expect(rows.map((r) => r.insightKey)).toEqual(["dashboard:ranking_drop"]);
  });

  it("reopens resolved keys at version+1 with an N-scan reason", async () => {
    const run1 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    await composeRun({ runId: run1 });
    const run2 = await newParkedRun(
      [],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    await composeRun({ runId: run2 });
    const run3 = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    const result = await composeRun({ runId: run3 });

    expect(result.stats).toMatchObject({ reopened: 1 });
    const row = await InsightRepository.findByKey(
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(row?.contentVersion).toBe(2);
    expect(row?.resolvedAt).toBeNull();
    expect(row?.resolveReason).toMatch(/reappeared after \d+ scans clear/);
  });

  it("replays terminal runs with zero deltas and refuses early stages", async () => {
    const runId = await newParkedRun(
      [finding("ranking_drop", "kw-a")],
      [{ detectorKey: "ranking_drop", status: "completed" }],
    );
    await composeRun({ runId });
    const replay = await composeRun({ runId });
    expect(replay.stats).toMatchObject({
      created: 0,
      updated: 0,
      versionBumped: 0,
      resolved: 0,
      reopened: 0,
    });
    const pending = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });
    await expect(composeRun({ runId: pending.id })).rejects.toThrow(
      "not ready to compose",
    );
  });
});

describe("isMaterialChange", () => {
  const prev = {
    severity: "high",
    recommendation: "Review SERPs.",
    entityRefsJson: JSON.stringify(["a", "b", "c", "d", "e"]),
    findingKeysJson: JSON.stringify(["k1"]),
    opportunityIdsJson: JSON.stringify(["o1"]),
    metricsJson: JSON.stringify({ a: 1000, b: 500 }),
  };
  const next = {
    severity: "high",
    recommendation: "Review SERPs.",
    entityRefs: ["a", "b", "c", "d", "e"],
    findingKeys: ["k1"],
    opportunityIds: ["o1"],
    metrics: { a: 1000, b: 500 },
  };

  it("ignores identical content (period rollover never material)", () => {
    expect(isMaterialChange(prev, next).material).toBe(false);
  });

  it("fires on severity, entity, recommendation, and linkage changes", () => {
    expect(
      isMaterialChange(prev, { ...next, severity: "critical" }).reasons,
    ).toContain("severity");
    expect(
      isMaterialChange(prev, { ...next, entityRefs: ["x", "y"] }).reasons,
    ).toContain("entities");
    expect(
      isMaterialChange(prev, { ...next, recommendation: "Do other." }).reasons,
    ).toContain("recommendation-class");
    expect(
      isMaterialChange(prev, { ...next, findingKeys: ["k1", "k2"] }).reasons,
    ).toContain("linkage");
  });

  it("fires on metric drift ≥25% with absolute floor 50", () => {
    // 30% drift, +300 absolute → material.
    expect(
      isMaterialChange(prev, {
        ...next,
        metrics: { a: 1300, b: 500 },
      }).material,
    ).toBe(true);
    // 30% drift but +15 absolute → below the floor, not material.
    expect(
      isMaterialChange(
        { ...prev, metricsJson: JSON.stringify({ a: 50 }) },
        { ...next, metrics: { a: 65 } },
      ).material,
    ).toBe(false);
    // 10% drift → not material.
    expect(
      isMaterialChange(prev, { ...next, metrics: { a: 1100, b: 500 } })
        .material,
    ).toBe(false);
  });
});

describe("InsightComposer export surface", () => {
  it("exposes composeRun through the namespace", () => {
    expect(typeof InsightComposer.composeRun).toBe("function");
  });
});
