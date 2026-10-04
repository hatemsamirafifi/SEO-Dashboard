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

// oxlint-disable-next-line import/first -- mocks must load before the service under test
import { ScheduleRunService } from "./ScheduleRunService";

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
  "reports",
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
  await database.client.execute(
    `INSERT INTO reports
       (id, project_id, organization_id, type, period_from, period_to,
        payload_snapshot_json, consistency_status)
     VALUES
       ('rep-1', 'project-1', 'org-1', 'overview', '2026-09-01', '2026-09-30',
        '{}', 'consistent')`,
  );
  await database.client.execute(
    `INSERT INTO report_schedules
       (id, project_id, organization_id, report_type, cadence, recipients, active, next_due_at)
     VALUES
       ('sched-1', 'project-1', 'org-1', 'overview', 'weekly', '["owner@example.com"]', 1, '2026-10-12T00:00:00.000Z')`,
  );
});

// TDD (spec 012, T018): FAILS until T021 implements ScheduleRunService.
// Claim semantics per contracts/schedule-runs.md (research R1): the claim IS
// the insert; unique-violation means "another invocation won".
describe("ScheduleRunService claim ledger (spec 012, US2)", () => {
  it("claims a due schedule exactly once across repeated invocations", async () => {
    const first = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    expect(first.outcome).toBe("owned");
    expect(first.run.state).toBe("claimed");

    const second = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    expect(second.outcome).toBe("fresh-conflict");
    expect(second.run.id).toBe(first.run.id);
  });

  it("no-ops terminal rows instead of re-entering them", async () => {
    const claimed = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "generating",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "delivering",
      reportId: "rep-1",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "delivered",
    });
    const again = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    expect(again.outcome).toBe("already-terminal");
    expect(again.run.state).toBe("delivered");
  });

  it("retries a failed run on the same row (never a second row)", async () => {
    const claimed = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "failed",
      failureClass: "generation",
    });
    const retry = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    expect(retry.outcome).toBe("owned");
    expect(retry.run.id).toBe(claimed.run.id);
    expect(retry.run.state).toBe("claimed");
  });

  it("reclaims a stale non-terminal claim past the window", async () => {
    const claimed = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    // Age the claim past the 1h staleness window.
    await ScheduleRunService.backdateClaimForTest(
      claimed.run.id,
      new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString(),
    );
    const reclaimed = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    expect(reclaimed.outcome).toBe("owned");
    expect(reclaimed.run.id).toBe(claimed.run.id);
  });

  it("refuses invalid state transitions", async () => {
    const claimed = await ScheduleRunService.claimRun({
      scheduleId: "sched-1",
      scheduledFor: "2026-10-12",
    });
    // claimed → delivered skips the machine (must go via generating).
    await expect(
      ScheduleRunService.transitionRun({
        runId: claimed.run.id,
        to: "delivered",
        reportId: "rep-1",
      }),
    ).rejects.toThrow("Cannot transition schedule run");
    // Terminal states never re-enter.
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "generating",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "delivering",
      reportId: "rep-1",
    });
    await ScheduleRunService.transitionRun({
      runId: claimed.run.id,
      to: "delivered",
    });
    await expect(
      ScheduleRunService.transitionRun({
        runId: claimed.run.id,
        to: "claimed",
      }),
    ).rejects.toThrow("Cannot transition schedule run");
  });
});
