/**
 * Real SQLite idempotency & isolation tests for RankTrackingRepository.insertSnapshots:
 * - Multi-country targets (Egypt vs Saudi Arabia) and NULL locations never collide
 * - Retried inserts with identical target-aware or legacy keys deduplicate idempotently
 */
import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import * as appSchema from "@/db/app.schema";

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

const { RankTrackingRepository } = await import("./RankTrackingRepository");

describe("RankTrackingRepository.insertSnapshots partial conflict targets", () => {
  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");
    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(`CREATE TABLE projects (id text PRIMARY KEY)`);
    await client.execute(
      `CREATE TABLE rank_tracking_configs (id text PRIMARY KEY)`,
    );
    await client.execute(`CREATE TABLE rank_check_runs (id text PRIMARY KEY)`);
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
        tracking_target_id text,
        country_code text,
        city_name text,
        checked_at text DEFAULT (current_timestamp) NOT NULL,
        checked_date text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_run_target_kw_device_idx ON rank_snapshots (run_id, tracking_target_id, tracking_keyword_id, device) WHERE tracking_target_id IS NOT NULL`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_legacy_run_kw_device_idx ON rank_snapshots (run_id, tracking_keyword_id, device) WHERE tracking_target_id IS NULL`,
    );
  });

  beforeEach(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");
    await client.execute(`DELETE FROM rank_snapshots`);
  });

  it("keeps Egypt & Saudi Arabia countrywide targets separate and deduplicates workflow retries with NULL locations", async () => {
    const batch = [
      {
        runId: "run-sr-multi",
        projectId: "proj-1",
        configId: "cfg-1",
        trackingKeywordId: "kw-1",
        keyword: "crm software",
        searchEngine: "google",
        searchType: "organic",
        location: null,
        language: "ar",
        countryCode: "eg",
        cityName: null,
        trackingTargetId: "target-eg-national",
        device: "desktop" as const,
        position: 5,
        previousPosition: null,
        rankingStatus: "RANKED" as const,
        url: "https://example.com/eg",
        serpFeatures: null,
        provider: "seranking",
        providerStatus: "checked",
        providerStatusCode: null,
        errorMessage: null,
        checkedDate: "2026-11-11",
      },
      {
        runId: "run-sr-multi",
        projectId: "proj-1",
        configId: "cfg-1",
        trackingKeywordId: "kw-1",
        keyword: "crm software",
        searchEngine: "google",
        searchType: "organic",
        location: null,
        language: "ar",
        countryCode: "sa",
        cityName: null,
        trackingTargetId: "target-sa-national",
        device: "desktop" as const,
        position: 2,
        previousPosition: null,
        rankingStatus: "RANKED" as const,
        url: "https://example.com/sa",
        serpFeatures: null,
        provider: "seranking",
        providerStatus: "checked",
        providerStatusCode: null,
        errorMessage: null,
        checkedDate: "2026-11-11",
      },
    ];

    await RankTrackingRepository.insertSnapshots(batch);
    // Simulate durable workflow step retry inserting the exact same NULL-location observations
    await RankTrackingRepository.insertSnapshots(batch);

    const db = database.db as {
      select: () => {
        from: (t: typeof appSchema.rankSnapshots) => Promise<unknown[]>;
      };
    };
    const rows = (await db.select().from(appSchema.rankSnapshots)) as Array<{
      trackingTargetId: string | null;
      countryCode: string | null;
      position: number | null;
    }>;

    expect(rows).toHaveLength(2);
    expect(
      rows.map((r) => [r.trackingTargetId, r.countryCode, r.position]),
    ).toEqual([
      ["target-eg-national", "eg", 5],
      ["target-sa-national", "sa", 2],
    ]);
  });

  it("deduplicates legacy DataForSEO (trackingTargetId IS NULL) retries without touching target-aware rows", async () => {
    const legacy = {
      runId: "run-dfs-1",
      projectId: "proj-1",
      configId: "cfg-1",
      trackingKeywordId: "kw-1",
      keyword: "crm software",
      searchEngine: "google",
      searchType: "organic",
      location: null,
      language: null,
      countryCode: null,
      cityName: null,
      trackingTargetId: null,
      device: "mobile" as const,
      position: 11,
      previousPosition: null,
      rankingStatus: "RANKED" as const,
      url: "https://example.com",
      serpFeatures: null,
      provider: "dataforseo",
      providerStatus: null,
      providerStatusCode: null,
      errorMessage: null,
      checkedDate: "2026-10-15",
    };

    await RankTrackingRepository.insertSnapshots([legacy]);
    await RankTrackingRepository.insertSnapshots([{ ...legacy, position: 99 }]);

    const rows = await RankTrackingRepository.getSnapshotsForRun("run-dfs-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.position).toBe(11);
    expect(rows[0]?.provider).toBe("dataforseo");
  });
});
