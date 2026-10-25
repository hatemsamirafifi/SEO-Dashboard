// Shared in-memory SQLite harness for the stored Google Ads analytics /
// sync service tests: registers the module mocks once (module top level, so
// every importer sees them registered before the repositories evaluate),
// owns the bounded test fixtures, and exposes the table lifecycle helpers.
import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeEach, vi } from "vitest";

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

const MIGRATIONS = [
  "drizzle/0064_google_ads_connections.sql",
  "drizzle/0065_great_stature.sql",
];

export const SCOPE = {
  projectId: "project-1",
  organizationId: "org-a",
  customerId: "1234567890",
};

export const FETCHED_AT = "2026-02-01T10:00:00.000Z";

export const COMPLETE_DAY = {
  impressions: 100,
  clicks: 10,
  costMicros: 2_500_000,
  conversions: 2.5,
  conversionsValue: 50,
};

export type GoogleAdsTestDatabase = () => Client | undefined;

/** Re-applied by every test's beforeEach: bounded table cleanup with the
 *  org/project rows that the foreign keys require re-created each time. */
export async function resetAnalyticsTables(): Promise<void> {
  const client = database.client;
  if (!client) throw new Error("Test database was not initialized");
  for (const table of [
    "google_ads_daily_account",
    "google_ads_analytics_units",
    "google_ads_connections",
    "projects",
    "organization",
  ]) {
    await client.execute(`DELETE FROM ${table}`);
  }
  await client.execute("INSERT INTO organization (id) VALUES ('org-a')");
  await client.execute(
    "INSERT INTO projects (id, organization_id) VALUES ('project-1', 'org-a')",
  );
  await connect();
}

export function activeAnalyticsTestClient(): Client {
  if (!database.client) {
    throw new Error("Test database was not initialized");
  }
  return database.client;
}

/** Runs the 0064/0065 migrations against the in-memory database and enables
 *  the foreign-key prune on connection deletes. */
export async function initializeAnalyticsTestDatabase(): Promise<void> {
  const client = activeAnalyticsTestClient();
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(
    "CREATE TABLE organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await client.execute(
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
      await client.execute(statement);
    }
  }
}

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

/** Publishes an account-grain unit for one day; null metrics row = the
 *  success_zero_rows fixture (an empty day). */
export function publish(
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
    rows: metrics ? [{ metrics }] : [],
    sourceFetchedAt: FETCHED_AT,
    currencyCode: "USD",
    metricDateBasis: null,
  });
}

export function publishGrain(
  date: string,
  grain:
    | "campaign"
    | "ad_group"
    | "keyword"
    | "search_term"
    | "device"
    | "landing_page",
  rows: Array<Record<string, unknown>>,
) {
  return GoogleAdsAnalyticsRepository.publishUnit({
    scope: SCOPE,
    date,
    grain,
    rows,
    sourceFetchedAt: FETCHED_AT,
    currencyCode: "USD",
    metricDateBasis: "interaction_date",
  });
}

export function campaignRow(resourceId: string) {
  return { campaignResourceId: resourceId, metrics: COMPLETE_DAY };
}

/** Applies the shared cleanup to a test without repeating the table list. */
export function analyticsTestDbEach(): void {
  beforeEach(() => resetAnalyticsTables());
}
