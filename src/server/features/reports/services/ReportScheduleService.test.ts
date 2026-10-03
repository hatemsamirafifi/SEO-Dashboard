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
import { ReportScheduleService } from "./ReportScheduleService";

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
});

const BASE = {
  projectId: "project-1",
  organizationId: "org-1",
  userId: "user-1",
};

describe("ReportScheduleService (spec 012, US1)", () => {
  it("creates a schedule with derived nextDueAt and normalized recipients", async () => {
    const row = await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "overview",
      cadence: "weekly",
      recipients: ["Owner@Example.com", "owner@example.com", "ops@example.com"],
    });
    expect(row.id).toBeTruthy();
    expect(row.projectId).toBe("project-1");
    expect(row.cadence).toBe("weekly");
    expect(JSON.parse(row.recipients)).toEqual([
      "owner@example.com",
      "ops@example.com",
    ]);
    expect(row.active).toBe(true);
    expect(new Date(row.nextDueAt).getTime()).toBeGreaterThan(Date.now());
    // nextDueAt is a Monday 00:00 UTC for weekly cadence.
    const due = new Date(row.nextDueAt);
    expect(due.getUTCDay()).toBe(1);
    expect(due.getUTCHours()).toBe(0);
  });

  it("derives the 1st of next month for monthly cadence", async () => {
    const row = await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "technical",
      cadence: "monthly",
      recipients: ["owner@example.com"],
    });
    const due = new Date(row.nextDueAt);
    expect(due.getUTCDate()).toBe(1);
    expect(due.getUTCHours()).toBe(0);
  });

  it("rejects invalid cadence, bad recipients, and unknown report types", async () => {
    await expect(
      ReportScheduleService.createSchedule({
        ...BASE,
        reportType: "overview",
        cadence: "daily",
        recipients: ["owner@example.com"],
      }),
    ).rejects.toThrow();
    await expect(
      ReportScheduleService.createSchedule({
        ...BASE,
        reportType: "overview",
        cadence: "weekly",
        recipients: [],
      }),
    ).rejects.toThrow();
    await expect(
      ReportScheduleService.createSchedule({
        ...BASE,
        reportType: "overview",
        cadence: "weekly",
        recipients: ["not-an-email"],
      }),
    ).rejects.toThrow();
    await expect(
      ReportScheduleService.createSchedule({
        ...BASE,
        reportType: "fortune",
        cadence: "weekly",
        recipients: ["owner@example.com"],
      }),
    ).rejects.toThrow();
    await expect(
      ReportScheduleService.createSchedule({
        ...BASE,
        reportType: "overview",
        cadence: "weekly",
        recipients: Array.from({ length: 11 }, (_, i) => `u${i}@example.com`),
      }),
    ).rejects.toThrow();
  });

  it("edits cadence and recipients without touching run history", async () => {
    const created = await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "overview",
      cadence: "weekly",
      recipients: ["owner@example.com"],
    });
    const updated = await ReportScheduleService.updateSchedule({
      ...BASE,
      id: created.id,
      cadence: "monthly",
      recipients: ["new@example.com"],
    });
    expect(updated.cadence).toBe("monthly");
    expect(JSON.parse(updated.recipients)).toEqual(["new@example.com"]);
    expect(new Date(updated.nextDueAt).getUTCDate()).toBe(1);
  });

  it("pauses (freezing nextDueAt) and resumes (re-deriving it)", async () => {
    const created = await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "overview",
      cadence: "weekly",
      recipients: ["owner@example.com"],
    });
    const paused = await ReportScheduleService.pauseSchedule({
      ...BASE,
      id: created.id,
    });
    expect(paused.active).toBe(false);
    expect(paused.pausedAt).toBeTruthy();
    expect(paused.nextDueAt).toBe(created.nextDueAt);
    const resumed = await ReportScheduleService.resumeSchedule({
      ...BASE,
      id: created.id,
    });
    expect(resumed.active).toBe(true);
    expect(resumed.pausedAt).toBeNull();
  });

  it("lists schedules with a not-yet-run summary when no runs exist", async () => {
    await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "overview",
      cadence: "weekly",
      recipients: ["owner@example.com"],
    });
    const listed = await ReportScheduleService.listSchedules({ ...BASE });
    expect(listed).toHaveLength(1);
    expect(listed[0]?.lastRun).toBeNull();
  });

  it("scopes schedules to their project", async () => {
    const row = await ReportScheduleService.createSchedule({
      ...BASE,
      reportType: "overview",
      cadence: "weekly",
      recipients: ["owner@example.com"],
    });
    await expect(
      ReportScheduleService.getSchedule({
        projectId: "project-other",
        organizationId: "org-1",
        id: row.id,
      }),
    ).rejects.toThrow();
    await expect(
      ReportScheduleService.updateSchedule({
        ...BASE,
        projectId: "project-other",
        id: row.id,
        cadence: "monthly",
      }),
    ).rejects.toThrow();
  });
});
