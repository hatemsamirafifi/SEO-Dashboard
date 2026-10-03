import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  database.client = createClient({ url: "file::memory:" });
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

const generateReport = vi.hoisted(() => vi.fn());

vi.mock("@/server/features/reports/services/ReportService", () => ({
  ReportService: { generateReport },
}));

// oxlint-disable-next-line import/first -- mocks must load before the modules under test
import { ReportScheduleRepository } from "../repositories/ReportScheduleRepository";
// oxlint-disable-next-line import/first
import { runScheduledReportRuns } from "./scheduledReportRuns";

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

function isJournal(value: unknown): value is {
  entries: Array<{ tag: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("entries" in value)) return false;
  const entries: unknown = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string",
    )
  );
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (!isJournal(journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of journal.entries) {
    for (const statement of migrationStatements(`drizzle/${entry.tag}.sql`)) {
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
  "report_schedule_runs",
  "report_schedules",
  "projects",
  "organization",
  "reports",
];

async function seedDueSchedule(id = "sched-1", nextDueAt?: string) {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)
     ON CONFLICT (id) DO NOTHING`,
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id, name)
     VALUES ('project-1', 'org-1', 'Test')
     ON CONFLICT (id) DO NOTHING`,
  );
  await ReportScheduleRepository.insertSchedule({
    id,
    projectId: "project-1",
    organizationId: "org-1",
    reportType: "overview",
    cadence: "weekly",
    recipients: JSON.stringify(["owner@example.com"]),
    active: true,
    nextDueAt: nextDueAt ?? new Date(Date.now() - 60_000).toISOString(),
  });
}

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  generateReport.mockReset();
  generateReport.mockResolvedValue({ id: "rep-1" });
  for (const table of TABLES) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id, name)
     VALUES ('project-1', 'org-1', 'Test')`,
  );
  // FKs stay enforced: stub the reports the mocked generator "produces".
  for (const reportId of ["rep-1", "rep-2"]) {
    await database.client.execute(
      `INSERT INTO reports
         (id, project_id, organization_id, type, period_from, period_to,
          payload_snapshot_json, consistency_status)
       VALUES
         ('${reportId}', 'project-1', 'org-1', 'overview', '2026-09-01',
          '2026-09-30', '{}', 'consistent')`,
    );
  }
});

// TDD (spec 012, T019): FAILS until T022 implements the cron pass.
// Contracts/schedule-runs.md: sequential AND concurrent double-invocation
// yield exactly one generation + one ledger row per (schedule, due date).
describe("scheduledReportRuns cron pass (spec 012, US2)", () => {
  it("generates exactly once across sequential double-invocation (SC-001)", async () => {
    await seedDueSchedule();
    await runScheduledReportRuns();
    await runScheduledReportRuns();
    expect(generateReport).toHaveBeenCalledTimes(1);
    const runs = await ReportScheduleRepository.latestRunsByScheduleIds([
      "sched-1",
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("delivering");
    expect(runs[0]?.reportId).toBe("rep-1");
  });

  it("generates exactly once across concurrent double-invocation (SC-001)", async () => {
    await seedDueSchedule();
    await Promise.all([runScheduledReportRuns(), runScheduledReportRuns()]);
    expect(generateReport).toHaveBeenCalledTimes(1);
    const runs = await ReportScheduleRepository.latestRunsByScheduleIds([
      "sched-1",
    ]);
    expect(runs).toHaveLength(1);
  });

  it("retries a failed generation on the same row without duplicates (SC-002)", async () => {
    await seedDueSchedule();
    generateReport.mockRejectedValueOnce(new Error("collector blew up"));
    await runScheduledReportRuns();
    expect(generateReport).toHaveBeenCalledTimes(1);
    generateReport.mockResolvedValue({ id: "rep-2" });
    await runScheduledReportRuns();
    expect(generateReport).toHaveBeenCalledTimes(2);
    const runs = await ReportScheduleRepository.latestRunsByScheduleIds([
      "sched-1",
    ]);
    expect(runs).toHaveLength(1);
    expect(runs[0]?.state).toBe("delivering");
    expect(runs[0]?.reportId).toBe("rep-2");
  });

  it("creates no run for a paused schedule due now", async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await seedDueSchedule();
    await database.client.execute(
      "UPDATE report_schedules SET active = 0 WHERE id = 'sched-1'",
    );
    await runScheduledReportRuns();
    expect(generateReport).not.toHaveBeenCalled();
    const runs = await ReportScheduleRepository.latestRunsByScheduleIds([
      "sched-1",
    ]);
    expect(runs).toHaveLength(0);
  });

  it("advances nextDueAt after each run", async () => {
    // A due date in the past relative to real now (the cron clock): last
    // Monday 00:00 UTC, so the run targets it and advances a full week.
    const lastMonday = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    lastMonday.setUTCHours(0, 0, 0, 0);
    const dueIso = lastMonday.toISOString();
    await seedDueSchedule("sched-1", dueIso);
    await runScheduledReportRuns();
    const row = await ReportScheduleRepository.getScheduleByIdForProject(
      "sched-1",
      "project-1",
    );
    expect(row?.active).toBe(true);
    expect(new Date(row!.nextDueAt).getTime()).toBeGreaterThan(
      new Date(dueIso).getTime(),
    );
  });

  it("isolates one schedule's failure from the rest of the pass", async () => {
    await seedDueSchedule("sched-1");
    await seedDueSchedule("sched-2");
    generateReport.mockImplementation(async () => {
      throw new Error("boom");
    });
    await runScheduledReportRuns();
    // Both attempted despite the shared failure; each recorded honestly.
    expect(generateReport).toHaveBeenCalledTimes(2);
  });
});
