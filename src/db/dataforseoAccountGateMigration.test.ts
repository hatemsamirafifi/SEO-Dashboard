import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getTableColumns, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { dataforseoAccountRequestSlots as pgSlots } from "./pg/app.schema";
import { dataforseoAccountRequestSlots as sqliteSlots } from "./app.schema";

const SQLITE_MIGRATION = "drizzle/0077_dataforseo_account_request_slots.sql";
const PG_MIGRATION = "drizzle-pg/0055_dataforseo_account_request_slots.sql";

/** The column contract of `dataforseo_account_request_slots`, in SQL names. */
const EXPECTED_COLUMNS = [
  "account_hash",
  "epoch",
  "acquired_at",
  "free_at",
].toSorted();

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

function statementsOf(migrationFile: string): string[] {
  return read(migrationFile)
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

type JournalEntry = { idx: number; tag: string };

function journalEntries(file: string): JournalEntry[] {
  const parsed = JSON.parse(read(file)) as unknown;
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  const entries = parsed.entries;
  if (!Array.isArray(entries)) throw new Error(`${file} has no entries`);
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${file} has a malformed entry`);
    if (typeof entry.idx !== "number" || typeof entry.tag !== "string") {
      throw new Error(`${file} has a malformed entry`);
    }
    return { idx: entry.idx, tag: entry.tag };
  });
}

/** Apply the migration to a FRESH scratch database and return its client. */
async function applyToFreshScratch(): Promise<Client> {
  const client = createClient({ url: "file::memory:" });
  for (const statement of statementsOf(SQLITE_MIGRATION)) {
    await client.execute(statement);
  }
  return client;
}

function textCell(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

let client: Client | undefined;

beforeAll(async () => {
  client = await applyToFreshScratch();
});

afterAll(() => client?.close());

describe("DataForSEO account request slots migration", () => {
  it("applies to a fresh SQLite scratch database and creates the table", async () => {
    const tables = await client?.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect((tables?.rows ?? []).map((row) => textCell(row, "name"))).toContain(
      "dataforseo_account_request_slots",
    );
  });

  it("applies deterministically: a second fresh scratch database yields the identical shape", async () => {
    const second = await applyToFreshScratch();
    try {
      const shape = await client?.execute(
        "PRAGMA table_info(dataforseo_account_request_slots)",
      );
      const shape2 = await second.execute(
        "PRAGMA table_info(dataforseo_account_request_slots)",
      );
      expect(shape2.rows.length).toBe(shape?.rows.length);
      expect(shape2.rows.map((row) => textCell(row, "name"))).toEqual(
        (shape?.rows ?? []).map((row) => textCell(row, "name")),
      );
    } finally {
      second.close();
    }
  });

  it("creates the documented columns with the documented nullability", async () => {
    const columns = await client?.execute(
      "PRAGMA table_info(dataforseo_account_request_slots)",
    );
    const shape = (columns?.rows ?? []).map((row) => ({
      name: textCell(row, "name"),
      notNull: Number(row["notnull"]) === 1,
    }));

    expect(shape).toEqual([
      { name: "account_hash", notNull: true },
      { name: "epoch", notNull: true },
      { name: "acquired_at", notNull: true },
      { name: "free_at", notNull: true },
    ]);
  });

  it("keeps the primary key on the account hash (one slot row per account)", async () => {
    const pk = await client?.execute(
      "SELECT name FROM pragma_table_info('dataforseo_account_request_slots') WHERE pk > 0",
    );
    expect((pk?.rows ?? []).map((row) => textCell(row, "name"))).toEqual([
      "account_hash",
    ]);
  });

  it("registers the migration in both dialect journals", () => {
    const sqliteEntry = journalEntries("drizzle/meta/_journal.json").find(
      (entry) => entry.tag.includes("0077_dataforseo_account_request_slots"),
    );
    const pgEntry = journalEntries("drizzle-pg/meta/_journal.json").find(
      (entry) => entry.tag.includes("0055_dataforseo_account_request_slots"),
    );

    expect(sqliteEntry?.idx).toBe(77);
    expect(pgEntry?.idx).toBe(55);
    // Journals chain onto the previous hand-written migration (0076 / 0054
    // set the precedent of forward entries without new drizzle-kit snapshots).
    const sqliteEntries = journalEntries("drizzle/meta/_journal.json");
    const pgEntries = journalEntries("drizzle-pg/meta/_journal.json");
    const sqliteIdx = sqliteEntries.findIndex((entry) => entry.idx === 77);
    const pgIdx = pgEntries.findIndex((entry) => entry.idx === 55);
    expect(sqliteEntries[sqliteIdx - 1]?.tag).toBe("0076_indexnow_key");
    expect(pgEntries[pgIdx - 1]?.tag).toBe("0054_indexnow_key");
  });

  it("emits the equivalent Postgres table (same columns, PK, defaults)", () => {
    const pgMigration = read(PG_MIGRATION);

    expect(pgMigration).toContain(
      'CREATE TABLE "dataforseo_account_request_slots"',
    );
    expect(pgMigration).toContain('"account_hash" text PRIMARY KEY NOT NULL');
    expect(pgMigration).toContain('"epoch" integer DEFAULT 1 NOT NULL');
    expect(pgMigration).toContain('"acquired_at" text NOT NULL');
    expect(pgMigration).toContain('"free_at" text NOT NULL');
    // No dialect-specific types that would break the provider-aware cast.
    expect(pgMigration).not.toMatch(/(jsonb|serial|uuid|timestamptz)/);
  });
});

describe("DataForSEO account request slots schema definitions", () => {
  // `Table` is the broad drizzle table type, so the column names resolve to
  // `string` instead of the column-config generic.
  const tables: Table[] = [sqliteSlots, pgSlots];

  it("define the documented columns on both dialects", () => {
    for (const table of tables) {
      expect(
        Object.values(getTableColumns(table))
          .map((column) => column.name)
          .toSorted(),
      ).toEqual(EXPECTED_COLUMNS);
    }
  });

  it("store no credential material (hash of the login only)", () => {
    for (const table of tables) {
      const names = Object.values(getTableColumns(table)).map(
        (column) => column.name,
      );
      for (const forbidden of [
        "login",
        "password",
        "api_key",
        "credentials",
        "auth",
        "token",
        "body",
        "request",
      ]) {
        expect(names, `${forbidden} column must not exist`).not.toContain(
          forbidden,
        );
      }
    }
  });
});
