import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

const seRankingMocks = vi.hoisted(() => ({
  getCheckDates: vi.fn(),
  getPositions: vi.fn(),
  recheckPositions: vi.fn(),
  createSite: vi.fn(),
  addSiteSearchEngine: vi.fn(),
  addKeywords: vi.fn(),
  updateKeyword: vi.fn(),
  validateAccessAndQuota: vi.fn(),
  listSites: vi.fn(),
  listSiteSearchEngines: vi.fn(),
  listKeywords: vi.fn(),
  verifySiteAccessible: vi.fn(),
}));

const otherProviderMocks = vi.hoisted(() => ({
  dataforseoRequest: vi.fn(),
  serperFetch: vi.fn(),
  zenserpFetch: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/schema");
  const client = createClient({ url: ":memory:" });
  const db = drizzle(client, { schema });
  database.client = client;
  database.db = db;
  return { db };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
    if (!database.db) throw new Error("Test DB not initialized");
    for (const stmt of build(database.db)) await stmt;
  },
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test DB not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return {
    ...actual,
    SeRankingProjectService: seRankingMocks,
  };
});

vi.mock("@/server/lib/dataforseo", () => ({
  createDataforseoClient: () => ({
    request: otherProviderMocks.dataforseoRequest,
  }),
}));

const { RankTrackingRepository } =
  await import("@/server/features/rank-tracking/repositories/RankTrackingRepository");
const { getKeywordHistory, getLatestValidSnapshotsForKeywords } =
  await import("@/server/features/rank-tracking/repositories/snapshotQueries");
const { buildScopedPendingPairs } = await import("./seRankingCheckTargets");
const { synchronizeSeRankingDailyObservations } =
  await import("./seRankingDailySync");

const CONFIG_ID = "2971425d-d350-4ee3-89b2-c83567c87713";
const PROJECT_ID = "367587e1-0c77-4d58-a2f8-7d7a171adfcb";
const ORG_ID = "delegated-local-admin";
const PROJECT_BINDING_ID = "0f24afa1-7728-4128-8bcc-b21e4235760b";
const DESKTOP_TARGET_ID = "e06e6d4a-59cb-4a5a-960e-d8910552f735";
const MOBILE_TARGET_ID = "911aa14a-b8a7-4c06-8b5d-365ed93ae03b";
const DESKTOP_ENGINE_ID = 539194;
const MOBILE_ENGINE_ID = 545914;

const PROPOSED_SIX_KEYWORDS = [
  {
    id: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
    keyword: "إنشاء ملاعب متعددة الأغراض",
    remoteId: "24606031",
    positionsByDate: {
      "2026-11-11": { desktop: 65, mobile: 38 },
      "2026-11-12": { desktop: 62, mobile: 35 },
      "2026-11-13": { desktop: 85, mobile: 46 },
      "2026-11-14": { desktop: 86, mobile: 47 },
    },
  },
  {
    id: "4bb3e3ac-3c10-464f-ae90-6c7b13b9c984",
    keyword: "ملعب كرة قدم خماسي",
    remoteId: "24609001",
    positionsByDate: {
      "2026-11-11": { desktop: 14, mobile: 11 },
      "2026-11-12": { desktop: 13, mobile: 10 },
      "2026-11-13": { desktop: 12, mobile: 9 },
      "2026-11-14": { desktop: 11, mobile: 9 },
    },
  },
  {
    id: "728c64ca-83f0-4bf7-8470-b4deea18595a",
    keyword: "مساحة ملعب خماسي",
    remoteId: "24609002",
    positionsByDate: {
      "2026-11-11": { desktop: 8, mobile: 7 },
      "2026-11-12": { desktop: 8, mobile: 6 },
      "2026-11-13": { desktop: 7, mobile: 6 },
      "2026-11-14": { desktop: 7, mobile: 5 },
    },
  },
  {
    id: "2edf9ce7-4ed0-4bae-b7b5-c1ce19bc3305",
    keyword: "ملاعب الخماسي",
    remoteId: "24609003",
    positionsByDate: {
      "2026-11-11": { desktop: 22, mobile: 19 },
      "2026-11-12": { desktop: 21, mobile: 18 },
      "2026-11-13": { desktop: 20, mobile: 17 },
      "2026-11-14": { desktop: 19, mobile: 16 },
    },
  },
  {
    id: "88c5e577-1bc7-4b58-863e-265f60fb3924",
    keyword: "تكلفة ملعب خماسي",
    remoteId: "24609004",
    positionsByDate: {
      "2026-11-11": { desktop: 5, mobile: 4 },
      "2026-11-12": { desktop: 5, mobile: 4 },
      "2026-11-13": { desktop: 4, mobile: 3 },
      "2026-11-14": { desktop: 4, mobile: 3 },
    },
  },
  {
    id: "26b1d63b-f304-42c1-9916-4552a290ee20",
    keyword: "ترتان صناعي",
    remoteId: "24609005",
    positionsByDate: {
      "2026-11-11": { desktop: 31, mobile: 28 },
      "2026-11-12": { desktop: 30, mobile: 27 },
      "2026-11-13": { desktop: 29, mobile: 25 },
      "2026-11-14": { desktop: 28, mobile: 24 },
    },
  },
] as const;

describe("Controlled Multi-Keyword Pilot Expansion Offline Verification (6 keywords x 2 targets = 12 pairs)", () => {
  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");

    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(
      `CREATE TABLE projects (id text PRIMARY KEY, organization_id text)`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_configs (
        id text PRIMARY KEY,
        project_id text,
        domain text,
        search_engine text DEFAULT 'google',
        location text,
        language text,
        devices text DEFAULT 'both',
        schedule_interval text DEFAULT 'weekly',
        is_active integer DEFAULT 1
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_targets (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        local_project_id text NOT NULL,
        tracking_config_id text,
        search_engine text NOT NULL,
        country_code text NOT NULL,
        region_code text,
        city_name text,
        language_code text NOT NULL,
        device text NOT NULL,
        enabled integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp),
        updated_at text DEFAULT (current_timestamp)
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_tracking_keyword_targets (
        id text PRIMARY KEY,
        tracking_keyword_id text NOT NULL,
        tracking_target_id text NOT NULL,
        enabled integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_project_bindings (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        local_project_id text NOT NULL,
        remote_site_id integer NOT NULL,
        status text DEFAULT 'connected' NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_engine_bindings (
        id text PRIMARY KEY,
        project_binding_id text NOT NULL,
        tracking_target_id text NOT NULL,
        remote_site_engine_id integer NOT NULL,
        remote_search_engine_id integer NOT NULL,
        remote_region_id integer,
        remote_region_name text,
        remote_language_code text,
        sync_status text DEFAULT 'connected' NOT NULL,
        last_successful_sync text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE se_ranking_keyword_mappings (
        id text PRIMARY KEY,
        project_binding_id text NOT NULL,
        tracking_keyword_id text NOT NULL,
        remote_keyword_id text NOT NULL,
        status text DEFAULT 'synced' NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_check_runs (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        project_id text NOT NULL,
        status text DEFAULT 'pending' NOT NULL,
        keywords_total integer DEFAULT 0 NOT NULL,
        keywords_checked integer DEFAULT 0 NOT NULL,
        trigger text DEFAULT 'manual' NOT NULL,
        is_subset_run integer DEFAULT 0 NOT NULL,
        error_message text,
        started_at text DEFAULT (current_timestamp) NOT NULL,
        completed_at text
      )`,
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
        completion_confidence text,
        observation_source text,
        tracking_target_id text,
        country_code text,
        city_name text,
        checked_at text DEFAULT (current_timestamp) NOT NULL,
        checked_date text,
        imported_at text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(
      `CREATE TABLE rank_provider_calls (
        id integer PRIMARY KEY AUTOINCREMENT NOT NULL,
        run_id text NOT NULL,
        tracking_keyword_id text NOT NULL,
        device text NOT NULL,
        provider text NOT NULL,
        endpoint text NOT NULL,
        status text NOT NULL,
        http_status integer,
        error_code text,
        skip_reason text,
        circuit_reason text,
        circuit_opened_at text,
        circuit_expires_at text,
        attempt integer,
        max_retries integer,
        retryable integer,
        retry_after_ms integer,
        duration_ms integer NOT NULL,
        result_count integer,
        requested_depth integer DEFAULT 0 NOT NULL,
        inspected_depth integer,
        pages_requested integer DEFAULT 0 NOT NULL,
        result_completeness text DEFAULT 'not_applicable' NOT NULL,
        dispatched integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL
      )`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_run_target_kw_device_idx ON rank_snapshots (run_id, tracking_target_id, tracking_keyword_id, device, checked_date) WHERE tracking_target_id IS NOT NULL`,
    );
    await client.execute(
      `CREATE UNIQUE INDEX rank_snapshots_legacy_run_kw_device_idx ON rank_snapshots (run_id, tracking_keyword_id, device) WHERE tracking_target_id IS NULL`,
    );
  });

  beforeEach(async () => {
    vi.clearAllMocks();
    const client = database.client!;
    await client.execute(`DELETE FROM rank_provider_calls`);
    await client.execute(`DELETE FROM rank_snapshots`);
    await client.execute(`DELETE FROM rank_check_runs`);
    await client.execute(`DELETE FROM se_ranking_keyword_mappings`);
    await client.execute(`DELETE FROM se_ranking_engine_bindings`);
    await client.execute(`DELETE FROM se_ranking_project_bindings`);
    await client.execute(`DELETE FROM rank_tracking_targets`);
    await client.execute(`DELETE FROM rank_tracking_configs`);
    await client.execute(`DELETE FROM projects`);
    await client.execute(`DELETE FROM organization`);

    await client.execute(`INSERT INTO organization (id) VALUES ('${ORG_ID}')`);
    await client.execute(
      `INSERT INTO projects (id, organization_id) VALUES ('${PROJECT_ID}', '${ORG_ID}')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_configs (id, project_id, domain) VALUES ('${CONFIG_ID}', '${PROJECT_ID}', 'sports-ms.com')`,
    );
    await client.execute(
      `INSERT INTO se_ranking_project_bindings (id, organization_id, local_project_id, remote_site_id) VALUES ('${PROJECT_BINDING_ID}', '${ORG_ID}', '${PROJECT_ID}', 13188608)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, search_engine, country_code, language_code, device, enabled)
       VALUES ('${DESKTOP_TARGET_ID}', '${ORG_ID}', '${PROJECT_ID}', '${CONFIG_ID}', 'google', 'eg', 'ar', 'desktop', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, search_engine, country_code, language_code, device, enabled)
       VALUES ('${MOBILE_TARGET_ID}', '${ORG_ID}', '${PROJECT_ID}', '${CONFIG_ID}', 'google', 'eg', 'ar', 'mobile', 1)`,
    );
    await client.execute(
      `INSERT INTO se_ranking_engine_bindings (id, project_binding_id, tracking_target_id, remote_site_engine_id, remote_search_engine_id, remote_language_code, sync_status)
       VALUES ('eb-desktop', '${PROJECT_BINDING_ID}', '${DESKTOP_TARGET_ID}', ${DESKTOP_ENGINE_ID}, 250, 'ar', 'connected')`,
    );
    await client.execute(
      `INSERT INTO se_ranking_engine_bindings (id, project_binding_id, tracking_target_id, remote_site_engine_id, remote_search_engine_id, remote_language_code, sync_status)
       VALUES ('eb-mobile', '${PROJECT_BINDING_ID}', '${MOBILE_TARGET_ID}', ${MOBILE_ENGINE_ID}, 1590, 'ar', 'connected')`,
    );

    for (const kw of PROPOSED_SIX_KEYWORDS) {
      await client.execute({
        sql: `INSERT INTO se_ranking_keyword_mappings (id, project_binding_id, tracking_keyword_id, remote_keyword_id, status) VALUES (?, ?, ?, ?, 'synced')`,
        args: [`map-${kw.id}`, PROJECT_BINDING_ID, kw.id, kw.remoteId],
      });
    }

    // Existing historical manual snapshots on pilot keyword remain untouched
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, trigger, is_subset_run, keywords_total, keywords_checked, started_at, completed_at)
       VALUES ('run-existing-manual', '${CONFIG_ID}', '${PROJECT_ID}', 'partial', 'manual', 1, 1, 1, '2026-11-13 21:45:57', '2026-11-13 21:54:09')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, country_code, language, checked_at, checked_date, url)
       VALUES (9762, 'run-existing-manual', '${PROJECT_ID}', '${CONFIG_ID}', '28131aad-fe42-43b6-bfdb-5fe0d7e046a3', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 62, 37, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'manual_recheck', '${DESKTOP_TARGET_ID}', 'eg', 'ar', '2026-11-13 17:38:38', '2026-11-13', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, country_code, language, checked_at, checked_date, url)
       VALUES (9764, 'run-existing-manual', '${PROJECT_ID}', '${CONFIG_ID}', '28131aad-fe42-43b6-bfdb-5fe0d7e046a3', 'إنشاء ملاعب متعددة الأغراض', 'mobile', 46, 35, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'manual_recheck', '${MOBILE_TARGET_ID}', 'eg', 'ar', '2026-11-13 21:50:04', '2026-11-13', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
  });

  it("allocates exact 12 keyword-target pairs, imports multi-day backfill idempotently, preserves existing snapshots, and isolates manual Check All from scheduled trigger", async () => {
    const pairs = await buildScopedPendingPairs({
      projectBindingId: PROJECT_BINDING_ID,
      targets: [
        {
          id: DESKTOP_TARGET_ID,
          device: "desktop",
          countryCode: "eg",
          cityName: null,
          languageCode: "ar",
          searchEngine: "google",
        },
        {
          id: MOBILE_TARGET_ID,
          device: "mobile",
          countryCode: "eg",
          cityName: null,
          languageCode: "ar",
          searchEngine: "google",
        },
      ],
      keywords: PROPOSED_SIX_KEYWORDS.map((k) => ({
        id: k.id,
        keyword: k.keyword,
      })),
    });

    // 6 keywords x 2 targets = 12 pairs
    expect(pairs).toHaveLength(12);
    expect(
      pairs.filter((p) => p.remoteSiteEngineId === DESKTOP_ENGINE_ID),
    ).toHaveLength(6);
    expect(
      pairs.filter((p) => p.remoteSiteEngineId === MOBILE_ENGINE_ID),
    ).toHaveLength(6);
    expect(pairs.every((p) => Boolean(p.remoteKeywordId))).toBe(true);

    // 1. Manual "Check All" with isSubsetRun=false must NOT count as scheduled run
    const createdManualAll = await RankTrackingRepository.tryCreateRun({
      id: "run-manual-check-all",
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "manual",
      isSubsetRun: false,
    });
    expect(createdManualAll).toBe(true);
    await RankTrackingRepository.updateRun("run-manual-check-all", {
      status: "completed",
      completedAt: "2026-11-14 14:00:00",
    });
    expect(
      await RankTrackingRepository.getLatestScheduledRunForConfig(CONFIG_ID),
    ).toBeNull();

    // 2. Scheduled read-only sync run #1 (single run imports 4-day backfill Nov 11..14 for all 6 keywords x 2 targets = 48 snapshots)
    const dates = [
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
    ] as const;
    seRankingMocks.getCheckDates.mockResolvedValue([...dates]);
    seRankingMocks.getPositions.mockImplementation(async (_client, params) => {
      const device =
        params.siteEngineId === MOBILE_ENGINE_ID ? "mobile" : "desktop";
      return PROPOSED_SIX_KEYWORDS.map((kw) => ({
        id: kw.remoteId,
        name: kw.keyword,
        normalizedKeywordId: kw.remoteId,
        normalizedKeyword: kw.keyword,
        serpFeaturesList: [],
        positions: Object.entries(kw.positionsByDate).map(([date, pos]) => ({
          date,
          pos: pos[device],
          change: 0,
        })),
        landing_pages: [
          {
            url: `https://sports-ms.com/landing/${kw.remoteId}`,
            date: "2026-11-14",
          },
        ],
        serp_features: [],
      }));
    });

    const backfillRunId = "run-sched-backfill";
    await RankTrackingRepository.tryCreateRun({
      id: backfillRunId,
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "scheduled",
      isSubsetRun: false,
    });

    const syncOutcome = await synchronizeSeRankingDailyObservations({
      client: {} as never,
      remoteSiteId: 13188608,
      runId: backfillRunId,
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      today: "2026-11-14",
      pendingPairs: pairs,
      previousPositions: new Map(),
    });

    expect(syncOutcome.collectedCount).toBe(12);
    expect(syncOutcome.importedCount).toBe(48); // 12 pairs x 4 dates in one backfill run
    expect(syncOutcome.stillPending).toHaveLength(0);
    await RankTrackingRepository.updateRun(backfillRunId, {
      status: "completed",
      keywordsChecked: 6,
      completedAt: "2026-11-14 21:15:00",
    });

    // 3a. Incremental replay daily sync (no replayFromDate) -> checks latest date (2026-11-14) = 12 deduplicated, 0 new inserts
    const replayRunId = "run-sched-2026-11-14-replay";
    await RankTrackingRepository.tryCreateRun({
      id: replayRunId,
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "scheduled",
      isSubsetRun: false,
    });
    const replayOutcome = await synchronizeSeRankingDailyObservations({
      client: {} as never,
      remoteSiteId: 13188608,
      runId: replayRunId,
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      today: "2026-11-14",
      pendingPairs: pairs,
      previousPositions: new Map(),
    });
    expect(replayOutcome.collectedCount).toBe(12);
    expect(replayOutcome.importedCount).toBe(0);
    expect(replayOutcome.deduplicatedCount).toBe(12); // latest date >= earliestNeedDate (2026-11-14)

    // 3b. Full 48-observation replay idempotency (replay all 4 dates Nov 11..14 across all 12 pairs)
    const snapshotCountBeforeFullReplay = await database.client!.execute(
      `SELECT count(*) as cnt FROM rank_snapshots WHERE config_id = '${CONFIG_ID}'`,
    );
    expect(Number(snapshotCountBeforeFullReplay.rows[0]?.cnt)).toBe(50); // 48 backfilled + 2 existing manual (9762, 9764)

    const fullReplayRunId = "run-sched-2026-11-14-full-replay";
    await RankTrackingRepository.tryCreateRun({
      id: fullReplayRunId,
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "scheduled",
      isSubsetRun: false,
    });
    const fullReplayOutcome = await synchronizeSeRankingDailyObservations({
      client: {} as never,
      remoteSiteId: 13188608,
      runId: fullReplayRunId,
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      today: "2026-11-14",
      replayFromDate: "2026-11-11",
      pendingPairs: pairs,
      previousPositions: new Map(),
    });
    expect(fullReplayOutcome.collectedCount).toBe(12);
    expect(fullReplayOutcome.importedCount).toBe(0);
    expect(fullReplayOutcome.deduplicatedCount).toBe(48); // Every single one of the 48 keyword-target-date observations identified

    const snapshotCountAfterFullReplay = await database.client!.execute(
      `SELECT count(*) as cnt FROM rank_snapshots WHERE config_id = '${CONFIG_ID}'`,
    );
    expect(Number(snapshotCountAfterFullReplay.rows[0]?.cnt)).toBe(50); // Zero additional snapshots inserted

    // 3c. Provider correction remains supported across the 48-observation window without colliding with the other 47
    seRankingMocks.getPositions.mockImplementation(async (_client, params) => {
      const device =
        params.siteEngineId === MOBILE_ENGINE_ID ? "mobile" : "desktop";
      return PROPOSED_SIX_KEYWORDS.map((kw) => ({
        id: kw.remoteId,
        name: kw.keyword,
        normalizedKeywordId: kw.remoteId,
        normalizedKeyword: kw.keyword,
        serpFeaturesList: [],
        positions: Object.entries(kw.positionsByDate).map(([date, pos]) => ({
          date,
          // Provider amends only ملعب كرة قدم خماسي Desktop on 2026-11-12: 13 -> 12
          pos:
            kw.id === "4bb3e3ac-3c10-464f-ae90-6c7b13b9c984" &&
            device === "desktop" &&
            date === "2026-11-12"
              ? 12
              : pos[device],
          change: 0,
        })),
        landing_pages: [
          {
            url: `https://sports-ms.com/landing/${kw.remoteId}`,
            date: "2026-11-14",
          },
        ],
        serp_features: [],
      }));
    });

    const correctionRunId = "run-sched-2026-11-15-correction";
    await RankTrackingRepository.tryCreateRun({
      id: correctionRunId,
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "scheduled",
      isSubsetRun: false,
    });
    const correctionOutcome = await synchronizeSeRankingDailyObservations({
      client: {} as never,
      remoteSiteId: 13188608,
      runId: correctionRunId,
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      today: "2026-11-14",
      replayFromDate: "2026-11-11",
      pendingPairs: pairs,
      previousPositions: new Map(),
    });
    expect(correctionOutcome.collectedCount).toBe(12);
    expect(correctionOutcome.importedCount).toBe(1);
    expect(correctionOutcome.deduplicatedCount).toBe(47);
    await RankTrackingRepository.updateRun(correctionRunId, {
      status: "completed",
      keywordsChecked: 6,
      completedAt: "2026-11-15 10:00:00",
    });

    // Replaying all 48 again after the correction -> 48 deduplicated, 0 imported
    const postCorrectionReplayRunId =
      "run-sched-2026-11-15-post-correction-replay";
    await RankTrackingRepository.tryCreateRun({
      id: postCorrectionReplayRunId,
      configId: CONFIG_ID,
      projectId: PROJECT_ID,
      keywordsTotal: 6,
      trigger: "scheduled",
      isSubsetRun: false,
    });
    const postCorrectionOutcome = await synchronizeSeRankingDailyObservations({
      client: {} as never,
      remoteSiteId: 13188608,
      runId: postCorrectionReplayRunId,
      projectId: PROJECT_ID,
      configId: CONFIG_ID,
      today: "2026-11-14",
      replayFromDate: "2026-11-11",
      pendingPairs: pairs,
      previousPositions: new Map(),
    });
    expect(postCorrectionOutcome.importedCount).toBe(0);
    expect(postCorrectionOutcome.deduplicatedCount).toBe(48);

    const snapshotCountAfterCorrection = await database.client!.execute(
      `SELECT count(*) as cnt FROM rank_snapshots WHERE config_id = '${CONFIG_ID}'`,
    );
    expect(Number(snapshotCountAfterCorrection.rows[0]?.cnt)).toBe(51); // Only the +1 corrected snapshot added; post-correction replay added 0

    // No unrelated keyword collisions: check amended keyword updated while neighbor keyword stayed untouched
    const amendedHist = await getKeywordHistory(
      CONFIG_ID,
      "4bb3e3ac-3c10-464f-ae90-6c7b13b9c984",
      30,
      DESKTOP_TARGET_ID,
    );
    expect(
      amendedHist.find((h) => h.checkedDate === "2026-11-12")?.position,
    ).toBe(12);
    const neighborHist = await getKeywordHistory(
      CONFIG_ID,
      "728c64ca-83f0-4bf7-8470-b4deea18595a",
      30,
      DESKTOP_TARGET_ID,
    );
    expect(
      neighborHist.find((h) => h.checkedDate === "2026-11-12")?.position,
    ).toBe(8);

    // 4. Verify latest snapshots across ALL 6 keywords on both targets (12 distinct latest pairs)
    const desktopLatest = await getLatestValidSnapshotsForKeywords(
      CONFIG_ID,
      DESKTOP_TARGET_ID,
    );
    const mobileLatest = await getLatestValidSnapshotsForKeywords(
      CONFIG_ID,
      MOBILE_TARGET_ID,
    );
    expect(desktopLatest).toHaveLength(6);
    expect(mobileLatest).toHaveLength(6);

    for (const kw of PROPOSED_SIX_KEYWORDS) {
      const dHist = await getKeywordHistory(
        CONFIG_ID,
        kw.id,
        30,
        DESKTOP_TARGET_ID,
      );
      expect(dHist).toHaveLength(4);
      expect(dHist.map((h) => h.checkedDate)).toEqual([...dates]);
      expect(dHist.every((h) => h.observationSource === "daily_sync")).toBe(
        true,
      );
      expect(
        dHist.every((h) => h.checkedAt !== `${h.checkedDate} 12:00:00`),
      ).toBe(true);
    }

    // 5. Existing manual snapshots (9762, 9764) preserved untouched
    const rawManual = await database.client!.execute(
      `SELECT id, position, observation_source FROM rank_snapshots WHERE id IN (9762, 9764) ORDER BY id ASC`,
    );
    expect(rawManual.rows).toHaveLength(2);
    expect(rawManual.rows.map((r) => r.position)).toEqual([62, 46]);

    // 6. Zero remote writes & zero non-SE-Ranking provider calls
    expect(seRankingMocks.recheckPositions).not.toHaveBeenCalled();
    expect(seRankingMocks.createSite).not.toHaveBeenCalled();
    expect(seRankingMocks.addSiteSearchEngine).not.toHaveBeenCalled();
    expect(seRankingMocks.addKeywords).not.toHaveBeenCalled();
    expect(seRankingMocks.updateKeyword).not.toHaveBeenCalled();
    expect(otherProviderMocks.dataforseoRequest).not.toHaveBeenCalled();
    expect(otherProviderMocks.serperFetch).not.toHaveBeenCalled();
    expect(otherProviderMocks.zenserpFetch).not.toHaveBeenCalled();
  });
});
