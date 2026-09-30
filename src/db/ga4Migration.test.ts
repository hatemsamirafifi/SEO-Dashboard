import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient, type Client } from "@libsql/client";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

let client: Client | undefined;

beforeAll(() => {
  client = createClient({ url: "file::memory:" });
});

afterAll(() => client?.close());

function statementsOf(migrationFile: string): string[] {
  const sql = readFileSync(resolve(process.cwd(), migrationFile), "utf8");
  return sql
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function tables(): Promise<string[]> {
  if (!client) throw new Error("Test database was not initialized");
  const result = await client.execute(
    "SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name",
  );
  return result.rows.map((row) => String(row.name));
}

describe("GA4 storage migration smoke", () => {
  it("applies the GA4 storage migration to a fresh SQLite database", async () => {
    if (!client) throw new Error("Test database was not initialized");
    // The ALTER TABLE targets a table from an earlier migration; stub the
    // pre-existing table so the smoke test proves the ALTER itself applies.
    await client.execute(
      "CREATE TABLE gsc_search_performance_syncs (id TEXT PRIMARY KEY NOT NULL)",
    );
    for (const statement of statementsOf(
      "drizzle/0052_quick_quentin_quire.sql",
    )) {
      await client.execute(statement);
    }
    const created = await tables();
    for (const table of [
      "ga4_daily_summary",
      "ga4_daily_acquisition",
      "ga4_daily_landing_pages",
      "ga4_daily_events",
      "ga4_sync_coverage",
      "ga4_syncs",
    ]) {
      expect(created).toContain(table);
    }
    const columns = await client.execute(
      "PRAGMA table_info(gsc_search_performance_syncs)",
    );
    expect(
      columns.rows.some((row) => String(row.name) === "successful_units"),
    ).toBe(true);
  });

  it("registers the migration in both dialect journals", async () => {
    const sqliteJournal = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const pgJournal = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle-pg/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(
      sqliteJournal.entries.some((entry) =>
        entry.tag.includes("0052_quick_quentin_quire"),
      ),
    ).toBe(true);
    expect(
      pgJournal.entries.some((entry) =>
        entry.tag.includes("0030_equal_satana"),
      ),
    ).toBe(true);
  });

  it("applies the geo/technology grain migration to a fresh SQLite database", async () => {
    if (!client) throw new Error("Test database was not initialized");
    for (const statement of statementsOf(
      "drizzle/0060_harsh_scarlet_spider.sql",
    )) {
      await client.execute(statement);
    }
    const created = await tables();
    for (const table of ["ga4_daily_geo", "ga4_daily_technology"]) {
      expect(created).toContain(table);
    }
    const indexes = await client.execute(
      "SELECT name FROM sqlite_master WHERE type = 'index' ORDER BY name",
    );
    const names = indexes.rows.map((row) => String(row.name));
    for (const index of [
      "ga4_geo_upsert_idx",
      "ga4_geo_project_date_idx",
      "ga4_geo_project_country_date_idx",
      "ga4_technology_upsert_idx",
      "ga4_technology_project_date_idx",
      "ga4_technology_project_device_date_idx",
    ]) {
      expect(names).toContain(index);
    }
    const geoColumns = await client.execute("PRAGMA table_info(ga4_daily_geo)");
    const geoNames = geoColumns.rows.map((row) => String(row.name));
    for (const column of [
      "country",
      "sessions",
      "new_users",
      "is_other_row",
    ]) {
      expect(geoNames).toContain(column);
    }
  });

  it("registers the geo/technology migration in both dialect journals", async () => {
    const sqliteJournal = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    const pgJournal = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle-pg/meta/_journal.json"),
        "utf8",
      ),
    ) as { entries: Array<{ tag: string }> };
    expect(
      sqliteJournal.entries.some((entry) =>
        entry.tag.includes("0060_harsh_scarlet_spider"),
      ),
    ).toBe(true);
    expect(
      pgJournal.entries.some((entry) =>
        entry.tag.includes("0038_wakeful_sunspot"),
      ),
    ).toBe(true);
  });
});
