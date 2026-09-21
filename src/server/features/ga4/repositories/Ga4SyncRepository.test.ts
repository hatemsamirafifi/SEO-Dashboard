/* eslint-disable max-lines */
import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client);
  return { db: database.db };
});

vi.mock("@/db/runBatch", () => ({
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

import {
  Ga4AggregationError,
  Ga4SyncRepository,
  NEW_USERS_FOOTNOTE,
} from "./Ga4SyncRepository";
import { GA4_GRAINS } from "../services/ga4SyncUtils";

const PROJECT = "project-1";
const PROPERTY = "properties/42";

function migrationStatements(file: string): string[] {
  return readFileSync(resolve(process.cwd(), file), "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function resetTables() {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of [
    "ga4_sync_coverage",
    "ga4_syncs",
    "ga4_daily_summary",
    "ga4_daily_acquisition",
    "ga4_daily_landing_pages",
    "ga4_daily_events",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
}

async function migrateTestDatabase() {
  if (!database.client) throw new Error("Test database was not initialized");
  // Parent tables for FK enforcement (SQLite resolves FK targets on
  // DELETE/INSERT when foreign_keys is on).
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO projects (id) VALUES ('project-1')",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO organization (id) VALUES ('org-1')",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS gsc_search_performance_syncs (id TEXT PRIMARY KEY NOT NULL)",
  );
  for (const file of [
    "drizzle/0050_ga4_connections.sql",
    "drizzle/0052_quick_quentin_quire.sql",
  ]) {
    for (const statement of migrationStatements(file)) {
      if (statement.includes("gsc_search_performance_syncs")) continue;
      await database.client.execute(statement);
    }
  }
}

beforeAll(migrateTestDatabase);
beforeEach(resetTables);
afterAll(() => database.client?.close());

describe("Ga4SyncRepository coverage machine", () => {
  it("seeds PENDING units without touching existing SUCCESS rows", async () => {
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01", "2025-01-02"],
      grains: [...GA4_GRAINS],
    });
    await Ga4SyncRepository.markUnits([
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-01",
        grain: "summary",
        status: "SUCCESS_WITH_DATA",
      },
    ]);
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01", "2025-01-02"],
      grains: [...GA4_GRAINS],
    });
    const map = await Ga4SyncRepository.getCoverageMap(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-02",
    );
    expect(map.get("2025-01-01")?.get("summary")).toBe("SUCCESS_WITH_DATA");
    expect(map.get("2025-01-02")?.get("summary")).toBe("PENDING");
    expect(map.get("2025-01-02")?.get("events")).toBe("PENDING");
  });

  it("resets FAILED units to PENDING and force-resets SUCCESS on manual re-runs", async () => {
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01"],
      grains: ["summary", "events"],
    });
    await Ga4SyncRepository.markUnits([
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-01",
        grain: "summary",
        status: "SUCCESS_WITH_DATA",
      },
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-01",
        grain: "events",
        status: "FAILED",
      },
    ]);
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01"],
      grains: ["summary", "events"],
    });
    let map = await Ga4SyncRepository.getCoverageMap(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
    );
    expect(map.get("2025-01-01")?.get("summary")).toBe("SUCCESS_WITH_DATA");
    expect(map.get("2025-01-01")?.get("events")).toBe("PENDING");

    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01"],
      grains: ["summary", "events"],
      force: true,
    });
    map = await Ga4SyncRepository.getCoverageMap(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
    );
    expect(map.get("2025-01-01")?.get("summary")).toBe("PENDING");
  });

  it("round-trips truncation metadata on coverage rows", async () => {
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01"],
      grains: ["landing_pages"],
    });
    await Ga4SyncRepository.markUnits([
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-01",
        grain: "landing_pages",
        status: "SUCCESS_WITH_DATA",
        truncationMeta: {
          row_limit: 1000,
          rows_returned: 1000,
          is_truncated: true,
          total_rows_if_known: 1400,
          sampling_state: "NOT_SAMPLED",
          data_loss_from_other_row: null,
        },
      },
    ]);
    if (!database.db) throw new Error("Test database was not initialized");
    const { ga4SyncCoverage } = await import("@/db/schema");
    const { eq, and } = await import("drizzle-orm");
    const rows = await database.db
      .select()
      .from(ga4SyncCoverage)
      .where(
        and(
          eq(ga4SyncCoverage.projectId, PROJECT),
          eq(ga4SyncCoverage.grain, "landing_pages"),
        ),
      );
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].truncationMeta ?? "{}")).toEqual({
      row_limit: 1000,
      rows_returned: 1000,
      is_truncated: true,
      total_rows_if_known: 1400,
      sampling_state: "NOT_SAMPLED",
      data_loss_from_other_row: null,
    });
  });

  it("computes the last fully-covered date over all grains", async () => {
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01", "2025-01-02", "2025-01-03"],
      grains: [...GA4_GRAINS],
    });
    const success = (date: string, grain: (typeof GA4_GRAINS)[number]) => ({
      projectId: PROJECT,
      propertyId: PROPERTY,
      date,
      grain,
      status: "SUCCESS_WITH_DATA" as const,
    });
    await Ga4SyncRepository.markUnits([
      ...GA4_GRAINS.map((grain) => success("2025-01-01", grain)),
      ...GA4_GRAINS.map((grain) => success("2025-01-02", grain)),
      // 2025-01-03 is missing the events grain: not fully covered.
      ...GA4_GRAINS.filter((grain) => grain !== "events").map((grain) =>
        success("2025-01-03", grain),
      ),
    ]);
    await expect(
      Ga4SyncRepository.getLastFullyCoveredDate(
        PROJECT,
        PROPERTY,
        [...GA4_GRAINS],
        "2025-01-31",
      ),
    ).resolves.toBe("2025-01-02");
    await expect(
      Ga4SyncRepository.getLastFullyCoveredDate(
        PROJECT,
        PROPERTY,
        [...GA4_GRAINS],
        "2025-01-01",
      ),
    ).resolves.toBe("2025-01-01");
    // SUCCESS_ZERO_ROWS counts as covered.
    await Ga4SyncRepository.markUnits([
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-03",
        grain: "events",
        status: "SUCCESS_ZERO_ROWS",
      },
    ]);
    await expect(
      Ga4SyncRepository.getLastFullyCoveredDate(
        PROJECT,
        PROPERTY,
        [...GA4_GRAINS],
        "2025-01-31",
      ),
    ).resolves.toBe("2025-01-03");
  });

  it("returns null when nothing is fully covered", async () => {
    await expect(
      Ga4SyncRepository.getLastFullyCoveredDate(
        PROJECT,
        PROPERTY,
        [...GA4_GRAINS],
        "2025-01-31",
      ),
    ).resolves.toBeNull();
  });
});

describe("Ga4SyncRepository run ledger", () => {
  const runInput = {
    projectId: PROJECT,
    propertyId: PROPERTY,
    syncType: "initial",
    requestedStartDate: "2025-01-01",
    requestedEndDate: "2025-01-07",
  };

  it("creates a running run and reports alreadyRunning on the second create", async () => {
    const first = await Ga4SyncRepository.createSyncRun(runInput);
    expect(first.ok).toBe(true);
    const second = await Ga4SyncRepository.createSyncRun(runInput);
    expect(second.ok).toBe(false);
    if (second.ok) throw new Error("expected alreadyRunning");
    expect(second.alreadyRunning).toBe(true);
    expect(second.sync.id).toBe(first.sync.id);
  });

  it("lets exactly one of two concurrent creates win", async () => {
    const [a, b] = await Promise.all([
      Ga4SyncRepository.createSyncRun(runInput),
      Ga4SyncRepository.createSyncRun(runInput),
    ]);
    const oks = [a.ok, b.ok].filter(Boolean);
    expect(oks).toHaveLength(1);
  });

  it("marks stale running runs as failed for crash recovery", async () => {
    const created = await Ga4SyncRepository.createSyncRun(runInput);
    if (!created.ok) throw new Error("expected run creation");
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute({
      sql: "UPDATE ga4_syncs SET updated_at = '2000-01-01T00:00:00.000Z' WHERE id = ?",
      args: [created.sync.id],
    });
    const marked = await Ga4SyncRepository.markStaleRunsFailed(
      PROJECT,
      PROPERTY,
      new Date(Date.now() - 60 * 1000).toISOString(),
    );
    expect(marked).toBe(1);
    const latest = await Ga4SyncRepository.getLatestSyncRun(PROJECT, PROPERTY);
    expect(latest?.status).toBe("failed");
    expect(
      await Ga4SyncRepository.getActiveSyncRun(PROJECT, PROPERTY),
    ).toBeNull();
    // A fresh run is untouched.
    const fresh = await Ga4SyncRepository.createSyncRun({
      ...runInput,
      requestedStartDate: "2025-02-01",
      requestedEndDate: "2025-02-07",
    });
    if (!fresh.ok) throw new Error("expected fresh run creation");
    expect(
      await Ga4SyncRepository.markStaleRunsFailed(
        PROJECT,
        PROPERTY,
        new Date(Date.now() - 60 * 1000).toISOString(),
      ),
    ).toBe(0);
  });

  it("selects the version token as the latest run with successful units", async () => {
    const first = await Ga4SyncRepository.createSyncRun(runInput);
    if (!first.ok) throw new Error("expected run creation");
    await Ga4SyncRepository.updateSyncRun(first.sync.id, {
      status: "failed",
      completedAt: "2025-01-08T00:00:00.000Z",
      successfulUnits: 0,
    });
    // A still-running run with units must never be selected (null completedAt).
    const running = await Ga4SyncRepository.createSyncRun({
      ...runInput,
      requestedStartDate: "2025-02-01",
      requestedEndDate: "2025-02-07",
    });
    if (!running.ok) throw new Error("expected run creation");
    await Ga4SyncRepository.updateSyncRun(running.sync.id, {
      successfulUnits: 12,
    });
    await expect(
      Ga4SyncRepository.getLatestSuccessfulRun(PROJECT, PROPERTY),
    ).resolves.toBeNull();
    await Ga4SyncRepository.updateSyncRun(running.sync.id, {
      status: "partial",
      completedAt: "2025-02-08T00:00:00.000Z",
    });
    const token = await Ga4SyncRepository.getLatestSuccessfulRun(
      PROJECT,
      PROPERTY,
    );
    expect(token?.id).toBe(running.sync.id);
  });
});

describe("Ga4SyncRepository metric storage", () => {
  it("upserts summary rows idempotently", async () => {
    const row = {
      id: "summary-1",
      projectId: PROJECT,
      propertyId: PROPERTY,
      ga4ConnectionId: null,
      date: "2025-01-01",
      sessions: 10,
      engagedSessions: 5,
      userEngagementDuration: 12.5,
      screenPageViews: 20,
      eventCount: 30,
      newUsers: 4,
      totalUsers: 9,
      activeUsers: 8,
      totalRevenue: 0,
      purchaseRevenue: 0,
      transactions: 0,
      addToCarts: 0,
      checkouts: 0,
    };
    await Ga4SyncRepository.upsertSummaryRows([row]);
    await Ga4SyncRepository.upsertSummaryRows([{ ...row, sessions: 11 }]);
    if (!database.db) throw new Error("Test database was not initialized");
    const { ga4DailySummary } = await import("@/db/schema");
    const rows = await database.db.select().from(ga4DailySummary);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessions: 11, newUsers: 4 });
  });

  it("upserts acquisition rows on the canonical composite", async () => {
    const row = {
      id: "acq-1",
      projectId: PROJECT,
      propertyId: PROPERTY,
      ga4ConnectionId: null,
      date: "2025-01-01",
      channelGroup: "Organic Search",
      source: "google",
      medium: "organic",
      rawChannelGroup: "Organic Search",
      rawSource: "google",
      rawMedium: "organic",
      sessions: 7,
      engagedSessions: 3,
      userEngagementDuration: 9,
      screenPageViews: 14,
      eventCount: 21,
      newUsers: 2,
    };
    await Ga4SyncRepository.upsertAcquisitionRows([row]);
    await Ga4SyncRepository.upsertAcquisitionRows([{ ...row, sessions: 8 }]);
    if (!database.db) throw new Error("Test database was not initialized");
    const { ga4DailyAcquisition } = await import("@/db/schema");
    const rows = await database.db.select().from(ga4DailyAcquisition);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ sessions: 8 });
  });
});

describe("Ga4SyncRepository readers and aggregation guards", () => {
  async function seedSummary() {
    await Ga4SyncRepository.upsertSummaryRows([
      {
        id: "s1",
        projectId: PROJECT,
        propertyId: PROPERTY,
        ga4ConnectionId: null,
        date: "2025-01-01",
        sessions: 10,
        engagedSessions: 5,
        userEngagementDuration: 100,
        screenPageViews: 20,
        eventCount: 30,
        newUsers: 4,
        totalUsers: 90,
        activeUsers: 80,
        totalRevenue: 12.5,
        purchaseRevenue: 12.5,
        transactions: 1,
        addToCarts: 2,
        checkouts: 1,
      },
      {
        id: "s2",
        projectId: PROJECT,
        propertyId: PROPERTY,
        ga4ConnectionId: null,
        date: "2025-01-02",
        sessions: 20,
        engagedSessions: 10,
        userEngagementDuration: 200,
        screenPageViews: 40,
        eventCount: 60,
        newUsers: 6,
        totalUsers: 150,
        activeUsers: 140,
        totalRevenue: 0,
        purchaseRevenue: 0,
        transactions: 0,
        addToCarts: 0,
        checkouts: 0,
      },
    ]);
    await Ga4SyncRepository.seedPendingUnits({
      projectId: PROJECT,
      propertyId: PROPERTY,
      dates: ["2025-01-01", "2025-01-02"],
      grains: ["summary"],
    });
    await Ga4SyncRepository.markUnits([
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-01",
        grain: "summary",
        status: "SUCCESS_WITH_DATA",
      },
      {
        projectId: PROJECT,
        propertyId: PROPERTY,
        date: "2025-01-02",
        grain: "summary",
        status: "FAILED",
      },
    ]);
  }

  it("sums summary metrics over SUCCESS-covered dates only", async () => {
    await seedSummary();
    const totals = await Ga4SyncRepository.getSummaryTotals(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-02",
      "USD",
    );
    expect(totals.sessions).toBe(10);
    expect(totals.newUsers).toBe(4);
    expect(totals.newUsersFootnote).toBe(NEW_USERS_FOOTNOTE);
    expect(totals.currencyCode).toBe("USD");
    expect(totals).not.toHaveProperty("totalUsers");
    expect(totals).not.toHaveProperty("activeUsers");
  });

  it("sums entity-scoped acquisition metrics but refuses project rollups", async () => {
    await Ga4SyncRepository.upsertAcquisitionRows([
      {
        id: "a1",
        projectId: PROJECT,
        propertyId: PROPERTY,
        ga4ConnectionId: null,
        date: "2025-01-01",
        channelGroup: "Organic Search",
        source: "google",
        medium: "organic",
        rawChannelGroup: null,
        rawSource: null,
        rawMedium: null,
        sessions: 7,
        engagedSessions: 3,
        userEngagementDuration: 9,
        screenPageViews: 14,
        eventCount: 21,
        newUsers: 2,
      },
    ]);
    const entity = await Ga4SyncRepository.getEntityTotals({
      projectId: PROJECT,
      propertyId: PROPERTY,
      table: "acquisition",
      entity: {
        channelGroup: "Organic Search",
        source: "google",
        medium: "organic",
      },
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(entity.sessions).toBe(7);
    expect(entity.newUsers).toBe(2);
    await expect(
      Ga4SyncRepository.getEntityTotals({
        projectId: PROJECT,
        propertyId: PROPERTY,
        table: "acquisition",
        entity: { channelGroup: "Organic Search", source: "google" },
        from: "2025-01-01",
        to: "2025-01-31",
      }),
    ).rejects.toBeInstanceOf(Ga4AggregationError);
  });

  it("reads event totals per event name", async () => {
    await Ga4SyncRepository.upsertEventRows([
      {
        id: "e1",
        projectId: PROJECT,
        propertyId: PROPERTY,
        ga4ConnectionId: null,
        date: "2025-01-01",
        eventName: "click",
        eventCount: 5,
        isKeyEvent: true,
      },
    ]);
    const totals = await Ga4SyncRepository.getEntityTotals({
      projectId: PROJECT,
      propertyId: PROPERTY,
      table: "events",
      entity: { eventName: "click" },
      from: "2025-01-01",
      to: "2025-01-31",
    });
    expect(totals.eventCount).toBe(5);
  });
});
