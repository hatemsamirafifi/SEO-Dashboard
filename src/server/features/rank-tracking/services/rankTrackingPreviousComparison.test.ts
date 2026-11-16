import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthInfo } from "@modelcontextprotocol/sdk/server/auth/types.js";
import type { ToolExtra } from "@/server/mcp/context";
import { MCP_AUTH_CONTEXT_PROP } from "@/server/mcp/context";

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/schema");
  const client = createClient({ url: "file::memory:" });
  const db = drizzle(client, { schema });
  database.client = client;
  database.db = db;
  return {
    db,
    withPgClient: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  };
});

vi.mock("@/server/features/projects/services/ProjectService", () => ({
  ProjectService: {
    getProjectForOrganization: vi.fn(async (projectId: string) => ({
      id: projectId,
      name: "sports-ms.com",
      domain: "sports-ms.com",
      locationCode: 2818,
      languageCode: "ar",
    })),
  },
}));

const { getLatestResults } = await import("./rankTrackingResults");
const { getRankTrackerTool } =
  await import("@/server/mcp/tools/get-rank-tracker");

const PROJECT_ID = "367587e1-0c77-4d58-a2f8-7d7a171adfcb";
const CONFIG_ID = "2971425d-d350-4ee3-89b2-c83567c87713";
const KW_ID = "28131aad-fe42-43b6-bfdb-5fe0d7e046a3";
const KW_SINGLE = "kw-single-observation";
const TARGET_EG_DESKTOP = "e06e6d4a-59cb-4a5a-960e-d8910552f735";
const TARGET_EG_MOBILE = "911aa14a-b8a7-4c06-8b5d-365ed93ae03b";
const TARGET_SA_DESKTOP = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

const toolExtra: ToolExtra = {
  signal: new AbortController().signal,
  requestId: 1,
  sendNotification: vi.fn(),
  sendRequest: vi.fn(),
  authInfo: {
    token: "token",
    clientId: "client_1",
    scopes: ["mcp"],
    resource: new URL("https://open-seo.test/mcp"),
    extra: {
      [MCP_AUTH_CONTEXT_PROP]: {
        userId: "user_1",
        userEmail: "test@example.com",
        organizationId: "delegated-local-admin",
        clientId: "client_1",
        scopes: ["mcp"],
        audience: "https://open-seo.test/mcp",
        subject: "user_1",
        baseUrl: "https://open-seo.test",
      },
    },
  } satisfies AuthInfo,
};

describe("Rank Tracking previous comparable position & MCP semantics", () => {
  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");

    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(
      `CREATE TABLE projects (id text PRIMARY KEY, organization_id text NOT NULL, name text, archived_at text)`,
    );
    await client.execute(`
      CREATE TABLE rank_tracking_configs (
        id text PRIMARY KEY,
        project_id text NOT NULL,
        domain text NOT NULL,
        search_engine text DEFAULT 'google' NOT NULL,
        location_code integer DEFAULT 2818 NOT NULL,
        location_name text,
        language_code text DEFAULT 'ar' NOT NULL,
        devices text DEFAULT 'both' NOT NULL,
        serp_depth integer DEFAULT 60 NOT NULL,
        schedule_interval text DEFAULT 'weekly' NOT NULL,
        is_active integer DEFAULT 1 NOT NULL,
        last_checked_at text,
        next_check_at text,
        last_skip_reason text,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE rank_tracking_keywords (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        keyword text NOT NULL,
        search_volume integer,
        keyword_difficulty integer,
        cpc real,
        metrics_fetched_at text,
        created_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE rank_tracking_targets (
        id text PRIMARY KEY,
        organization_id text NOT NULL,
        local_project_id text NOT NULL,
        tracking_config_id text,
        search_engine text DEFAULT 'google' NOT NULL,
        country_code text NOT NULL,
        region_code text,
        city_name text,
        language_code text DEFAULT 'ar' NOT NULL,
        device text NOT NULL,
        enabled integer DEFAULT 1 NOT NULL,
        created_at text DEFAULT (current_timestamp) NOT NULL,
        updated_at text DEFAULT (current_timestamp) NOT NULL
      )
    `);
    await client.execute(`
      CREATE TABLE rank_check_runs (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        project_id text NOT NULL,
        trigger text DEFAULT 'manual' NOT NULL,
        devices text DEFAULT 'both' NOT NULL,
        status text NOT NULL,
        is_subset_run integer DEFAULT 0 NOT NULL,
        keywords_total integer DEFAULT 0 NOT NULL,
        keywords_checked integer DEFAULT 0 NOT NULL,
        started_at text DEFAULT (current_timestamp) NOT NULL,
        completed_at text
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
      `INSERT INTO organization (id) VALUES ('delegated-local-admin')`,
    );
    await client.execute(
      `INSERT INTO projects (id, organization_id, name) VALUES ('${PROJECT_ID}', 'delegated-local-admin', 'sports-ms.com')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_configs (id, project_id, domain, schedule_interval, devices, serp_depth) VALUES ('${CONFIG_ID}', '${PROJECT_ID}', 'sports-ms.com', 'weekly', 'both', 60)`,
    );
  });

  beforeEach(async () => {
    const client = database.client!;
    await client.execute(`DELETE FROM rank_snapshots`);
    await client.execute(`DELETE FROM rank_check_runs`);
    await client.execute(`DELETE FROM rank_tracking_targets`);
    await client.execute(`DELETE FROM rank_tracking_keywords`);

    await client.execute(
      `INSERT INTO rank_tracking_keywords (id, config_id, keyword) VALUES ('${KW_ID}', '${CONFIG_ID}', 'إنشاء ملاعب متعددة الأغراض')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device, enabled)
       VALUES ('${TARGET_EG_DESKTOP}', 'delegated-local-admin', '${PROJECT_ID}', '${CONFIG_ID}', 'eg', 'ar', 'desktop', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device, enabled)
       VALUES ('${TARGET_EG_MOBILE}', 'delegated-local-admin', '${PROJECT_ID}', '${CONFIG_ID}', 'eg', 'ar', 'mobile', 1)`,
    );

    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at) VALUES ('run-dfs', '${CONFIG_ID}', '${PROJECT_ID}', 'completed', '2026-10-04 19:59:39')`,
    );
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at) VALUES ('run-sr-daily', '${CONFIG_ID}', '${PROJECT_ID}', 'completed', '2026-11-15 22:12:24')`,
    );
  });

  async function seedSportsMsProductionHistory() {
    const client = database.client!;
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, url, provider, provider_status, tracking_target_id, checked_date, checked_at)
       VALUES (5521, 'run-dfs', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 37, 'RANKED', 'https://sports-ms.com/old', 'dataforseo', 'Ok', NULL, '2026-10-04', '2026-10-04 19:59:39')`,
    );

    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9772, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 50, 86, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":0}', 'CONFIRMED', 'daily_sync', '2026-11-11', '2026-11-15 22:12:24', '2026-11-15 22:12:24')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9773, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 50, 50, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":0}', 'CONFIRMED', 'daily_sync', '2026-11-12', '2026-11-15 22:12:25', '2026-11-15 22:12:25')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9774, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 84, 86, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":2}', 'CONFIRMED', 'daily_sync', '2026-11-15', '2026-11-15 22:12:25', '2026-11-15 22:12:25')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9775, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 85, 84, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":-1}', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-15 22:12:25', '2026-11-15 22:12:25')`,
    );

    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9768, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_MOBILE}', 'mobile', 46, 46, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":0}', 'CONFIRMED', NULL, '2026-11-13', '2026-11-13 12:00:00', NULL)`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9781, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_MOBILE}', 'mobile', 46, 47, 'RANKED', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":1}', 'CONFIRMED', 'daily_sync', '2026-11-15', '2026-11-15 22:12:27', '2026-11-15 22:12:27')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, previous_position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (9782, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_MOBILE}', 'mobile', 43, 46, 'RANKED', 'https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)","providerChange":3}', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-15 22:12:27', '2026-11-15 22:12:27')`,
    );
  }

  it("1 & 4 & 7 & 8: returns 84 (not 50 and not 37) as previous comparable Desktop position, -1 movement, and keeps Mobile (46 -> 43, +3) isolated", async () => {
    await seedSportsMsProductionHistory();

    const prevRes = await getLatestResults(CONFIG_ID, PROJECT_ID, "previous");
    expect(prevRes.rows).toHaveLength(1);
    const row = prevRes.rows[0];

    expect(row.desktop.position).toBe(85);
    expect(row.desktop.checkedDate).toBe("2026-11-16");
    expect(row.desktop.previousPosition).toBe(84);
    expect(row.desktop.previousComparablePosition).toBe(84);
    expect(row.desktop.previousObservationDate).toBe("2026-11-15");
    expect(row.desktop.previousObservationProvider).toBe("seranking");
    expect(row.desktop.positionChange).toBe(-1);
    expect(row.desktop.providerChange).toBe(-1);
    expect(row.desktop.comparisonMethod).toBe(
      "previous_comparable_observation",
    );
    expect(row.desktop.provider).toBe("seranking");
    expect(row.desktop.observationSource).toBe("daily_sync");

    expect(row.mobile.position).toBe(43);
    expect(row.mobile.checkedDate).toBe("2026-11-16");
    expect(row.mobile.previousPosition).toBe(46);
    expect(row.mobile.previousComparablePosition).toBe(46);
    expect(row.mobile.previousObservationDate).toBe("2026-11-15");
    expect(row.mobile.positionChange).toBe(3);
    expect(row.mobile.providerChange).toBe(3);

    const weeklyRes = await getLatestResults(CONFIG_ID, PROJECT_ID, "7d");
    const weeklyDesktop = weeklyRes.rows[0].desktop;
    expect(weeklyDesktop.previousComparablePosition).toBe(84);
    expect(weeklyDesktop.previousObservationDate).toBe("2026-11-15");
    expect(weeklyDesktop.positionChange).toBe(-1);
    expect(weeklyDesktop.periodBaselinePosition).toBe(50);
    expect(weeklyDesktop.periodBaselineDate).toBe("2026-11-11");
    expect(weeklyDesktop.periodBaselineProvider).toBe("seranking");
    expect(weeklyDesktop.comparisonMethod).toBe("earliest_available_baseline");
  });

  it("2 & 6: never treats older DataForSEO observations as previous SE Ranking daily observation and never invents missing priors", async () => {
    const client = database.client!;
    await client.execute(
      `INSERT INTO rank_tracking_keywords (id, config_id, keyword) VALUES ('${KW_SINGLE}', '${CONFIG_ID}', 'new keyword')`,
    );

    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, checked_date, checked_at)
       VALUES (101, 'run-dfs', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_SINGLE}', 'new keyword', 'eg', 'ar', NULL, 'desktop', 18, 'RANKED', 'dataforseo', '2026-10-04', '2026-10-04 12:00:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, checked_date, checked_at)
       VALUES (102, 'run-dfs', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_SINGLE}', 'new keyword', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 22, 'RANKED', 'dataforseo', '2026-11-10', '2026-11-10 12:00:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at)
       VALUES (103, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_SINGLE}', 'new keyword', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 31, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-16 01:00:00')`,
    );

    const resPrev = await getLatestResults(
      CONFIG_ID,
      PROJECT_ID,
      "previous",
      TARGET_EG_DESKTOP,
    );
    const single = resPrev.rows.find((r) => r.trackingKeywordId === KW_SINGLE)!;
    expect(single.desktop.position).toBe(31);
    expect(single.desktop.previousPosition).toBeNull();
    expect(single.desktop.previousComparablePosition).toBeNull();
    expect(single.desktop.previousObservationDate).toBeNull();
    expect(single.desktop.positionChange).toBeNull();
    expect(single.desktop.comparisonMethod).toBe("none");

    const res7d = await getLatestResults(
      CONFIG_ID,
      PROJECT_ID,
      "7d",
      TARGET_EG_DESKTOP,
    );
    const single7d = res7d.rows.find((r) => r.trackingKeywordId === KW_SINGLE)!;
    expect(single7d.desktop.previousPosition).toBeNull();
    expect(single7d.desktop.periodBaselinePosition).toBeNull();
    expect(single7d.desktop.comparisonMethod).toBe("none");
  });

  it("5: respects checkedDate over import order and resolves same-day provider corrections cleanly", async () => {
    const client = database.client!;
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (201, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 80, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'manual_recheck', '2026-11-15', '2026-11-15 10:00:00', NULL)`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (202, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 84, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', '2026-11-15', '2026-11-15 22:12:25', '2026-11-15 22:12:25')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (203, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 85, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-16 01:00:00', '2026-11-16 01:00:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (204, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 83, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-16 08:00:00', '2026-11-16 08:00:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, provider, completion_confidence, observation_source, checked_date, checked_at, imported_at)
       VALUES (205, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'eg', 'ar', '${TARGET_EG_DESKTOP}', 'desktop', 50, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', '2026-11-11', '2026-11-16 12:00:00', '2026-11-16 12:00:00')`,
    );

    const res = await getLatestResults(
      CONFIG_ID,
      PROJECT_ID,
      "previous",
      TARGET_EG_DESKTOP,
    );
    const desktop = res.rows[0].desktop;
    expect(desktop.position).toBe(83);
    expect(desktop.checkedDate).toBe("2026-11-16");
    expect(desktop.previousComparablePosition).toBe(84);
    expect(desktop.previousObservationDate).toBe("2026-11-15");
    expect(desktop.positionChange).toBe(1);
  });

  it("3, 8, 9, 10: get_rank_tracker returns unambiguous SAM/MCP structure across targets and preserves SQLite history", async () => {
    const client = database.client!;
    await seedSportsMsProductionHistory();

    await client.execute(
      `INSERT INTO rank_tracking_targets (id, organization_id, local_project_id, tracking_config_id, country_code, language_code, device, enabled)
       VALUES ('${TARGET_SA_DESKTOP}', 'delegated-local-admin', '${PROJECT_ID}', '${CONFIG_ID}', 'sa', 'ar', 'desktop', 1)`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at)
       VALUES (9901, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'sa', 'ar', '${TARGET_SA_DESKTOP}', 'desktop', 14, 'RANKED', 'https://sports-ms.com/sa-prev', 'seranking', '{"status":"SE Ranking daily position import","providerChange":0}', 'CONFIRMED', 'daily_sync', '2026-11-15', '2026-11-15 22:15:00')`,
    );
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, country_code, language, tracking_target_id, device, position, ranking_status, url, provider, provider_status, completion_confidence, observation_source, checked_date, checked_at)
       VALUES (9902, 'run-sr-daily', '${PROJECT_ID}', '${CONFIG_ID}', '${KW_ID}', 'إنشاء ملاعب متعددة الأغراض', 'sa', 'ar', '${TARGET_SA_DESKTOP}', 'desktop', 11, 'RANKED', 'https://sports-ms.com/sa-curr', 'seranking', '{"status":"SE Ranking daily position import","providerChange":3}', 'CONFIRMED', 'daily_sync', '2026-11-16', '2026-11-15 22:15:00')`,
    );

    const beforeCountRes = await client.execute(
      `SELECT COUNT(*) AS cnt FROM rank_snapshots`,
    );
    const countBefore = Number(beforeCountRes.rows[0]?.cnt ?? 0);

    const mcpRes = (await getRankTrackerTool.handler(
      { projectId: PROJECT_ID, trackerId: CONFIG_ID },
      toolExtra,
    )) as {
      content: Array<{ type: string; text: string }>;
      structuredContent: {
        results: { rows: Array<Record<string, any>> };
        targetResults?: Array<{
          target: { id: string };
          results: { rows: Array<Record<string, any>> };
        }>;
      };
    };

    const text = mcpRes.content[0].text;
    expect(text).toContain(
      "keyword | target | device | pos | obs date | prev comparable | prev date | movement | provider delta | provider | provenance | method | url | status",
    );
    expect(text).toContain(
      "EG (ar) desktop | desktop | 85 | 2026-11-16 | 84 | 2026-11-15 | -1 | -1 | seranking | daily_sync / CONFIRMED | previous_comparable_observation",
    );
    expect(text).toContain(
      "EG (ar) mobile | mobile | 43 | 2026-11-16 | 46 | 2026-11-15 | +3 | +3 | seranking | daily_sync / CONFIRMED | previous_comparable_observation",
    );
    expect(text).toContain(
      "SA (ar) desktop | desktop | 11 | 2026-11-16 | 14 | 2026-11-15 | +3 | +3 | seranking | daily_sync / CONFIRMED | previous_comparable_observation",
    );
    expect(text).not.toContain("| 50 |");
    expect(text).not.toContain("| 37 |");

    expect(mcpRes.structuredContent.targetResults).toHaveLength(3);
    const egDesktopStructured =
      mcpRes.structuredContent.targetResults![0].results.rows[0].desktop;
    expect(egDesktopStructured.position).toBe(85);
    expect(egDesktopStructured.previousComparablePosition).toBe(84);
    expect(egDesktopStructured.previousObservationDate).toBe("2026-11-15");
    expect(egDesktopStructured.positionChange).toBe(-1);
    expect(egDesktopStructured.targetLabel).toBe("EG (ar) desktop");
    expect(egDesktopStructured.provider).toBe("seranking");
    expect(egDesktopStructured.comparisonMethod).toBe(
      "previous_comparable_observation",
    );

    const afterCountRes = await client.execute(
      `SELECT COUNT(*) AS cnt FROM rank_snapshots`,
    );
    const countAfter = Number(afterCountRes.rows[0]?.cnt ?? 0);
    expect(countAfter).toBe(countBefore);
  });
});
