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

import { Ga4SyncRepository } from "./Ga4SyncRepository";
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

function summaryRow(id: string, date: string, sessions: number) {
  return {
    id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date,
    sessions,
    engagedSessions: 5,
    userEngagementDuration: 60,
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
}

function acquisitionRow(
  id: string,
  date: string,
  channelGroup: string,
  source: string,
  medium: string,
  sessions: number,
) {
  return {
    id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date,
    channelGroup,
    source,
    medium,
    rawChannelGroup: channelGroup,
    rawSource: source,
    rawMedium: medium,
    sessions,
    engagedSessions: 3,
    userEngagementDuration: 30,
    screenPageViews: 10,
    eventCount: 12,
    newUsers: 2,
  };
}

function landingRow(
  id: string,
  date: string,
  landingPage: string,
  sessions: number,
) {
  return {
    id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date,
    landingPage,
    rawLandingPage: landingPage,
    sessions,
    engagedSessions: 2,
    userEngagementDuration: 20,
    screenPageViews: 8,
  };
}

function eventRow(
  id: string,
  date: string,
  eventName: string,
  eventCount: number,
  isKeyEvent = false,
) {
  return {
    id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date,
    eventName,
    eventCount,
    isKeyEvent,
  };
}

async function cover(
  date: string,
  grain: (typeof GA4_GRAINS)[number],
  status: "SUCCESS_WITH_DATA" | "SUCCESS_ZERO_ROWS" | "FAILED",
) {
  await Ga4SyncRepository.seedPendingUnits({
    projectId: PROJECT,
    propertyId: PROPERTY,
    dates: [date],
    grains: [grain],
  });
  await Ga4SyncRepository.markUnits([
    { projectId: PROJECT, propertyId: PROPERTY, date, grain, status },
  ]);
}

describe("Ga4SyncRepository analytics readers", () => {
  it("returns the coverage-gated daily summary series in date order", async () => {
    await Ga4SyncRepository.upsertSummaryRows([
      summaryRow("s1", "2025-01-01", 10),
      summaryRow("s2", "2025-01-02", 20),
      summaryRow("s3", "2025-01-03", 30),
    ]);
    await cover("2025-01-01", "summary", "SUCCESS_WITH_DATA");
    await cover("2025-01-02", "summary", "SUCCESS_ZERO_ROWS");
    await cover("2025-01-03", "summary", "FAILED");

    const series = await Ga4SyncRepository.getDailySummarySeries(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-03",
    );
    // FAILED-coverage date excluded; ZERO_ROWS date contributes zero rows
    // (no stored facts) but is itself covered.
    expect(series.map((row) => row.date)).toEqual(["2025-01-01", "2025-01-02"]);
    expect(series[0]).toMatchObject({ sessions: 10, engagedSessions: 5 });
  });

  it("groups acquisition rows by channel/source/medium over covered dates only", async () => {
    await Ga4SyncRepository.upsertAcquisitionRows([
      acquisitionRow(
        "a1",
        "2025-01-01",
        "Organic Search",
        "google",
        "organic",
        10,
      ),
      acquisitionRow(
        "a2",
        "2025-01-02",
        "Organic Search",
        "google",
        "organic",
        6,
      ),
      acquisitionRow("a3", "2025-01-01", "Direct", "(direct)", "(none)", 4),
      // FAILED-coverage date: must not contribute.
      acquisitionRow(
        "a4",
        "2025-01-03",
        "Organic Search",
        "google",
        "organic",
        100,
      ),
    ]);
    await cover("2025-01-01", "acquisition", "SUCCESS_WITH_DATA");
    await cover("2025-01-02", "acquisition", "SUCCESS_WITH_DATA");
    await cover("2025-01-03", "acquisition", "FAILED");

    const groups = await Ga4SyncRepository.getAcquisitionGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-03",
      {},
    );
    expect(groups).toEqual([
      expect.objectContaining({
        channelGroup: "Organic Search",
        source: "google",
        medium: "organic",
        sessions: 16,
      }),
      expect.objectContaining({
        channelGroup: "Direct",
        source: "(direct)",
        medium: "(none)",
        sessions: 4,
      }),
    ]);
  });

  it("filters acquisition groups by channel", async () => {
    await Ga4SyncRepository.upsertAcquisitionRows([
      acquisitionRow(
        "a1",
        "2025-01-01",
        "Organic Search",
        "google",
        "organic",
        10,
      ),
      acquisitionRow("a2", "2025-01-01", "Direct", "(direct)", "(none)", 4),
    ]);
    await cover("2025-01-01", "acquisition", "SUCCESS_WITH_DATA");

    const groups = await Ga4SyncRepository.getAcquisitionGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { channelGroup: "Organic Search" },
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      channelGroup: "Organic Search",
      sessions: 10,
    });
  });

  it("orders landing rows by sessions desc and honors limit", async () => {
    await Ga4SyncRepository.upsertLandingRows([
      landingRow("l1", "2025-01-01", "/a", 5),
      landingRow("l2", "2025-01-01", "/b", 50),
      landingRow("l3", "2025-01-01", "/c", 15),
      landingRow("l4", "2025-01-02", "/failed-only", 999),
    ]);
    await cover("2025-01-01", "landing_pages", "SUCCESS_WITH_DATA");
    await cover("2025-01-02", "landing_pages", "FAILED");

    const rows = await Ga4SyncRepository.getLandingGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-02",
      { limit: 2 },
    );
    expect(rows.map((row) => row.landingPage)).toEqual(["/b", "/c"]);
    expect(rows[0]).toMatchObject({ sessions: 50 });
  });

  it("reports grain coverage as covered dates plus covered-through date", async () => {
    await cover("2025-01-01", "summary", "SUCCESS_WITH_DATA");
    await cover("2025-01-02", "summary", "SUCCESS_ZERO_ROWS");
    await cover("2025-01-03", "summary", "FAILED");

    const coverage = await Ga4SyncRepository.getGrainCoverage(
      PROJECT,
      PROPERTY,
      "summary",
      "2025-01-01",
      "2025-01-03",
    );
    expect(coverage.coveredDates).toEqual(["2025-01-01", "2025-01-02"]);
    expect(coverage.coveredThrough).toBe("2025-01-02");
  });

  it("reports null covered-through when nothing is covered", async () => {
    const coverage = await Ga4SyncRepository.getGrainCoverage(
      PROJECT,
      PROPERTY,
      "summary",
      "2025-01-01",
      "2025-01-03",
    );
    expect(coverage.coveredDates).toEqual([]);
    expect(coverage.coveredThrough).toBeNull();
  });

  it("groups events by name over covered dates only, ordered by count desc", async () => {
    await Ga4SyncRepository.upsertEventRows([
      eventRow("e1", "2025-01-01", "page_view", 10),
      eventRow("e2", "2025-01-02", "page_view", 6),
      eventRow("e3", "2025-01-01", "purchase", 4, true),
      eventRow("e4", "2025-01-03", "page_view", 999),
    ]);
    await cover("2025-01-01", "events", "SUCCESS_WITH_DATA");
    await cover("2025-01-02", "events", "SUCCESS_WITH_DATA");
    await cover("2025-01-03", "events", "FAILED");

    const groups = await Ga4SyncRepository.getEventGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-03",
      { limit: 10 },
    );
    expect(groups).toEqual([
      expect.objectContaining({
        eventName: "page_view",
        eventCount: 16,
        isKeyEvent: false,
      }),
      expect.objectContaining({
        eventName: "purchase",
        eventCount: 4,
        isKeyEvent: true,
      }),
    ]);
  });

  it("filters event groups to key events only and honors limit", async () => {
    await Ga4SyncRepository.upsertEventRows([
      eventRow("e1", "2025-01-01", "page_view", 50),
      eventRow("e2", "2025-01-01", "purchase", 5, true),
      eventRow("e3", "2025-01-01", "generate_lead", 15, true),
    ]);
    await cover("2025-01-01", "events", "SUCCESS_WITH_DATA");

    const keyOnly = await Ga4SyncRepository.getEventGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { limit: 10, keyEventsOnly: true },
    );
    expect(keyOnly.map((row) => row.eventName)).toEqual([
      "generate_lead",
      "purchase",
    ]);

    const limited = await Ga4SyncRepository.getEventGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { limit: 1, keyEventsOnly: true },
    );
    expect(limited).toHaveLength(1);
    expect(limited[0]).toMatchObject({ eventName: "generate_lead" });
  });

  it("returns no event rows when nothing is covered", async () => {
    await Ga4SyncRepository.upsertEventRows([
      eventRow("e1", "2025-01-01", "page_view", 10),
    ]);
    const groups = await Ga4SyncRepository.getEventGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { limit: 10 },
    );
    expect(groups).toEqual([]);
  });
});
