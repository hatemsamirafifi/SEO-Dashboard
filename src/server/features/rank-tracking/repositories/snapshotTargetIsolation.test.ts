/**
 * Verifies real SQLite target-scoped filtering across snapshotQueries &
 * rankTrackingResults so multi-country & NULL-location targets never bleed.
 */
import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import {
  getLatestPositionsMap,
  getKeywordHistory,
  getConfigTrend,
  getPositionMatrix,
  getLatestSnapshotsForKeywords,
} from "./snapshotQueries";

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

describe("snapshotQueries trackingTargetId isolation", () => {
  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");
    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(`CREATE TABLE projects (id text PRIMARY KEY)`);
    await client.execute(
      `CREATE TABLE rank_tracking_configs (id text PRIMARY KEY)`,
    );
    await client.execute(`
      CREATE TABLE rank_check_runs (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        project_id text NOT NULL,
        trigger text NOT NULL,
        devices text NOT NULL,
        status text NOT NULL,
        is_subset_run integer DEFAULT 0 NOT NULL,
        keywords_total integer DEFAULT 0 NOT NULL,
        keywords_checked integer DEFAULT 0 NOT NULL,
        started_at text NOT NULL
      )
    `);
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
        provider text DEFAULT 'seranking' NOT NULL,
        provider_status text,
        provider_status_code integer,
        error_message text,
        tracking_target_id text,
        country_code text,
        city_name text,
        checked_at text NOT NULL,
        checked_date text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
  });

  beforeEach(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");
    await client.execute(`DELETE FROM rank_snapshots`);
    await client.execute(`DELETE FROM rank_check_runs`);

    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, trigger, devices, status, is_subset_run, keywords_total, keywords_checked, started_at) VALUES ('run-1', 'cfg-1', 'proj-1', 'manual', 'both', 'completed', 0, 1, 1, '2026-11-10 10:05:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, checked_at, checked_date) VALUES ('run-1', 'proj-1', 'cfg-1', 'kw-1', 'seo', NULL, 'ar', 'eg', NULL, 'target-eg', 'desktop', 2, 'RANKED', '2026-11-10 10:05:00', '2026-11-10')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (run_id, project_id, config_id, tracking_keyword_id, keyword, location, language, country_code, city_name, tracking_target_id, device, position, ranking_status, checked_at, checked_date) VALUES ('run-1', 'proj-1', 'cfg-1', 'kw-1', 'seo', NULL, 'ar', 'sa', NULL, 'target-sa', 'desktop', 14, 'RANKED', '2026-11-10 10:05:00', '2026-11-10')`,
    );
  });

  it("isolates latest map, keyword history, trend, matrix, and latest snapshots per targetId", async () => {
    const egLatest = await getLatestSnapshotsForKeywords("cfg-1", "target-eg");
    const saLatest = await getLatestSnapshotsForKeywords("cfg-1", "target-sa");
    expect(egLatest).toHaveLength(1);
    expect(egLatest[0]?.position).toBe(2);
    expect(saLatest).toHaveLength(1);
    expect(saLatest[0]?.position).toBe(14);

    const egHistory = await getKeywordHistory(
      "cfg-1",
      "kw-1",
      365,
      "target-eg",
    );
    const saHistory = await getKeywordHistory(
      "cfg-1",
      "kw-1",
      365,
      "target-sa",
    );
    expect(egHistory.map((h) => h.position)).toEqual([2]);
    expect(saHistory.map((h) => h.position)).toEqual([14]);

    const egTrend = await getConfigTrend("cfg-1", "desktop", 365, "target-eg");
    const saTrend = await getConfigTrend("cfg-1", "desktop", 365, "target-sa");
    expect(Number(egTrend[0]?.top3)).toBe(1);
    expect(Number(saTrend[0]?.top3)).toBe(0);
    expect(Number(saTrend[0]?.top11to20)).toBe(1);

    const egMatrix = await getPositionMatrix(
      "cfg-1",
      "desktop",
      10,
      "target-eg",
    );
    const saMatrix = await getPositionMatrix(
      "cfg-1",
      "desktop",
      10,
      "target-sa",
    );
    expect(egMatrix[0]?.position).toBe(2);
    expect(saMatrix[0]?.position).toBe(14);

    const allMap = await getLatestPositionsMap("cfg-1", [
      { keywordId: "kw-1", device: "desktop" },
    ]);
    expect(allMap.get("target-eg:kw-1:desktop")).toBe(2);
    expect(allMap.get("target-sa:kw-1:desktop")).toBe(14);
  });
});
