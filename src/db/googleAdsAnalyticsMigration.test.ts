/* eslint-disable max-lines -- schema-parity and DDL contract coverage in one
   file */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { getTableColumns, type Table } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  googleAdsAccounts as pgGoogleAdsAccounts,
  googleAdsAdGroups as pgGoogleAdsAdGroups,
  googleAdsAnalyticsUnits as pgGoogleAdsAnalyticsUnits,
  googleAdsCampaigns as pgGoogleAdsCampaigns,
  googleAdsDailyAccount as pgGoogleAdsDailyAccount,
  googleAdsDailyAdGroup as pgGoogleAdsDailyAdGroup,
  googleAdsDailyCampaign as pgGoogleAdsDailyCampaign,
  googleAdsDailyDevice as pgGoogleAdsDailyDevice,
  googleAdsDailyKeyword as pgGoogleAdsDailyKeyword,
  googleAdsDailyLandingPage as pgGoogleAdsDailyLandingPage,
  googleAdsDailySearchTerm as pgGoogleAdsDailySearchTerm,
  googleAdsKeywords as pgGoogleAdsKeywords,
} from "./pg/google-ads-analytics.schema";
import {
  googleAdsSyncRuns as pgGoogleAdsSyncRuns,
  googleAdsSyncUnits as pgGoogleAdsSyncUnits,
} from "./pg/google-ads-sync.schema";
import {
  googleAdsAccounts,
  googleAdsAdGroups,
  googleAdsAnalyticsUnits,
  googleAdsCampaigns,
  googleAdsDailyAccount,
  googleAdsDailyAdGroup,
  googleAdsDailyCampaign,
  googleAdsDailyDevice,
  googleAdsDailyKeyword,
  googleAdsDailyLandingPage,
  googleAdsDailySearchTerm,
  googleAdsKeywords,
} from "./google-ads-analytics.schema";
import {
  googleAdsSyncRuns,
  googleAdsSyncUnits,
} from "./google-ads-sync.schema";

const SQLITE_MIGRATION = "drizzle/0065_great_stature.sql";
const PG_MIGRATION = "drizzle-pg/0043_productive_quentin_quire.sql";
const SQLITE_SNAPSHOT = "drizzle/meta/0065_snapshot.json";
const PG_SNAPSHOT = "drizzle-pg/meta/0043_snapshot.json";

const NEW_TABLES = [
  "google_ads_accounts",
  "google_ads_campaigns",
  "google_ads_ad_groups",
  "google_ads_keywords",
  "google_ads_daily_account",
  "google_ads_daily_campaign",
  "google_ads_daily_ad_group",
  "google_ads_daily_keyword",
  "google_ads_daily_search_term",
  "google_ads_daily_device",
  "google_ads_daily_landing_page",
  "google_ads_analytics_units",
  "google_ads_sync_runs",
  "google_ads_sync_units",
];

const FACT_BASE_COLUMNS = [
  "id",
  "project_id",
  "customer_id",
  "date",
  "generation_id",
  "impressions",
  "clicks",
  "cost_micros",
  "conversions",
  "conversions_value",
  "created_at",
  "updated_at",
];

const DIMENSION_COLUMNS = [
  "id",
  "project_id",
  "organization_id",
  "customer_id",
  "source_fetched_at",
  "created_at",
  "updated_at",
];

/** Table contract: [sqliteName, sqliteTable, pgTable, columns (SQL names)]. */
const TABLE_CONTRACTS: readonly [string, Table, Table, readonly string[]][] = [
  [
    "google_ads_accounts",
    googleAdsAccounts,
    pgGoogleAdsAccounts,
    [
      ...DIMENSION_COLUMNS,
      "descriptive_name",
      "currency_code",
      "time_zone",
      "is_test_account",
    ],
  ],
  [
    "google_ads_campaigns",
    googleAdsCampaigns,
    pgGoogleAdsCampaigns,
    [
      ...DIMENSION_COLUMNS,
      "campaign_resource_id",
      "campaign_id",
      "name",
      "status",
      "serving_status",
      "advertising_channel_type",
    ],
  ],
  [
    "google_ads_ad_groups",
    googleAdsAdGroups,
    pgGoogleAdsAdGroups,
    [
      ...DIMENSION_COLUMNS,
      "ad_group_resource_id",
      "campaign_resource_id",
      "name",
      "status",
    ],
  ],
  [
    "google_ads_keywords",
    googleAdsKeywords,
    pgGoogleAdsKeywords,
    [
      ...DIMENSION_COLUMNS,
      "keyword_resource_id",
      "campaign_resource_id",
      "ad_group_resource_id",
      "keyword_text",
      "keyword_match_type",
    ],
  ],
  [
    "google_ads_daily_account",
    googleAdsDailyAccount,
    pgGoogleAdsDailyAccount,
    [...FACT_BASE_COLUMNS],
  ],
  [
    "google_ads_daily_campaign",
    googleAdsDailyCampaign,
    pgGoogleAdsDailyCampaign,
    [...FACT_BASE_COLUMNS, "campaign_resource_id"],
  ],
  [
    "google_ads_daily_ad_group",
    googleAdsDailyAdGroup,
    pgGoogleAdsDailyAdGroup,
    [...FACT_BASE_COLUMNS, "campaign_resource_id", "ad_group_resource_id"],
  ],
  [
    "google_ads_daily_keyword",
    googleAdsDailyKeyword,
    pgGoogleAdsDailyKeyword,
    [
      ...FACT_BASE_COLUMNS,
      "campaign_resource_id",
      "ad_group_resource_id",
      "keyword_resource_id",
    ],
  ],
  [
    "google_ads_daily_search_term",
    googleAdsDailySearchTerm,
    pgGoogleAdsDailySearchTerm,
    [
      ...FACT_BASE_COLUMNS,
      "campaign_resource_id",
      "ad_group_resource_id",
      "search_text",
      "keyword_text",
      "keyword_match_type",
    ],
  ],
  [
    "google_ads_daily_device",
    googleAdsDailyDevice,
    pgGoogleAdsDailyDevice,
    [...FACT_BASE_COLUMNS, "campaign_resource_id", "device"],
  ],
  [
    "google_ads_daily_landing_page",
    googleAdsDailyLandingPage,
    pgGoogleAdsDailyLandingPage,
    [...FACT_BASE_COLUMNS, "campaign_resource_id", "landing_page_url"],
  ],
  [
    "google_ads_analytics_units",
    googleAdsAnalyticsUnits,
    pgGoogleAdsAnalyticsUnits,
    [
      "id",
      "project_id",
      "organization_id",
      "customer_id",
      "date",
      "grain",
      "published_generation_id",
      "status",
      "error_class",
      "row_count",
      "source_fetched_at",
      "currency_code",
      "metric_date_basis",
      "staged_at",
      "published_at",
      "created_at",
      "updated_at",
    ],
  ],
  [
    "google_ads_sync_runs",
    googleAdsSyncRuns,
    pgGoogleAdsSyncRuns,
    [
      "id",
      "project_id",
      "organization_id",
      "customer_id",
      "run_key",
      "mode",
      "window_start_date",
      "window_end_date",
      "scheduled_slot",
      "fingerprint_connection_id",
      "fingerprint_grant_account_id",
      "fingerprint_login_customer_id",
      "fingerprint_connection_updated_at",
      "attempt",
      "status",
      "lease_expires_at",
      "heartbeat_at",
      "started_at",
      "completed_at",
      "units_total",
      "units_succeeded",
      "units_failed",
      "error_class",
      "error_message",
      "created_at",
      "updated_at",
    ],
  ],
  [
    "google_ads_sync_units",
    googleAdsSyncUnits,
    pgGoogleAdsSyncUnits,
    [
      "id",
      "project_id",
      "organization_id",
      "run_id",
      "customer_id",
      "date",
      "grain",
      "status",
      "attempt",
      "error_class",
      "error_message",
      "created_at",
      "updated_at",
    ],
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
  // Foreign key references resolve only if executed after parents; SQLite
  // tolerates FKs to not-yet-existing tables, so the additive migration
  // applies standalone against a fresh database.
  for (const statement of statementsOf(SQLITE_MIGRATION)) {
    await client.execute(statement);
  }
});

afterAll(() => client?.close());

describe("Google Ads analytics/sync migration", () => {
  it("applies to a fresh SQLite database and creates every table", async () => {
    const tables = await client?.execute(
      "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
    );
    const names = (tables?.rows ?? []).map((row) => textCell(row, "name"));
    for (const table of NEW_TABLES) {
      expect(names).toContain(table);
    }
  });

  it("creates the runs ledger with the unique ACTIVE-claim partial index", async () => {
    const indexes = await client?.execute(
      "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'google_ads_sync_runs'",
    );
    const byName = new Map(
      (indexes?.rows ?? []).map((row) => [
        textCell(row, "name"),
        textCell(row, "sql"),
      ]),
    );
    expect(byName.get("google_ads_sync_runs_active_claim_idx")).toBe(
      "CREATE UNIQUE INDEX `google_ads_sync_runs_active_claim_idx` ON `google_ads_sync_runs` (`project_id`,`customer_id`,`run_key`) WHERE \"google_ads_sync_runs\".\"status\" IN ('pending', 'running')",
    );
  });

  it("registers the migration in both dialect journals", () => {
    const sqliteEntry = journalEntries("drizzle/meta/_journal.json").find(
      (entry) => entry.tag === "0065_great_stature",
    );
    const pgEntry = journalEntries("drizzle-pg/meta/_journal.json").find(
      (entry) => entry.tag === "0043_productive_quentin_quire",
    );

    expect(sqliteEntry?.idx).toBe(65);
    expect(pgEntry?.idx).toBe(43);
  });

  it("chains the new snapshots onto the Google Ads connection migration", () => {
    expect(snapshotString(SQLITE_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle/meta/0064_snapshot.json", "id"),
    );
    expect(snapshotString(PG_SNAPSHOT, "prevId")).toBe(
      snapshotString("drizzle-pg/meta/0042_snapshot.json", "id"),
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

  it("emits the runs ledger unique ACTIVE-claim index in Postgres", () => {
    const pgMigration = read(PG_MIGRATION);
    expect(pgMigration).toContain(
      'CREATE UNIQUE INDEX "google_ads_sync_runs_active_claim_idx"',
    );
    // The partial predicate must survive generation on Postgres too.
    expect(pgMigration).toMatch(
      /google_ads_sync_runs_active_claim_idx[\s\S]{0,200}WHERE/,
    );
    expect(pgMigration).not.toMatch(/token/i);
  });

  it("defines identical columns on both dialects for every new table", () => {
    for (const [table, sqliteTable, pgTable, columns] of TABLE_CONTRACTS) {
      for (const dialectTable of [sqliteTable, pgTable]) {
        expect(
          Object.values(getTableColumns(dialectTable))
            .map((column) => column.name)
            .toSorted(),
        ).toEqual(columns.toSorted());
        void table;
      }
    }
  });

  it("declares cascade foreign keys to projects/organization and the run ledger", async () => {
    const unitFks = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_sync_units)",
    );
    const shape = (unitFks?.rows ?? []).map((row) => ({
      from: textCell(row, "from"),
      table: textCell(row, "table"),
      onDelete: textCell(row, "on_delete"),
    }));
    expect(shape).toContainEqual({
      from: "run_id",
      table: "google_ads_sync_runs",
      onDelete: "CASCADE",
    });
    expect(shape).toContainEqual({
      from: "project_id",
      table: "projects",
      onDelete: "CASCADE",
    });

    const runFks = await client?.execute(
      "PRAGMA foreign_key_list(google_ads_sync_runs)",
    );
    const runShape = (runFks?.rows ?? []).map((row) => ({
      from: textCell(row, "from"),
      table: textCell(row, "table"),
      onDelete: textCell(row, "on_delete"),
    }));
    expect(runShape).toContainEqual({
      from: "project_id",
      table: "projects",
      onDelete: "CASCADE",
    });
  });
});
