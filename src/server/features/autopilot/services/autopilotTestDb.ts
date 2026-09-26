import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// Shared SQLite harness for autopilot service tests: full migration journal
// (all tables exist; source reads are stubbed at the service seam) plus a
// minimal organization/project pair. Mirrors the detector-test journal
// pattern, including the 0051 block-comment stripping.

export const AUTOPILOT_BASE_TABLES = [
  "autopilot_steps",
  "autopilot_run_attempts",
  "autopilot_runs",
  "projects",
  "organization",
];

function isMigrationJournal(value: unknown): value is {
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

export async function setupAutopilotTestDb(client: Client): Promise<void> {
  await client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (!isMigrationJournal(journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of journal.entries) {
    for (const statement of migrationStatements(`drizzle/${entry.tag}.sql`)) {
      await client.execute(statement);
    }
  }
  await client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL
     )`,
  );
}

export async function resetAutopilotTestDb(
  client: Client,
  tables: string[] = AUTOPILOT_BASE_TABLES,
): Promise<void> {
  for (const table of tables) {
    await client.execute(`DELETE FROM ${table}`);
  }
  await client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
}
