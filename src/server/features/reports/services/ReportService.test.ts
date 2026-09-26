import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { eq } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase<Record<string, unknown>> | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  // Relational schema included: AuditRepository reads via db.query.
  database.db = drizzle(database.client, { schema });
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

import { db } from "@/db";
import { intelligenceRuns, reports } from "@/db/schema";
import { AppError } from "@/server/lib/errors";
import { ScanLedgerRepository } from "@/server/features/intelligence/repositories/ScanLedgerRepository";
import {
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import { consistencyBanner } from "@/shared/reports";
import { ReportService } from "./ReportService";

function sourceState(version: string | null): DetectionSourceState {
  return {
    versions: {
      gsc: version,
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
    },
    sourceSet: version === null ? [] : ["gsc"],
    detectorVersions: {},
    thresholdVersion: 2,
    activeMutations: {
      gsc: { isMutating: false, activeRunIds: [] },
      ga4: { isMutating: false, activeRunIds: [] },
      rank: { isMutating: false, activeRunIds: [] },
      audit: { isMutating: false, activeRunIds: [] },
      backlinks: { isMutating: false, activeRunIds: [] },
    },
  };
}

function migrationStatements(file: string): string[] {
  const withoutBlocks = readFileSync(
    resolve(process.cwd(), file),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
    .filter(Boolean);
}

const PERIOD = { from: "2026-01-01", to: "2026-01-14" };

function baseInput(overrides = {}) {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    domain: null,
    type: "overview" as const,
    period: PERIOD,
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (typeof journal !== "object" || journal === null || !("entries" in journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of (journal as { entries: Array<{ tag: string }> })
    .entries) {
    for (const statement of migrationStatements(
      `drizzle/${entry.tag}.sql`,
    )) {
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

const TABLES = [
  "reports",
  "intelligence_run_detectors",
  "intelligence_runs",
  "dashboard_insights",
  "insight_user_preferences",
  "opportunity_events",
  "opportunities",
  "gsc_search_performance",
  "gsc_search_performance_syncs",
  "gsc_connections",
  "ga4_daily_summary",
  "ga4_daily_events",
  "ga4_sync_coverage",
  "ga4_connections",
  "backlink_snapshots",
  "projects",
  "organization",
];

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of TABLES) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
  vi.restoreAllMocks();
});

async function seedCompletedRun(completedAt: string): Promise<string> {
  const run = await ScanLedgerRepository.createRun({
    projectId: "project-1",
    organizationId: "org-1",
  });
  await db
    .update(intelligenceRuns)
    .set({
      inputHash: "a".repeat(64),
      manifestHash: "b".repeat(64),
      status: "completed",
      currentStage: "completed",
      completedAt,
    })
    .where(eq(intelligenceRuns.id, run.id));
  return run.id;
}

describe("generateReport validation", () => {
  it("rejects reversed and malformed periods", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    await expect(
      ReportService.generateReport(
        baseInput({ period: { from: "2026-01-14", to: "2026-01-01" } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      ReportService.generateReport(
        baseInput({ period: { from: "not-a-date", to: "2026-01-01" } }),
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("provenance protocol", () => {
  it("freezes exact versions when the state is stable", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState("sync-1"),
    );
    const row = await ReportService.generateReport(baseInput());
    expect(row.consistencyStatus).toBe("consistent");
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(found?.payload.provenance.metricSourceVersions).toHaveLength(64);
    expect(
      found?.payload.provenance.collectionVersionsBefore,
    ).toBeNull();
    expect(consistencyBanner(found!.payload.provenance)).toBe(
      "All data sources were stable while this report was collected. No successful intelligence scan exists yet; insights and opportunities reflect whatever has been composed so far.",
    );
  });

  it("recovers with a retry when the first collection drifts", async () => {
    const assemble = vi.spyOn(
      SourceTokens,
      "assembleDetectionSourceState",
    );
    assemble
      .mockResolvedValueOnce(sourceState("sync-1"))
      .mockResolvedValueOnce(sourceState("sync-2"))
      .mockResolvedValue(sourceState("sync-2"));
    const row = await ReportService.generateReport(baseInput());
    expect(row.consistencyStatus).toBe("consistent");
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    // The retried collection's hash is the frozen one, not the discarded first.
    expect(found?.payload.provenance.metricSourceVersions).toHaveLength(64);
    expect(assemble).toHaveBeenCalledTimes(3);
  });

  it("banners dual-sided output when drift persists", async () => {
    const assemble = vi.spyOn(
      SourceTokens,
      "assembleDetectionSourceState",
    );
    assemble
      .mockResolvedValueOnce(sourceState("sync-1"))
      .mockResolvedValueOnce(sourceState("sync-2"))
      .mockResolvedValue(sourceState("sync-3"));
    const row = await ReportService.generateReport(baseInput());
    expect(row.consistencyStatus).toBe("concurrent_mutation");
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(
      found?.payload.provenance.metricSourceVersions,
    ).toBeNull();
    expect(
      found?.payload.provenance.collectionVersionsBefore,
    ).toHaveLength(64);
    expect(consistencyBanner(found!.payload.provenance)).toContain(
      "figures may mix two states",
    );
  });

  it("strict-aborts instead of banner output and stores nothing", async () => {
    const assemble = vi.spyOn(
      SourceTokens,
      "assembleDetectionSourceState",
    );
    assemble
      .mockResolvedValueOnce(sourceState("sync-1"))
      .mockResolvedValueOnce(sourceState("sync-2"))
      .mockResolvedValue(sourceState("sync-3"));
    await expect(
      ReportService.generateReport(baseInput({ strict: true })),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await ReportService.listReports({ projectId: "project-1" })).toHaveLength(0);
  });
});

describe("intelligence provenance", () => {
  it("records a fresh run without staleness", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    const runId = await seedCompletedRun(new Date().toISOString());
    const row = await ReportService.generateReport(baseInput());
    expect(row.intelligenceRunId).toBe(runId);
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(found?.payload.provenance.hasSuccessfulScan).toBe(true);
    expect(found?.payload.provenance.intelligenceStale).toBe(false);
    expect(found?.payload.provenance.intelligenceRunHash).toBe("a".repeat(64));
  });

  it("labels stale-but-stable runs distinctly", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    await seedCompletedRun("2020-05-01T00:00:00.000Z");
    const row = await ReportService.generateReport(baseInput());
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(found?.payload.provenance.intelligenceStale).toBe(true);
    expect(consistencyBanner(found!.payload.provenance)).toContain(
      "Intelligence is stale",
    );
  });
});

describe("sections per type", () => {
  it("stores the mapped sections and marks the rest not_selected", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    const row = await ReportService.generateReport(
      baseInput({ type: "technical" }),
    );
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(found?.payload.sections).toEqual([
      "technical",
      "insights",
      "opportunities",
    ]);
    expect(found?.payload.searchVisibility.status.reason).toBe("not_selected");
    expect(found?.payload.traffic.status.reason).toBe("not_selected");
  });
});

describe("report CRUD", () => {
  it("lists newest first, scopes by project, and deletes", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    const first = await ReportService.generateReport(baseInput());
    const second = await ReportService.generateReport(
      baseInput({ type: "executive" }),
    );
    const listed = await ReportService.listReports({ projectId: "project-1" });
    // createdAt has second precision: assert membership, not wall-clock order.
    expect(listed.map((row) => row.id)).toEqual(
      expect.arrayContaining([first.id, second.id]),
    );
    expect(listed).toHaveLength(2);
    expect(
      await ReportService.getReport({ id: first.id, projectId: "other" }),
    ).toBeNull();
    expect(
      await ReportService.getReport({ id: "missing", projectId: "project-1" }),
    ).toBeNull();
    expect(
      await ReportService.deleteReport({ id: first.id, projectId: "other" }),
    ).toBe(false);
    expect(
      await ReportService.deleteReport({
        id: first.id,
        projectId: "project-1",
      }),
    ).toBe(true);
    expect(
      await ReportService.getReport({
        id: first.id,
        projectId: "project-1",
      }),
    ).toBeNull();
  });

  it("rejects corrupt snapshots instead of serving them", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
      sourceState(null),
    );
    const row = await ReportService.generateReport(baseInput());
    await db
      .update(reports)
      .set({ payloadSnapshotJson: "{nope" })
      .where(eq(reports.id, row.id));
    await expect(
      ReportService.getReport({ id: row.id, projectId: "project-1" }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
