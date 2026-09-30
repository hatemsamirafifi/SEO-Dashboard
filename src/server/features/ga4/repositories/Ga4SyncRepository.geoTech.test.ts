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
} from "./Ga4SyncRepository";

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
    "ga4_daily_geo",
    "ga4_daily_technology",
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
    "drizzle/0060_harsh_scarlet_spider.sql",
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

function geoRow(id: string, date: string, country: string, sessions: number) {
  return {
    id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date,
    country,
    sessions,
    engagedSessions: 2,
    userEngagementDuration: 20,
    screenPageViews: 8,
    eventCount: 12,
    newUsers: 1,
    isOtherRow: false,
  };
}

function techRow(input: {
  id: string;
  date: string;
  device: string;
  browser: string;
  os: string;
  sessions: number;
}) {
  return {
    id: input.id,
    projectId: PROJECT,
    propertyId: PROPERTY,
    ga4ConnectionId: null,
    date: input.date,
    device: input.device,
    browser: input.browser,
    os: input.os,
    sessions: input.sessions,
    engagedSessions: 2,
    userEngagementDuration: 20,
    screenPageViews: 8,
    eventCount: 12,
    newUsers: 1,
    isOtherRow: false,
  };
}

async function cover(
  dates: string[],
  grain: "geo" | "technology",
  status: "SUCCESS_WITH_DATA" | "SUCCESS_ZERO_ROWS" | "FAILED" = "SUCCESS_WITH_DATA",
) {
  await Ga4SyncRepository.seedPendingUnits({
    projectId: PROJECT,
    propertyId: PROPERTY,
    dates,
    grains: [grain],
  });
  await Ga4SyncRepository.markUnits(
    dates.map((date) => ({
      projectId: PROJECT,
      propertyId: PROPERTY,
      date,
      grain,
      status,
    })),
  );
}

describe("Ga4SyncRepository geo grain reads", () => {
  it("groups by country over SUCCESS dates and excludes FAILED dates", async () => {
    await Ga4SyncRepository.upsertGeoRows([
      geoRow("g1", "2025-01-01", "United States", 70),
      geoRow("g2", "2025-01-02", "United States", 30),
      geoRow("g3", "2025-01-02", "Germany", 25),
      geoRow("g4", "2025-01-03", "France", 999),
    ]);
    await cover(["2025-01-01", "2025-01-02"], "geo");
    await cover(["2025-01-03"], "geo", "FAILED");
    const groups = await Ga4SyncRepository.getGeoGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-03",
    );
    expect(groups.map((group) => group.country)).toEqual([
      "United States",
      "Germany",
    ]);
    expect(groups[0]).toMatchObject({ sessions: 100, newUsers: 2 });
    expect(groups[0]?.isOtherRow).toBe(false);
  });

  it("upserts geo rows idempotently on retry", async () => {
    const row = geoRow("g1", "2025-01-01", "United States", 70);
    await Ga4SyncRepository.upsertGeoRows([row]);
    await Ga4SyncRepository.upsertGeoRows([{ ...row, sessions: 71 }]);
    await cover(["2025-01-01"], "geo");
    const groups = await Ga4SyncRepository.getGeoGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
    );
    expect(groups).toHaveLength(1);
    expect(groups[0]?.sessions).toBe(71);
  });

  it("flags (other) tail rows distinctly", async () => {
    await Ga4SyncRepository.upsertGeoRows([
      geoRow("g1", "2025-01-01", "United States", 70),
      {
        ...geoRow("g2", "2025-01-01", "(other)", 5),
        isOtherRow: true,
      },
    ]);
    await cover(["2025-01-01"], "geo");
    const groups = await Ga4SyncRepository.getGeoGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
    );
    const other = groups.find((group) => group.country === "(other)");
    expect(other?.isOtherRow).toBe(true);
    expect(other?.sessions).toBe(5);
  });
});

describe("Ga4SyncRepository technology grain reads", () => {
  it("groups by the requested dimension over SUCCESS dates", async () => {
    await Ga4SyncRepository.upsertTechnologyRows([
      techRow({ id: "t1", date: "2025-01-01", device: "desktop", browser: "Chrome", os: "Windows", sessions: 60 }),
      techRow({ id: "t2", date: "2025-01-01", device: "mobile", browser: "Safari", os: "iOS", sessions: 40 }),
      techRow({ id: "t3", date: "2025-01-01", device: "desktop", browser: "Firefox", os: "Linux", sessions: 10 }),
    ]);
    await cover(["2025-01-01"], "technology");
    const byDevice = await Ga4SyncRepository.getTechnologyGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { dimension: "device" },
    );
    expect(byDevice.map((group) => group.value)).toEqual([
      "desktop",
      "mobile",
    ]);
    expect(byDevice[0]).toMatchObject({
      dimension: "device",
      sessions: 70,
    });
    const byBrowser = await Ga4SyncRepository.getTechnologyGroups(
      PROJECT,
      PROPERTY,
      "2025-01-01",
      "2025-01-01",
      { dimension: "browser" },
    );
    expect(byBrowser).toHaveLength(3);
  });
});

describe("Ga4SyncRepository aggregation guards", () => {
  it("refuses project-wide geo rollups without a country entity", async () => {
    await expect(
      Ga4SyncRepository.getEntityTotals({
        projectId: PROJECT,
        propertyId: PROPERTY,
        table: "geo",
        entity: {},
        from: "2025-01-01",
        to: "2025-01-02",
      }),
    ).rejects.toBeInstanceOf(Ga4AggregationError);
  });

  it("refuses partial technology rollups without the full composite", async () => {
    await expect(
      Ga4SyncRepository.getEntityTotals({
        projectId: PROJECT,
        propertyId: PROPERTY,
        table: "technology",
        entity: { device: "desktop" },
        from: "2025-01-01",
        to: "2025-01-02",
      }),
    ).rejects.toBeInstanceOf(Ga4AggregationError);
  });

  it("sums complete geo/tech entities over covered dates only", async () => {
    await Ga4SyncRepository.upsertGeoRows([
      geoRow("g1", "2025-01-01", "Germany", 30),
      geoRow("g2", "2025-01-02", "Germany", 999),
    ]);
    await cover(["2025-01-01"], "geo");
    await cover(["2025-01-02"], "geo", "FAILED");
    const totals = await Ga4SyncRepository.getEntityTotals({
      projectId: PROJECT,
      propertyId: PROPERTY,
      table: "geo",
      entity: { country: "Germany" },
      from: "2025-01-01",
      to: "2025-01-02",
    });
    expect(totals.sessions).toBe(30);
  });

  it("never sums distinct-user metrics in repository reads (static guard)", () => {
    const source = readFileSync(
      resolve(process.cwd(), "src/server/features/ga4/repositories/Ga4SyncRepository.ts"),
      "utf8",
    );
    expect(source).not.toMatch(/sum\(\$\{ga4\w+\.(totalUsers|activeUsers)\}\)/);
    expect(source).not.toMatch(/SUM\(\s*["']?total_users/);
    expect(source).not.toMatch(/SUM\(\s*["']?active_users/);
  });
});
