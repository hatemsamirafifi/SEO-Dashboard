import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getTableColumns, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { googleAdsConnections as pgGoogleAdsConnections } from "./pg/google-ads.schema";
import { googleAdsConnections as sqliteGoogleAdsConnections } from "./google-ads.schema";

const SQLITE_MIGRATION = "drizzle/0064_google_ads_connections.sql";
const PG_MIGRATION = "drizzle-pg/0042_google_ads_connections.sql";
const SQLITE_SNAPSHOT = "drizzle/meta/0064_snapshot.json";
const PG_SNAPSHOT = "drizzle-pg/meta/0042_snapshot.json";

/** The column contract of `google_ads_connections`, in SQL column names. */
const EXPECTED_COLUMNS = [
  "id",
  "project_id",
  "organization_id",
  "customer_id",
  "login_customer_id",
  "customer_display_name",
  "grant_account_id",
  "connected_by_user_id",
  "currency_code",
  "time_zone",
  "is_test_account",
  "created_at",
  "updated_at",
].toSorted();

let client: Client | undefined;

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

function parseJson(file: string): unknown {
  return JSON.parse(read(file)) as unknown;
}

function textCell(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" ? value : null;
}

function numberCell(row: Record<string, unknown>, key: string): number | null {
  const value = row[key];
  return typeof value === "number" ? value : null;
}

type JournalEntry = { idx: number; tag: string };

function journalEntries(file: string): JournalEntry[] {
  const parsed = parseJson(file);
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  const entries = parsed.entries;
  if (!Array.isArray(entries)) throw new Error(`${file} has no entries`);
  return entries.map((entry) => {
    if (!isRecord(entry)) throw new Error(`${file} has a malformed entry`);
    const idx = entry.idx;
    const tag = entry.tag;
    if (typeof idx !== "number" || typeof tag !== "string") {
      throw new Error(`${file} has a malformed entry`);
    }
    return { idx, tag };
  });
}

function snapshotTables(file: string): string[] {
  const parsed = parseJson(file);
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  const tables = parsed.tables;
  if (!isRecord(tables)) throw new Error(`${file} has no tables`);
  return Object.keys(tables);
}

function snapshotString(file: string, key: string): string {
  const parsed = parseJson(file);
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object`);
  const value = parsed[key];
  if (typeof value !== "string") throw new Error(`${file} has no ${key}`);
  return value;
}

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  // The migration is applied once: it only creates the new table, so the
  // assertions below can read the resulting catalog.
  for (const statement of statementsOf(SQLITE_MIGRATION)) {
    await client.execute(statement);
  }
});

afterAll(() => client?.close());

describe("Google Ads storage migration", () => {
  it("applies to a fresh SQLite database and creates the table", async () => {
    const tables = await client?.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    expect((tables?.rows ?? []).map((row) => textCell(row, "name"))).toContain(
      "google_ads_connections",
    );
  });

  it("creates the table with the documented columns", async () => {
    const columns = await client?.execute(
      "PRAGMA table_info(google_ads_connections)",
    );
    const shape = (columns?.rows ?? []).map((row) => ({
      name: textCell(row, "name"),
      notNull: numberCell(row, "notnull") === 1,
    }));

    expect(shape).toEqual([
      { name: "id", notNull: true },
      { name: "project_id", notNull: true },
      { name: "organization_id", notNull: true },
      { name: "customer_id", notNull: true },
      { name: "login_customer_id", notNull: false },
      { name: "customer_display_name", notNull: false },
      { name: "grant_account_id", notNull: true },
      { name: "connected_by_user_id", notNull: true },
      { name: "currency_code", notNull: false },
      { name: "time_zone", notNull: false },
      { name: "is_test_account", notNull: true },
      { name: "created_at", notNull: true },
      { name: "updated_at", notNull: true },
    ]);
  });

  it("creates the unique project index and the supporting indexes", async () => {
    const indexes = await client?.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'google_ads_connections'",
    );
    const byName = new Map(
      (indexes?.rows ?? []).map((row) => [
        textCell(row, "name"),
        textCell(row, "sql"),
      ]),
    );

    expect(byName.get("google_ads_connections_project_idx")).toContain(
      "CREATE UNIQUE INDEX",
    );
    expect(byName.get("google_ads_connections_organization_idx")).toContain(
      "CREATE INDEX",
    );
    expect(byName.get("google_ads_connections_user_grant_idx")).toContain(
      "CREATE INDEX",
    );
  });

  it("declares cascade foreign keys to the project and the organization", async () => {
    const foreignKeys = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_connections)",
    );
    const shape = (foreignKeys?.rows ?? []).map((row) => ({
      from: textCell(row, "from"),
      table: textCell(row, "table"),
      onDelete: textCell(row, "on_delete"),
    }));

    expect(shape).toContainEqual({
      from: "project_id",
      table: "projects",
      onDelete: "CASCADE",
    });
    expect(shape).toContainEqual({
      from: "organization_id",
      table: "organization",
      onDelete: "CASCADE",
    });
  });

  it("registers the migration in both dialect journals", () => {
    const sqliteEntry = journalEntries("drizzle/meta/_journal.json").find(
      (entry) => entry.tag.includes("0064_google_ads_connections"),
    );
    const pgEntry = journalEntries("drizzle-pg/meta/_journal.json").find(
      (entry) => entry.tag.includes("0042_google_ads_connections"),
    );

    expect(sqliteEntry?.idx).toBe(64);
    expect(pgEntry?.idx).toBe(42);
  });

  it("chains the new snapshots onto the previous ones", () => {
    expect(snapshotString(SQLITE_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle/meta/0063_snapshot.json", "id"),
    );
    expect(snapshotString(PG_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle-pg/meta/0041_snapshot.json", "id"),
    );
    expect(snapshotTables(SQLITE_SNAPSHOT)).toContain("google_ads_connections");
    expect(snapshotTables(PG_SNAPSHOT)).toContain(
      "public.google_ads_connections",
    );
  });

  it("emits the equivalent table, indexes and cascades in Postgres", () => {
    const pgMigration = read(PG_MIGRATION);

    expect(pgMigration).toContain('CREATE TABLE "google_ads_connections"');
    expect(pgMigration).toContain(
      'CREATE UNIQUE INDEX "google_ads_connections_project_idx"',
    );
    expect(pgMigration).toContain(
      'CREATE INDEX "google_ads_connections_organization_idx"',
    );
    expect(pgMigration).toContain(
      'CREATE INDEX "google_ads_connections_user_grant_idx"',
    );
    expect(pgMigration).toContain(
      'FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade',
    );
    expect(pgMigration).toContain(
      'FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade',
    );
    expect(pgMigration).toContain(
      '"is_test_account" boolean DEFAULT false NOT NULL',
    );
    expect(pgMigration).not.toMatch(/token/i);
  });

  it("emits the documented columns in the Postgres migration", () => {
    const columns = [...read(PG_MIGRATION).matchAll(/^\s+"([a-z_]+)" /gm)]
      .map((match) => match[1])
      .filter((name): name is string => name !== undefined);

    expect(columns.toSorted()).toEqual(EXPECTED_COLUMNS);
  });
});

describe("Google Ads schema definitions", () => {
  // `Table` is the broad drizzle table type, so the column names resolve to
  // `string` instead of the column-config generic.
  const tables: Table[] = [sqliteGoogleAdsConnections, pgGoogleAdsConnections];

  it("define the documented columns on both dialects", () => {
    for (const table of tables) {
      expect(
        Object.values(getTableColumns(table))
          .map((column) => column.name)
          .toSorted(),
      ).toEqual(EXPECTED_COLUMNS);
    }
  });

  it("store no token columns (grants live in better-auth account storage)", () => {
    for (const table of tables) {
      const names = Object.values(getTableColumns(table)).map(
        (column) => column.name,
      );
      for (const forbidden of [
        "access_token",
        "refresh_token",
        "id_token",
        "access_token_expires_at",
        "refresh_token_expires_at",
        "scope",
        "credentials",
      ]) {
        expect(names).not.toContain(forbidden);
      }
    }
  });
});
