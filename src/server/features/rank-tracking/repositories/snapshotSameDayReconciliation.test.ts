import type { Client } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

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

const {
  getKeywordHistory,
  getLatestValidSnapshotsForKeywords,
  getSnapshotsBeforeDate,
} = await import("./snapshotQueries");
const { RankTrackingRepository } = await import("./RankTrackingRepository");

describe("Same-Day Observation Reconciliation & Deterministic Daily History", () => {
  beforeAll(async () => {
    const client = database.client;
    if (!client) throw new Error("Expected libsql client");

    await client.execute(`CREATE TABLE organization (id text PRIMARY KEY)`);
    await client.execute(`CREATE TABLE projects (id text PRIMARY KEY)`);
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
        schedule_day text,
        schedule_time text,
        schedule_hour integer,
        next_check_at text,
        last_checked_at text,
        is_active integer DEFAULT 1,
        created_at text DEFAULT (current_timestamp),
        updated_at text DEFAULT (current_timestamp)
      )`,
    );
    await client.execute(
      `CREATE TABLE rank_check_runs (
        id text PRIMARY KEY,
        config_id text NOT NULL,
        project_id text NOT NULL,
        status text DEFAULT 'pending',
        keywords_total integer DEFAULT 0,
        keywords_checked integer DEFAULT 0,
        trigger text DEFAULT 'manual' NOT NULL,
        is_subset_run integer DEFAULT 0,
        error_message text,
        started_at text DEFAULT (current_timestamp),
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

    // Setup base entities
    await client.execute(`INSERT INTO organization (id) VALUES ('org-1')`);
    await client.execute(
      `INSERT INTO projects (id) VALUES ('367587e1-0c77-4d58-a2f8-7d7a171adfcb')`,
    );
    await client.execute(
      `INSERT INTO rank_tracking_configs (id, project_id, domain) VALUES ('2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'sports-ms.com')`,
    );

    // Setup runs
    // 1. Initial manual verification / baseline capture run on Nov 13 afternoon
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at, completed_at) VALUES ('run-baseline', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', '2026-11-13 17:34:09', '2026-11-13 17:38:38')`,
    );
    // 2. Native UI Check Selected run on Nov 13 night (mobile completed, desktop timed out)
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at, completed_at) VALUES ('run-recheck', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'partial', '2026-11-13 21:45:57', '2026-11-13 21:54:09')`,
    );
    // 3. Read-only daily sync run on Nov 14 importing upstream settled positions
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at, completed_at) VALUES ('run-sync-1', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', '2026-11-14 15:01:06', '2026-11-14 15:01:36')`,
    );
    // 4. Daily sync run for Nov 14 observations
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at, completed_at) VALUES ('run-sync-2', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', '2026-11-14 15:04:19', '2026-11-14 15:04:33')`,
    );

    // Insert Desktop snapshots on Nov 13
    // Snap 9762: pre-recheck baseline (pos 62, LIKELY_COMPLETE)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, tracking_target_id, checked_at, checked_date, url)
       VALUES (9762, 'run-baseline', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 62, 37, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'target-desktop', '2026-11-13 17:38:38', '2026-11-13', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
    // Snap 9765: poll timeout (pos null, CHECK_FAILED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, tracking_target_id, checked_at, checked_date, url)
       VALUES (9765, 'run-recheck', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', null, 62, 'CHECK_FAILED', 'seranking', null, 'target-desktop', '2026-11-13 21:54:09', '2026-11-13', null)`,
    );
    // Snap 9766: daily import (pos 85, CONFIRMED settled daily position; actual import timestamp, NOT synthetic 12:00:00)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9766, 'run-sync-1', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 85, 62, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-14 15:01:36', '2026-11-13', '2026-11-14 15:01:36', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
    // Snap 9770: Nov 14 daily import (pos 86, prev 85, CONFIRMED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9770, 'run-sync-2', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 86, 85, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-14 15:04:33', '2026-11-14', '2026-11-14 15:04:33', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );

    // Insert Mobile snapshots on Nov 13
    // Snap 9763: pre-recheck baseline (pos 35, LIKELY_COMPLETE)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, tracking_target_id, checked_at, checked_date, url)
       VALUES (9763, 'run-baseline', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'mobile', 35, null, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'target-mobile', '2026-11-13 17:38:38', '2026-11-13', 'https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/')`,
    );
    // Snap 9764: live recheck poll outcome (pos 46, LIKELY_COMPLETE)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, tracking_target_id, checked_at, checked_date, url)
       VALUES (9764, 'run-recheck', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'mobile', 46, 35, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'target-mobile', '2026-11-13 21:50:04', '2026-11-13', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
    // Snap 9768: daily import (pos 46, CONFIRMED settled daily position)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9768, 'run-sync-1', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'mobile', 46, 46, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-mobile', '2026-11-14 15:01:36', '2026-11-13', '2026-11-14 15:01:36', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
    // Snap 9771: Nov 14 daily import (pos 47, prev 46, CONFIRMED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9771, 'run-sync-2', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'mobile', 47, 46, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-mobile', '2026-11-14 15:04:33', '2026-11-14', '2026-11-14 15:04:33', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );
  });

  it("reconciles same-day Desktop observations deterministically: chooses authoritative CONFIRMED pos 85 over baseline pos 62", async () => {
    const desktopHistory = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-multipurpose",
      30,
      "target-desktop",
    );

    // Exactly one authoritative entry per date
    expect(desktopHistory).toHaveLength(2);

    const nov13 = desktopHistory.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-13",
    );
    const nov14 = desktopHistory.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-14",
    );

    expect(nov13).toBeDefined();
    expect(nov13?.position).toBe(85); // Authoritative settled daily observation
    expect(nov13?.id).toBe(9766);

    expect(nov14).toBeDefined();
    expect(nov14?.position).toBe(86);
    expect(nov14?.previousPosition).toBe(85);
    expect(nov14?.id).toBe(9770);
  });

  it("reconciles same-day Mobile observations deterministically: chooses authoritative CONFIRMED pos 46 over baseline pos 35", async () => {
    const mobileHistory = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-multipurpose",
      30,
      "target-mobile",
    );

    expect(mobileHistory).toHaveLength(2);

    const nov13 = mobileHistory.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-13",
    );
    const nov14 = mobileHistory.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-14",
    );

    expect(nov13).toBeDefined();
    expect(nov13?.position).toBe(46); // Settled daily position
    expect(nov13?.id).toBe(9768);

    expect(nov14).toBeDefined();
    expect(nov14?.position).toBe(47);
    expect(nov14?.previousPosition).toBe(46);
    expect(nov14?.id).toBe(9771);
  });

  it("selects authoritative past observations in getSnapshotsBeforeDate without corrupting comparisons", async () => {
    // Before Nov 14 (i.e. Nov 13 end-of-day), the authoritative Desktop snapshot is pos 85
    const beforeNov14 = await getSnapshotsBeforeDate(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "2026-11-13 23:59:59",
      "target-desktop",
    );

    expect(beforeNov14).toHaveLength(1);
    expect(beforeNov14[0]?.position).toBe(85);
    expect(beforeNov14[0]?.id).toBe(9766);
  });

  it("returns latest valid snapshot across all dates", async () => {
    const latestDesktop = await getLatestValidSnapshotsForKeywords(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "target-desktop",
    );

    expect(latestDesktop).toHaveLength(1);
    expect(latestDesktop[0]?.position).toBe(86);
    expect(latestDesktop[0]?.id).toBe(9770);
  });

  it("correctly identifies latest imported date via getLatestSnapshotDateForKeywordTarget", async () => {
    const latestDate =
      await RankTrackingRepository.getLatestSnapshotDateForKeywordTarget({
        configId: "2971425d-d350-4ee3-89b2-c83567c87713",
        trackingKeywordId: "kw-multipurpose",
        trackingTargetId: "target-desktop",
        device: "desktop",
      });

    expect(latestDate).toBe("2026-11-14");
  });

  it("Task 1: Partition Identity - two different keywords tracked on same target, device, and date both remain visible", async () => {
    const client = database.client!;
    // Insert a second keyword on the exact same target, device, and date (Nov 13)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, tracking_target_id, checked_at, checked_date, url)
       VALUES (9775, 'run-sync-1', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 12, null, 'RANKED', 'seranking', 'CONFIRMED', 'target-desktop', '2026-11-13 12:00:00', '2026-11-13', 'https://sports-ms.com/بناء-ملاعب-بادل/')`,
    );

    // 1. Both keywords must be visible in latest valid snapshots for config
    const snapshots = await getLatestValidSnapshotsForKeywords(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "target-desktop",
    );
    const kwIds = snapshots.map((s) => s.trackingKeywordId);
    expect(kwIds).toContain("kw-multipurpose");
    expect(kwIds).toContain("kw-padel");

    // 2. Both keywords must maintain independent daily histories on the same observation date
    const historyPadel = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-padel",
      30,
      "target-desktop",
    );
    expect(historyPadel).toHaveLength(1);
    expect(historyPadel[0]?.position).toBe(12);

    const historyMulti = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-multipurpose",
      30,
      "target-desktop",
    );
    expect(
      historyMulti.find((h) => h.checkedDate === "2026-11-13")?.position,
    ).toBe(85);
  });

  it("Task 2: Deduplication & Coexistence - manual and daily observations coexist with source-aware keys", async () => {
    // 1. Querying with source='daily_import' specifically matches the CONFIRMED daily snapshot (id 9766)
    const dailySnap =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: "2971425d-d350-4ee3-89b2-c83567c87713",
        trackingKeywordId: "kw-multipurpose",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-13",
        source: "daily_import",
      });
    expect(dailySnap).toBeDefined();
    expect(dailySnap?.id).toBe(9766);
    expect(dailySnap?.position).toBe(85);
    expect(dailySnap?.completionConfidence).toBe("CONFIRMED");

    // 2. Both manual (id 9762, pos 62) and daily (id 9766, pos 85) snapshots exist in DB
    const client = database.client!;
    const allNov13 = await client.execute(
      `SELECT id, run_id, position, completion_confidence FROM rank_snapshots WHERE tracking_keyword_id = 'kw-multipurpose' AND device = 'desktop' AND checked_date = '2026-11-13' ORDER BY id ASC`,
    );
    expect(allNov13.rows.length).toBeGreaterThanOrEqual(2);
    const posList = allNov13.rows.map((r) => r.position);
    expect(posList).toContain(62); // manual check baseline
    expect(posList).toContain(85); // settled daily import
  });

  it("Task 2: Provider Correction - corrected provider daily observation reconciles safely without data loss", async () => {
    const client = database.client!;
    // Insert run-sync-3 as completed run
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, started_at, completed_at) VALUES ('run-sync-3', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', '2026-11-15 10:00:00', '2026-11-15 10:01:00')`,
    );
    // Provider publishes an amended/corrected observation for Nov 13: position changed from 85 to 84
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, previous_position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9780, 'run-sync-3', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 84, 85, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-15 10:01:00', '2026-11-13', '2026-11-15 10:01:00', 'https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/')`,
    );

    // 1. History query for Nov 13 must now select the corrected position (84) via deterministic ROW_NUMBER priority
    const desktopHistory = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-multipurpose",
      30,
      "target-desktop",
    );
    const nov13 = desktopHistory.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-13",
    );
    expect(nov13?.position).toBe(84);
    expect(nov13?.id).toBe(9780);

    // 2. All prior snapshots (original 85, baseline 62) remain 100% preserved
    const rawCheck = await client.execute(
      `SELECT id, position FROM rank_snapshots WHERE id IN (9762, 9766, 9780) ORDER BY id ASC`,
    );
    expect(rawCheck.rows).toHaveLength(3);
    expect(rawCheck.rows.map((r) => r.position)).toEqual([62, 85, 84]);
  });

  it("Invariant 1 & 2 & 3: provenance independence, explicit scheduled trigger, and backfilled checkedDate separation", async () => {
    const client = database.client!;

    // 1. Provenance independence: a manual_recheck with CONFIRMED confidence on Nov 12
    // does NOT collide with source='daily_import'
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date)
       VALUES (9790, 'run-recheck', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 55, 'RANKED', 'seranking', 'CONFIRMED', 'manual_recheck', 'target-desktop', '2026-11-12 18:00:00', '2026-11-12')`,
    );
    const manualOnlyMatch =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: "2971425d-d350-4ee3-89b2-c83567c87713",
        trackingKeywordId: "kw-multipurpose",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-12",
        source: "daily_import",
      });
    expect(manualOnlyMatch).toBeNull();

    // A daily_sync observation on Nov 12 even with LIKELY_COMPLETE IS matched by daily_import
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at)
       VALUES (9791, 'run-sync-1', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 58, 'RANKED', 'seranking', 'LIKELY_COMPLETE', 'daily_sync', 'target-desktop', '2026-11-14 15:01:36', '2026-11-12', '2026-11-14 15:01:36')`,
    );
    const dailyMatch =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: "2971425d-d350-4ee3-89b2-c83567c87713",
        trackingKeywordId: "kw-multipurpose",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-12",
        source: "daily_import",
      });
    expect(dailyMatch?.id).toBe(9791);
    expect(dailyMatch?.observationSource).toBe("daily_sync");

    // 2. Explicit scheduled trigger: a manual Check All (is_subset_run=0, trigger='manual')
    // does NOT count as a scheduled run in getLatestScheduledRunForConfig
    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, trigger, is_subset_run, started_at, completed_at)
       VALUES ('run-manual-all', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', 'manual', 0, '2026-11-14 19:00:00', '2026-11-14 19:02:00')`,
    );
    expect(
      await RankTrackingRepository.getLatestScheduledRunForConfig(
        "2971425d-d350-4ee3-89b2-c83567c87713",
      ),
    ).toBeNull();

    await client.execute(
      `INSERT INTO rank_check_runs (id, config_id, project_id, status, trigger, is_subset_run, started_at, completed_at)
       VALUES ('run-sched-1', '2971425d-d350-4ee3-89b2-c83567c87713', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', 'completed', 'scheduled', 1, '2026-11-14 15:00:00', '2026-11-14 15:01:00')`,
    );
    const sched = await RankTrackingRepository.getLatestScheduledRunForConfig(
      "2971425d-d350-4ee3-89b2-c83567c87713",
    );
    expect(sched?.id).toBe("run-sched-1");
    expect(sched?.trigger).toBe("scheduled");

    // 3. Date separation: Nov 11 daily backfill observation imported on Nov 14 sorts BEFORE Nov 13 in history
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at)
       VALUES (9792, 'run-sync-1', '367587e1-0c77-4d58-a2f8-7d7a171adfcb', '2971425d-d350-4ee3-89b2-c83567c87713', 'kw-multipurpose', 'إنشاء ملاعب متعددة الأغراض', 'desktop', 60, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-14 15:01:36', '2026-11-11', '2026-11-14 15:01:36')`,
    );
    const history = await getKeywordHistory(
      "2971425d-d350-4ee3-89b2-c83567c87713",
      "kw-multipurpose",
      30,
      "target-desktop",
    );
    const obsDates = history.map(
      (h) => h.checkedDate ?? h.checkedAt.slice(0, 10),
    );
    expect(obsDates).toEqual([
      "2026-11-11",
      "2026-11-12",
      "2026-11-13",
      "2026-11-14",
    ]);
    expect(history[0]?.importedAt).toBe("2026-11-14 15:01:36");
  });

  it("Task 4: Source-aware deduplication isolates manual CONFIRMED and legacy null-source rows from daily_sync even with same date, target, and position", async () => {
    const client = database.client!;
    const cfgId = "2971425d-d350-4ee3-89b2-c83567c87713";
    const projId = "367587e1-0c77-4d58-a2f8-7d7a171adfcb";

    // 1. Same date (2026-11-15), target ('target-desktop'), keyword ('kw-padel'), and position (12)
    // First record is a manual CONFIRMED check with observationSource='manual_recheck'
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, provider_status, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url)
       VALUES (9801, 'run-recheck', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 12, 'RANKED', 'seranking', '{"status":"Ok"}', 'CONFIRMED', 'manual_recheck', 'target-desktop', '2026-11-15 09:00:00', '2026-11-15', 'https://sports-ms.com/padel')`,
    );

    // A manual CONFIRMED snapshot must NEVER match source='daily_import'
    const beforeDaily =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: cfgId,
        trackingKeywordId: "kw-padel",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-15",
        source: "daily_import",
      });
    expect(beforeDaily).toBeNull();

    // Now daily_sync imports the same position (12) on the same date and target
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, provider_status, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, imported_at, url)
       VALUES (9802, 'run-sync-3', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 12, 'RANKED', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)"}', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-15 15:00:00', '2026-11-15', '2026-11-15 15:00:00', 'https://sports-ms.com/padel')`,
    );

    // Replay lookup matches ONLY the daily_sync snapshot (9802), while both rows coexist
    const afterDaily =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: cfgId,
        trackingKeywordId: "kw-padel",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-15",
        source: "daily_import",
      });
    expect(afterDaily?.id).toBe(9802);
    expect(afterDaily?.observationSource).toBe("daily_sync");

    const nov15Rows = await client.execute(
      `SELECT id, position, observation_source FROM rank_snapshots WHERE config_id = '${cfgId}' AND tracking_keyword_id = 'kw-padel' AND tracking_target_id = 'target-desktop' AND checked_date = '2026-11-15' ORDER BY id ASC`,
    );
    expect(nov15Rows.rows).toHaveLength(2);
    expect(
      nov15Rows.rows.map((r) => [r.id, r.position, r.observation_source]),
    ).toEqual([
      [9801, 12, "manual_recheck"],
      [9802, 12, "daily_sync"],
    ]);

    // 2. Explicit legacy null-source handling:
    // Legacy manual CONFIRMED snapshot (observation_source = NULL, provider_status = '{"status":"Ok"}') is NOT treated as daily_sync
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, provider_status, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url)
       VALUES (9803, 'run-baseline', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 10, 'RANKED', 'seranking', '{"status":"Ok"}', 'CONFIRMED', NULL, 'target-desktop', '2026-11-10 14:00:00', '2026-11-10', 'https://sports-ms.com/padel')`,
    );
    const legacyManualMatch =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: cfgId,
        trackingKeywordId: "kw-padel",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-10",
        source: "daily_import",
      });
    expect(legacyManualMatch).toBeNull();

    // Legacy daily import (observation_source = NULL, provider_status = 'SE Ranking daily position import') IS explicitly matched
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, provider_status, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url)
       VALUES (9804, 'run-sync-1', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 11, 'RANKED', 'seranking', '{"status":"SE Ranking daily position import (read-only sync)"}', 'CONFIRMED', NULL, 'target-desktop', '2026-11-09 12:00:00', '2026-11-09', 'https://sports-ms.com/padel')`,
    );
    const legacyDailyMatch =
      await RankTrackingRepository.findExistingSnapshotForObservation({
        configId: cfgId,
        trackingKeywordId: "kw-padel",
        trackingTargetId: "target-desktop",
        device: "desktop",
        dateStr: "2026-11-09",
        source: "daily_import",
      });
    expect(legacyDailyMatch?.id).toBe(9804);
  });

  it("Task 2: Daily History Priority - authoritative confirmed daily_sync observation wins over later manual and timed-out checks", async () => {
    const client = database.client!;
    const projId = "367587e1-0c77-4d58-a2f8-7d7a171adfcb";
    const cfgId = "2971425d-d350-4ee3-89b2-c83567c87713";

    // 1. Authoritative daily sync observation at 10:00:00 (position 25, CONFIRMED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url)
       VALUES (9810, 'run-sync-1', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 25, 'RANKED', 'seranking', 'CONFIRMED', 'daily_sync', 'target-desktop', '2026-11-08 10:00:00', '2026-11-08', 'https://sports-ms.com/padel')`,
    );

    // 2. Later manual recheck attempt at 15:00:00 on the same date (position 40, CONFIRMED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url)
       VALUES (9811, 'run-manual-late', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', 40, 'RANKED', 'seranking', 'CONFIRMED', 'manual_recheck', 'target-desktop', '2026-11-08 15:00:00', '2026-11-08', 'https://sports-ms.com/padel')`,
    );

    // 3. Later timed-out manual attempt at 19:00:00 on the same date (position null, CHECK_FAILED)
    await client.execute(
      `INSERT INTO rank_snapshots (id, run_id, project_id, config_id, tracking_keyword_id, keyword, device, position, ranking_status, provider, completion_confidence, observation_source, tracking_target_id, checked_at, checked_date, url, error_message)
       VALUES (9812, 'run-manual-timeout', '${projId}', '${cfgId}', 'kw-padel', 'بناء ملاعب بادل', 'desktop', NULL, 'CHECK_FAILED', 'seranking', 'UNVERIFIED', 'manual', 'target-desktop', '2026-11-08 19:00:00', '2026-11-08', NULL, 'Provider check timed out after 300s')`,
    );

    // getKeywordHistory must deterministically prioritize the authoritative daily_sync observation (position 25)
    const history = await getKeywordHistory(
      cfgId,
      "kw-padel",
      30,
      "target-desktop",
    );
    const nov8 = history.find(
      (h) => (h.checkedDate ?? h.checkedAt.slice(0, 10)) === "2026-11-08",
    );

    expect(nov8).toBeDefined();
    expect(nov8?.position).toBe(25);
    expect(nov8?.id).toBe(9810);
    expect(nov8?.observationSource).toBe("daily_sync");

    // All 3 snapshots remain preserved in the database
    const rows = await client.execute(
      `SELECT id, position, ranking_status, observation_source FROM rank_snapshots WHERE id IN (9810, 9811, 9812) ORDER BY id ASC`,
    );
    expect(rows.rows).toHaveLength(3);
    expect(rows.rows.map((r) => r.id)).toEqual([9810, 9811, 9812]);
  });
});
