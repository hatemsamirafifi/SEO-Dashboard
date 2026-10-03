import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// TDD (spec 012, T002): fails until T004 generates the additive D2b
// migrations. Unlike ga4Migration.test.ts (hardcoded filenames), this suite
// locates the migration by content — drizzle-kit assigns the tag names — so
// it stays green across regenerations.

let client: Client | undefined;

beforeAll(() => {
  client = createClient({ url: "file::memory:" });
});

afterAll(() => client?.close());

function createSchedulesTableSql(sql: string): boolean {
  // D1 quotes identifiers with backticks, PG with double quotes.
  return (
    sql.includes("CREATE TABLE `report_schedules`") ||
    sql.includes('CREATE TABLE "report_schedules"')
  );
}

function migrationStatements(dir: string): string[] {
  const files = readdirSync(resolve(process.cwd(), dir))
    .filter((f) => f.endsWith(".sql"))
    .map((f) => join(resolve(process.cwd(), dir), f));
  for (const file of files) {
    const sql = readFileSync(file, "utf8");
    if (createSchedulesTableSql(sql)) {
      return sql
        .split("--> statement-breakpoint")
        .map((part) => part.trim())
        .filter(Boolean);
    }
  }
  return [];
}

function cellText(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
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

function journalTags(dir: string): string[] {
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), dir, "meta/_journal.json"), "utf8"),
  );
  if (!isJournal(journal)) throw new Error(`Bad journal shape in ${dir}`);
  return journal.entries.map((entry) => entry.tag);
}

describe("scheduled reports storage migration smoke (spec 012)", () => {
  it("ships an additive D1 migration creating both tables with the P33 unique", async () => {
    if (!client) throw new Error("Test database was not initialized");
    const statements = migrationStatements("drizzle");
    expect(
      statements.length,
      "no D1 migration creates report_schedules",
    ).toBeGreaterThan(0);
    // CREATE-only: D2b adds tables, never reshapes existing ones.
    expect(
      statements.filter((s) => /^ALTER TABLE/i.test(s)),
      "D2b migration must not ALTER existing tables",
    ).toEqual([]);
    // Referenced parents must exist before the FK-bearing CREATEs run.
    await client.execute(
      "CREATE TABLE projects (id TEXT PRIMARY KEY NOT NULL)",
    );
    await client.execute("CREATE TABLE reports (id TEXT PRIMARY KEY NOT NULL)");
    for (const statement of statements) {
      await client.execute(statement);
    }
    const created = (
      await client.execute(
        "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
      )
    ).rows.map((row) => cellText(row.name));
    expect(created).toContain("report_schedules");
    expect(created).toContain("report_schedule_runs");
    const indexes = (
      await client.execute(
        "SELECT sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL",
      )
    ).rows.map((row) => cellText(row.sql));
    expect(
      indexes.some(
        (sql) =>
          sql.includes("report_schedule_runs") &&
          sql.includes("UNIQUE") &&
          sql.includes("schedule_id") &&
          sql.includes("scheduled_for"),
      ),
      `P33 unique index missing; indexes: ${indexes.join(" ;; ")}`,
    ).toBe(true);
  });

  it("ships a PG mirror migration and registers both in the journals", () => {
    const pgStatements = migrationStatements("drizzle-pg");
    expect(
      pgStatements.length,
      "no PG migration creates report_schedules",
    ).toBeGreaterThan(0);
    expect(
      pgStatements.some((s) => s.includes("report_schedule_runs")),
      "PG migration must create report_schedule_runs too",
    ).toBe(true);
    const sqliteTags = journalTags("drizzle");
    const pgTags = journalTags("drizzle-pg");
    const d1File = readdirSync(resolve(process.cwd(), "drizzle"))
      .filter((f) => f.endsWith(".sql"))
      .find((f) =>
        createSchedulesTableSql(
          readFileSync(join(resolve(process.cwd(), "drizzle"), f), "utf8"),
        ),
      );
    const pgFile = readdirSync(resolve(process.cwd(), "drizzle-pg"))
      .filter((f) => f.endsWith(".sql"))
      .find((f) =>
        createSchedulesTableSql(
          readFileSync(join(resolve(process.cwd(), "drizzle-pg"), f), "utf8"),
        ),
      );
    expect(d1File, "D1 migration file not found").toBeDefined();
    expect(pgFile, "PG migration file not found").toBeDefined();
    expect(
      sqliteTags.some((tag) => d1File!.startsWith(tag)),
      "D1 migration not registered in drizzle/meta/_journal.json",
    ).toBe(true);
    expect(
      pgTags.some((tag) => pgFile!.startsWith(tag)),
      "PG migration not registered in drizzle-pg/meta/_journal.json",
    ).toBe(true);
  });
});
