/* eslint-disable max-lines -- schema-parity and DDL contract coverage in one
   file */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getTableColumns, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  googleAdsPlannerGroupMonths as pgGoogleAdsPlannerGroupMonths,
  googleAdsPlannerGroups as pgGoogleAdsPlannerGroups,
  googleAdsPlannerGroupVariants as pgGoogleAdsPlannerGroupVariants,
  googleAdsPlannerObservations as pgGoogleAdsPlannerObservations,
} from "./pg/google-ads-planner.schema";
import {
  googleAdsPlannerGroupMonths,
  googleAdsPlannerGroups,
  googleAdsPlannerGroupVariants,
  googleAdsPlannerObservations,
} from "./google-ads-planner.schema";

const SQLITE_MIGRATION = "drizzle/0066_broken_spot.sql";
const PG_MIGRATION = "drizzle-pg/0044_futuristic_captain_cross.sql";
const SQLITE_SNAPSHOT = "drizzle/meta/0066_snapshot.json";
const PG_SNAPSHOT = "drizzle-pg/meta/0044_snapshot.json";

const NEW_TABLES = [
  "google_ads_planner_observations",
  "google_ads_planner_groups",
  "google_ads_planner_group_variants",
  "google_ads_planner_group_months",
];

/** Table contract: [sqliteTable, pgTable, columns (SQL names)]. */
const TABLE_CONTRACTS: readonly [Table, Table, readonly string[]][] = [
  [
    googleAdsPlannerObservations,
    pgGoogleAdsPlannerObservations,
    [
      "id",
      "project_id",
      "organization_id",
      "customer_id",
      "login_customer_id",
      "data_type",
      "currency_code",
      "location_code",
      "language_code",
      "network",
      "contract_version",
      "seed_keyword",
      "source_fetched_at",
      "truncated",
      "partial",
      "malformed_keyword_count",
      "duplicate_keyword_count",
      "missing_keyword_count",
      "created_at",
      "updated_at",
    ],
  ],
  [
    googleAdsPlannerGroups,
    pgGoogleAdsPlannerGroups,
    [
      "id",
      "project_id",
      "organization_id",
      "customer_id",
      "login_customer_id",
      "currency_code",
      "location_code",
      "language_code",
      "network",
      "contract_version",
      "keyword",
      "avg_monthly_searches",
      "competition",
      "competition_index",
      "average_cpc_micros",
      "low_top_of_page_bid_micros",
      "high_top_of_page_bid_micros",
      "source_fetched_at",
      "created_at",
      "updated_at",
    ],
  ],
  [
    googleAdsPlannerGroupVariants,
    pgGoogleAdsPlannerGroupVariants,
    [
      "id",
      "group_id",
      "variant_keyword",
      "source_fetched_at",
      "created_at",
      "updated_at",
    ],
  ],
  [
    googleAdsPlannerGroupMonths,
    pgGoogleAdsPlannerGroupMonths,
    ["id", "group_id", "year", "month", "volume", "created_at", "updated_at"],
  ],
];

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
  for (const statement of statementsOf(SQLITE_MIGRATION)) {
    await client.execute(statement);
  }
  // The planner migration applies standalone on a fresh database, so the
  // parent tables its cascade FKs point at do not exist yet in this scratch
  // DB. Create minimal stubs with the exact referenced table names/columns.
  await client.execute("CREATE TABLE organization (id text PRIMARY KEY)");
  await client.execute("CREATE TABLE projects (id text PRIMARY KEY)");
});

afterAll(() => client?.close());

describe("Google Ads planner migration", () => {
  it("applies to a fresh SQLite database and creates every table", async () => {
    const tables = await client?.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = (tables?.rows ?? []).map((row) => textCell(row, "name"));
    for (const table of NEW_TABLES) {
      expect(names).toContain(table);
    }
  });

  it("creates the observation scope unique index and the group identity index", async () => {
    const indexes = await client?.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name LIKE 'google_ads_planner%'",
    );
    const byName = new Map(
      (indexes?.rows ?? []).map((row) => [
        textCell(row, "name"),
        textCell(row, "sql"),
      ]),
    );
    expect(
      byName.get("google_ads_planner_observations_scope_idx"),
    ).toBeDefined();
    expect(
      byName.get("google_ads_planner_groups_scope_keyword_idx"),
    ).toBeDefined();
    expect(
      byName.get("google_ads_planner_group_variants_group_variant_idx"),
    ).toBeDefined();
    expect(
      byName.get("google_ads_planner_group_months_group_month_idx"),
    ).toBeDefined();
  });

  it("registers the migration in both dialect journals", () => {
    const sqliteEntry = journalEntries("drizzle/meta/_journal.json").find(
      (entry) => entry.tag === "0066_broken_spot",
    );
    const pgEntry = journalEntries("drizzle-pg/meta/_journal.json").find(
      (entry) => entry.tag === "0044_futuristic_captain_cross",
    );

    expect(sqliteEntry?.idx).toBe(66);
    expect(pgEntry?.idx).toBe(44);
  });

  it("chains the new snapshots onto the analytics migration", () => {
    expect(snapshotString(SQLITE_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle/meta/0065_snapshot.json", "id"),
    );
    expect(snapshotString(PG_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle-pg/meta/0043_snapshot.json", "id"),
    );
    for (const table of NEW_TABLES) {
      expect(snapshotTables(SQLITE_SNAPSHOT)).toContain(table);
      expect(snapshotTables(PG_SNAPSHOT)).toContain(`public.${table}`);
    }
  });

  it("emits every documented table in the Postgres migration", () => {
    const pgMigration = read(PG_MIGRATION);
    for (const table of NEW_TABLES) {
      expect(pgMigration).toContain(`CREATE TABLE "${table}"`);
    }
  });

  it("defines identical columns on both dialects for every new table", () => {
    for (const [sqliteTable, pgTable, columns] of TABLE_CONTRACTS) {
      for (const dialectTable of [sqliteTable, pgTable]) {
        expect(
          Object.values(getTableColumns(dialectTable))
            .map((column) => column.name)
            .toSorted(),
        ).toEqual(columns.toSorted());
      }
    }
  });

  it("uses bigint columns for int38-safe money micros in Postgres", () => {
    const pgMigration = read(PG_MIGRATION);
    // Large cost/bid micros exceed the int32 range; Postgres must use bigint.
    expect(pgMigration).toMatch(
      /"google_ads_planner_groups"[\s\S]{0,2000}"average_cpc_micros" bigint/,
    );
    expect(pgMigration).toMatch(
      /"google_ads_planner_groups"[\s\S]{0,2000}"high_top_of_page_bid_micros" bigint/,
    );
    expect(pgMigration).not.toMatch(
      /"(average|low|high)_\w*bid?\w*_micros" (integer|real)/,
    );
    expect(pgMigration).not.toMatch(/integer32|real32/);
  });

  it("round-trips large cost micros values beyond the int32 range in SQLite", async () => {
    const micros = 4_294_967_296; // 2^32 — beyond int32 but a safe integer.
    // Insert stub parents so the cascade FK references resolve.
    await client?.execute("INSERT INTO organization (id) VALUES ('org-test')");
    await client?.execute("INSERT INTO projects (id) VALUES ('proj-test')");
    await client?.execute(
      "INSERT INTO google_ads_planner_groups (id, project_id, organization_id, customer_id, location_code, language_code, network, contract_version, keyword, average_cpc_micros, source_fetched_at) VALUES ('grp-test', 'proj-test', 'org-test', '1234567890', 2840, 'en', 'x', 'v', 'kw', ?, '2026-01-01T00:00:00Z')",
      [micros],
    );
    const row = await client?.execute(
      "SELECT average_cpc_micros FROM google_ads_planner_groups WHERE id = 'grp-test'",
    );
    if (!row?.rows[0]) throw new Error("row not written");
    expect(Number(row.rows[0][0])).toBe(micros);
  });

  it("declares cascade foreign keys to projects and organization", async () => {
    const groupFks = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_planner_groups)",
    );
    const shape = (groupFks?.rows ?? []).map((row) => ({
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

    const variantFks = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_planner_group_variants)",
    );
    const variantShape = (variantFks?.rows ?? []).map((row) => ({
      from: textCell(row, "from"),
      table: textCell(row, "table"),
      onDelete: textCell(row, "on_delete"),
    }));
    expect(variantShape).toContainEqual({
      from: "group_id",
      table: "google_ads_planner_groups",
      onDelete: "CASCADE",
    });

    const monthFks = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_planner_group_months)",
    );
    const monthShape = (monthFks?.rows ?? []).map((row) => ({
      from: textCell(row, "from"),
      table: textCell(row, "table"),
      onDelete: textCell(row, "on_delete"),
    }));
    expect(monthShape).toContainEqual({
      from: "group_id",
      table: "google_ads_planner_groups",
      onDelete: "CASCADE",
    });
  });
});
