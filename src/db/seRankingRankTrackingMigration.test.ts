import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createClient } from "@libsql/client";
import { describe, expect, it } from "vitest";

const SQLITE_MIGRATION = "drizzle/0078_se_ranking_rank_tracking.sql";
const PG_MIGRATION = "drizzle-pg/0056_se_ranking_rank_tracking.sql";

function read(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

function statementsOf(migrationFile: string): string[] {
  return read(migrationFile)
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

describe("SE Ranking Rank Tracking Migration (D1 & PostgreSQL)", () => {
  it("preserves historical DataForSEO snapshots and supports multi-target + text keyword IDs on SQLite", async () => {
    const client = createClient({ url: "file::memory:" });
    try {
      // Seed prerequisite parent tables and legacy rank_snapshots schema
      await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
      await client.execute(`CREATE TABLE projects (id text PRIMARY KEY)`);
      await client.execute(
        `CREATE TABLE rank_tracking_configs (id text PRIMARY KEY)`,
      );
      await client.execute(
        `CREATE TABLE rank_tracking_keywords (id text PRIMARY KEY)`,
      );
      await client.execute(
        `CREATE TABLE rank_check_runs (id text PRIMARY KEY)`,
      );
      await client.execute(`
        CREATE TABLE rank_snapshots (
          id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
          run_id text NOT NULL,
          project_id text,
          config_id text,
          tracking_keyword_id text NOT NULL,
          keyword text NOT NULL,
          search_engine text DEFAULT 'google' NOT NULL,
          search_type text DEFAULT 'organic' NOT NULL,
          location text,
          language text,
          device text NOT NULL,
          position integer,
          previous_position integer,
          ranking_status text,
          url text,
          serp_features text,
          provider text DEFAULT 'dataforseo' NOT NULL,
          provider_status text,
          provider_status_code integer,
          error_message text,
          checked_at text DEFAULT (current_timestamp) NOT NULL,
          checked_date text,
          created_at text DEFAULT (current_timestamp) NOT NULL,
          updated_at text DEFAULT (current_timestamp) NOT NULL
        )
      `);
      await client.execute(
        `CREATE UNIQUE INDEX rank_snapshots_run_keyword_device_idx ON rank_snapshots (run_id, tracking_keyword_id, device)`,
      );

      // Seed historical DataForSEO snapshot before applying migration
      await client.execute(
        `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, device, position, ranking_status, provider, checked_date) VALUES ('run-dfs-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', '2840', 'en', 'desktop', 6, 'RANKED', 'dataforseo', '2026-10-01')`,
      );

      // Apply migration SQL statements
      for (const stmt of statementsOf(SQLITE_MIGRATION)) {
        await client.execute(stmt);
      }

      // 1. Historical DataForSEO row is untouched and preserves provider attribution
      const legacyRows = await client.execute(
        `SELECT tracking_keyword_id, position, provider, tracking_target_id, country_code FROM rank_snapshots WHERE run_id = 'run-dfs-1'`,
      );
      expect(legacyRows.rows).toHaveLength(1);
      expect(legacyRows.rows[0]?.provider).toBe("dataforseo");
      expect(Number(legacyRows.rows[0]?.position)).toBe(6);

      // 2. Multi-country & countrywide (NULL location) targets in the same run never collide
      await client.execute(
        `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, provider, checked_date) VALUES ('run-sr-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', 'Cairo', 'ar', 'eg', 'Cairo', 'target-eg-cairo', 'desktop', 3, 'RANKED', 'seranking', '2026-11-11')`,
      );
      await client.execute(
        `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, provider, checked_date) VALUES ('run-sr-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', NULL, 'ar', 'eg', NULL, 'target-eg-national', 'desktop', 4, 'RANKED', 'seranking', '2026-11-11')`,
      );
      await client.execute(
        `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, provider, checked_date) VALUES ('run-sr-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', NULL, 'ar', 'sa', NULL, 'target-sa-national', 'desktop', 2, 'RANKED', 'seranking', '2026-11-11')`,
      );

      // 3a. Target-aware duplicate write fails even when location is NULL
      await expect(
        client.execute(
          `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, provider, checked_date) VALUES ('run-sr-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', NULL, 'ar', 'eg', NULL, 'target-eg-national', 'desktop', 9, 'RANKED', 'seranking', '2026-11-11')`,
        ),
      ).rejects.toThrow();

      // 3b. Legacy (tracking_target_id IS NULL) duplicate write rejects within same run/keyword/device
      await expect(
        client.execute(
          `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, device, position, ranking_status, provider, checked_date) VALUES ('run-dfs-1', 'proj-1', 'cfg-1', 'kw-1', 'seo agency', '2840', 'en', 'desktop', 9, 'RANKED', 'dataforseo', '2026-10-01')`,
        ),
      ).rejects.toThrow();

      // 4. All 6 new tables exist & remote_keyword_id accepts string/large IDs without precision loss
      await client.execute(`INSERT INTO organization (id) VALUES ('org-1')`);
      await client.execute(`INSERT INTO projects (id) VALUES ('proj-1')`);
      await client.execute(
        `INSERT INTO rank_tracking_configs (id) VALUES ('cfg-1')`,
      );
      await client.execute(
        `INSERT INTO rank_tracking_keywords (id) VALUES ('kw-1')`,
      );
      await client.execute(
        `INSERT INTO se_ranking_account_bindings (id, organization_id, account_fingerprint) VALUES ('acc-1', 'org-1', 'fp-1')`,
      );
      await client.execute(
        `INSERT INTO se_ranking_project_bindings (id, organization_id, local_project_id, provider_account_binding_id, remote_site_id) VALUES ('pb-1', 'org-1', 'proj-1', 'acc-1', 12345)`,
      );
      await client.execute(
        `INSERT INTO se_ranking_keyword_mappings (id, project_binding_id, tracking_keyword_id, remote_keyword_id) VALUES ('km-1', 'pb-1', 'kw-1', '9007199254740993')`,
      );

      const kwMapRows = await client.execute(
        `SELECT remote_keyword_id FROM se_ranking_keyword_mappings WHERE id = 'km-1'`,
      );
      expect(kwMapRows.rows[0]?.remote_keyword_id).toBe("9007199254740993");
    } finally {
      client.close();
    }
  });

  it("defines matching Postgres migration and journal entries", () => {
    const pgSql = read(PG_MIGRATION);
    expect(pgSql).toContain(
      'CREATE TABLE IF NOT EXISTS "rank_tracking_targets"',
    );
    expect(pgSql).toContain(
      'CREATE TABLE IF NOT EXISTS "se_ranking_keyword_mappings"',
    );
    expect(pgSql).toContain('"remote_keyword_id" text NOT NULL');
    expect(pgSql).toContain(
      'DROP INDEX IF EXISTS "rank_snapshots_run_keyword_device_idx"',
    );
    expect(pgSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "rank_snapshots_run_target_kw_device_idx"',
    );
    expect(pgSql).toContain(
      'CREATE UNIQUE INDEX IF NOT EXISTS "rank_snapshots_legacy_run_kw_device_idx"',
    );

    const d1Journal = JSON.parse(read("drizzle/meta/_journal.json")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    const pgJournal = JSON.parse(read("drizzle-pg/meta/_journal.json")) as {
      entries: Array<{ idx: number; tag: string }>;
    };
    expect(
      d1Journal.entries.some((e) => e.tag === "0078_se_ranking_rank_tracking"),
    ).toBe(true);
    expect(
      pgJournal.entries.some((e) => e.tag === "0056_se_ranking_rank_tracking"),
    ).toBe(true);
  });
});
