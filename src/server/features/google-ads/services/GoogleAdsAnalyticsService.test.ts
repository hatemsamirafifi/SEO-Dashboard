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
  runBatch: async (build: (tx: unknown) => readonly Promise<unknown>[]) => {
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

import { GoogleAdsConnectionRepository } from "../repositories/GoogleAdsConnectionRepository";
import { GoogleAdsAnalyticsRepository } from "../repositories/GoogleAdsAnalyticsRepository";
import { getOverview } from "./GoogleAdsAnalyticsService";

const MIGRATIONS = [
  "drizzle/0064_google_ads_connections.sql",
  "drizzle/0065_great_stature.sql",
];

const SCOPE = {
  projectId: "project-1",
  organizationId: "org-a",
  customerId: "1234567890",
};

const FETCHED_AT = "2026-02-01T10:00:00.000Z";

async function connect(): Promise<void> {
  await GoogleAdsConnectionRepository.upsert({
    projectId: "project-1",
    organizationId: "org-a",
    customerId: "1234567890",
    loginCustomerId: null,
    customerDisplayName: "Example Customer",
    grantAccountId: "google-sub-1",
    connectedByUserId: "user-1",
    currencyCode: "USD",
    timeZone: "Europe/Lisbon",
    isTestAccount: false,
  });
}

function publish(
  date: string,
  metrics: {
    impressions: number | null;
    clicks: number | null;
    costMicros: number | null;
    conversions: number | null;
    conversionsValue: number | null;
  } | null,
) {
  return GoogleAdsAnalyticsRepository.publishUnit({
    scope: SCOPE,
    date,
    grain: "account",
    // null metrics row = success_zero_rows fixture (empty day).
    rows: metrics ? [{ metrics }] : [],
    sourceFetchedAt: FETCHED_AT,
    currencyCode: "USD",
    metricDateBasis: null,
  });
}

const COMPLETE_DAY = {
  impressions: 100,
  clicks: 10,
  costMicros: 2_500_000,
  conversions: 2.5,
  conversionsValue: 50,
};

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = ON");
  await database.client.execute(
    "CREATE TABLE organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    `CREATE TABLE projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL
     )`,
  );
  for (const migration of MIGRATIONS) {
    const sql = readFileSync(resolve(process.cwd(), migration), "utf8");
    for (const statement of sql
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.client.execute(statement);
    }
  }
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of [
    "google_ads_daily_account",
    "google_ads_analytics_units",
    "google_ads_connections",
    "projects",
    "organization",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    "INSERT INTO organization (id) VALUES ('org-a')",
  );
  await database.client.execute(
    "INSERT INTO projects (id, organization_id) VALUES ('project-1', 'org-a')",
  );
  await connect();
});

afterAll(() => database.client?.close());

describe("GoogleAdsAnalyticsService.getOverview", () => {
  it("aggregates stored sums with arithmetic-fixture precision", async () => {
    await publish("2026-01-15", COMPLETE_DAY);
    const overview = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-01", endDate: "2026-01-31" },
    });
    expect(overview.totals).toMatchObject({
      impressions: 100,
      clicks: 10,
      cost: 2.5,
      conversions: 2.5,
      conversionsValue: 50,
      ctr: 0.1,
      cpc: 0.25,
      cpa: 1,
      roas: 20,
    });
    expect(overview.coverage).toMatchObject({
      status: "partial",
      coveredDates: 1,
      totalDates: 31,
    });
    expect(overview.rowCount).toBe(1);
    expect(overview.daily).toHaveLength(1);
    expect(overview.daily[0]?.totals.ctr).toBe(0.1);
  });

  it("reports uncovered/covered-empty/covered via published units", async () => {
    await publish("2026-01-15", null);
    const emptyDay = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-15", endDate: "2026-01-15" },
    });
    expect(emptyDay.coverage.status).toBe("covered-empty");
    expect(emptyDay.totals.impressions).toBeNull();
    expect(emptyDay.totals.cost).toBeNull();

    const uncovered = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-01-01", endDate: "2026-01-02" },
    });
    expect(uncovered.coverage.status).toBe("uncovered");
    expect(
      (
        await getOverview({
          scope: SCOPE,
          window: { startDate: "2026-01-14", endDate: "2026-01-16" },
        })
      ).coverage.status,
    ).toBe("partial");

    await publish("2026-01-16", COMPLETE_DAY);
    expect(
      (
        await getOverview({
          scope: SCOPE,
          window: { startDate: "2026-01-15", endDate: "2026-01-16" },
        })
      ).coverage.status,
    ).toBe("covered");
  });

  it("caps query windows at the bounded month range", async () => {
    await expect(
      getOverview({
        scope: SCOPE,
        window: { startDate: "2020-01-01", endDate: "2026-01-01" },
      }),
    ).rejects.toThrow(/capped/);
    await expect(
      getOverview({
        scope: SCOPE,
        window: { startDate: "2026-05-01", endDate: "2026-01-01" },
      }),
    ).rejects.toThrow(/after the end/);
  });

  it("runs the gated equal-length preceding comparison", async () => {
    // Current window fully covered (2 days).
    await publish("2026-02-01", COMPLETE_DAY);
    await publish("2026-02-02", COMPLETE_DAY);
    const gated = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    // Preceding window (2026-01-31..02-01 shifted back) has no data: refused.
    expect(gated.compare.gate).toBe("partial_coverage");
    expect(gated.compare.deltas).toBeNull();

    // Publish the preceding window too; the gate opens.
    await publish("2026-01-30", COMPLETE_DAY);
    await publish("2026-01-31", COMPLETE_DAY);
    const ready = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    expect(ready.compare.gate).toBe("ready");
    expect(ready.compare.window).toEqual({
      startDate: "2026-01-30",
      endDate: "2026-01-31",
    });
    expect(ready.compare.deltas?.[0]).toMatchObject({
      metric: "impressions",
      current: 200,
      previous: 200,
      pctChange: 0,
    });

    // Mixed metricDateBasis across the two fully-covered windows closes the
    // gate again (coverage passes, basis check refuses).
    await GoogleAdsAnalyticsRepository.publishUnit({
      scope: SCOPE,
      date: "2026-02-02",
      grain: "account",
      rows: [{ metrics: COMPLETE_DAY }],
      sourceFetchedAt: FETCHED_AT,
      currencyCode: "USD",
      metricDateBasis: "conversion_date",
    });
    const mixed = await getOverview({
      scope: SCOPE,
      window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      compare: true,
    });
    expect(mixed.coverage.status).toBe("covered");
    expect(mixed.compare.gate).toBe("mixed_metric_date_basis");
  });
});
