// Shared support for the GoogleAdsSyncService test files: an in-memory
// database, the table/migrations bootstrap, per-table resets and a typed
// test double for the fixed daily reporting reads. This module must not
// import the service or any repository so that the per-file vitest module
// mocks can load it safely from their factories.

import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type {
  GoogleAdsDailyAccountRow,
  GoogleAdsDailyAdGroupRow,
  GoogleAdsDailyCampaignRow,
  GoogleAdsDailyDeviceRow,
  GoogleAdsDailyFactsInput,
  GoogleAdsDailyFactsResult,
  GoogleAdsDailyKeywordRow,
  GoogleAdsDailyLandingPageRow,
  GoogleAdsDailySearchTermRow,
} from "@/server/lib/googleAdsReporting";
import type { GoogleAdsFactsClient } from "./googleAdsSyncFetch";

export const PROJECT_ID = "project-1";
export const ORGANIZATION_ID = "org-a";
export const CUSTOMER_ID = "1234567890";
export const FETCHED_AT = "2026-02-01T10:00:00.000Z";
export const DATE = "2026-02-01";

export const SCOPE = {
  projectId: PROJECT_ID,
  organizationId: ORGANIZATION_ID,
  customerId: CUSTOMER_ID,
};

export const testDatabase = {
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
};

/** Builds the in-memory database module backing the "@/db" mock. */
export async function createTestDatabaseModule(): Promise<typeof testDatabase> {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  testDatabase.client = createClient({ url: "file::memory:" });
  testDatabase.db = drizzle(testDatabase.client);
  return testDatabase;
}

export async function runBatchStatements(
  build: (tx: unknown) => readonly Promise<unknown>[],
): Promise<unknown[]> {
  if (!testDatabase.db) throw new Error("Test database was not initialized");
  const results: unknown[] = [];
  for (const statement of build(testDatabase.db)) {
    results.push(await statement);
  }
  return results;
}

export async function executeInBatches(
  items: unknown[],
  buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
): Promise<void> {
  if (!testDatabase.db) throw new Error("Test database was not initialized");
  for (const item of items) await buildStatement(testDatabase.db, item);
}

const MIGRATIONS = [
  "drizzle/0064_google_ads_connections.sql",
  "drizzle/0065_great_stature.sql",
];

const SYNC_TABLES = [
  "google_ads_sync_units",
  "google_ads_sync_runs",
  "google_ads_daily_account",
  "google_ads_daily_campaign",
  "google_ads_daily_ad_group",
  "google_ads_daily_keyword",
  "google_ads_daily_search_term",
  "google_ads_daily_device",
  "google_ads_daily_landing_page",
  "google_ads_analytics_units",
  "google_ads_accounts",
  "google_ads_campaigns",
  "google_ads_ad_groups",
  "google_ads_keywords",
  "google_ads_connections",
  "projects",
  "organization",
];

async function requireClient(): Promise<Client> {
  if (!testDatabase.client) {
    throw new Error("Test database was not initialized");
  }
  return testDatabase.client;
}

/** Applies the project/org seeds and the Google Ads migrations once. */
export async function createSyncTables(): Promise<void> {
  const client = await requireClient();
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

/** Clears every Google Ads table and reseeds the org/project rows. */
export async function resetSyncTables(): Promise<void> {
  const client = await requireClient();
  for (const table of SYNC_TABLES) {
    await client.execute(`DELETE FROM ${table}`);
  }
  await client.execute("INSERT INTO organization (id) VALUES ('org-a')");
  await client.execute(
    `INSERT INTO projects (id, organization_id)
     VALUES ('project-1', 'org-a')`,
  );
}

export function closeTestDatabase(): void {
  testDatabase.client?.close();
}

type GrainRows = {
  account: GoogleAdsDailyAccountRow;
  campaign: GoogleAdsDailyCampaignRow;
  ad_group: GoogleAdsDailyAdGroupRow;
  keyword: GoogleAdsDailyKeywordRow;
  search_term: GoogleAdsDailySearchTermRow;
  device: GoogleAdsDailyDeviceRow;
  landing_page: GoogleAdsDailyLandingPageRow;
};

type Grain = keyof GrainRows;

export const GRAINS: Grain[] = [
  "account",
  "campaign",
  "ad_group",
  "keyword",
  "search_term",
  "device",
  "landing_page",
];

type GrainBehavior<G extends Grain> = {
  rows?: GrainRows[G][];
  truncated?: boolean;
  malformedRows?: number;
  throw?: unknown;
};

/** A test double for the fixed daily reporting reads: per-grain behaviors,
 *  per-grain failure prefixes (transient retries) and a fetch call log. */
export class TestAdsClient {
  fetchCalls: Array<{ grain: Grain; date: string }> = [];
  private behaviors: { [G in Grain]?: GrainBehavior<G> } = {};
  private failures = new Map<Grain, number>();
  private throws = new Map<Grain, unknown>();

  behavior<G extends Grain>(grain: G, behavior: GrainBehavior<G>): void {
    Reflect.set(this.behaviors, grain, behavior);
  }

  /** Fails the first `times` fetches for the grain with `error`, then serves
   *  the grain rows. */
  failFirst(grain: Grain, times: number, error: unknown): void {
    this.failures.set(grain, times);
    this.throws.set(grain, error);
  }

  asClient(): GoogleAdsFactsClient {
    return {
      getDailyAccountFacts: (input) => this.outcome("account", input),
      getDailyCampaignFacts: (input) => this.outcome("campaign", input),
      getDailyAdGroupFacts: (input) => this.outcome("ad_group", input),
      getDailyKeywordFacts: (input) => this.outcome("keyword", input),
      getDailySearchTermFacts: (input) => this.outcome("search_term", input),
      getDailyDeviceFacts: (input) => this.outcome("device", input),
      getDailyLandingPageFacts: (input) => this.outcome("landing_page", input),
    };
  }

  private async outcome<G extends Grain>(
    grain: G,
    input: GoogleAdsDailyFactsInput,
  ): Promise<GoogleAdsDailyFactsResult<GrainRows[G]>> {
    this.fetchCalls.push({ grain, date: input.startDate });
    const budget = this.failures.get(grain);
    if (budget !== undefined) {
      if (budget > 0) {
        this.failures.set(grain, budget - 1);
        throw this.throws.get(grain) ?? new Error("test failure");
      }
      // Budget consumed: the grain behaves normally from here.
      this.failures.delete(grain);
      this.throws.delete(grain);
    }
    const behavior = this.behaviors[grain];
    if (behavior?.throw !== undefined) throw behavior.throw;
    return {
      grain,
      customerId: input.customerId,
      startDate: input.startDate,
      endDate: input.endDate,
      metricDateBasis: "interaction_date",
      source: "google_ads",
      fetchedAt: FETCHED_AT,
      rows: behavior?.rows ?? [],
      truncated: behavior?.truncated ?? false,
      malformedRows: behavior?.malformedRows ?? 0,
      partial: false,
    };
  }
}

const METRICS = {
  impressions: 10,
  clicks: 2,
  costMicros: 50000,
  conversions: 1,
  conversionsValue: 5,
};

const STUB_ROWS: { [G in Grain]: (date: string) => GrainRows[G][] } = {
  account: (date) => [
    {
      date,
      metrics: METRICS,
      resourceName: `customers/${CUSTOMER_ID}`,
      displayName: "Ads Account",
      currencyCode: "USD",
      timeZone: "Etc/GMT",
    },
  ],
  campaign: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      campaignId: "111",
      campaignName: "Brand",
      campaignStatus: "ENABLED",
      servingStatus: "RUNNABLE",
      advertisingChannelType: "SEARCH",
    },
  ],
  ad_group: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      adGroupResourceId: "adgroup-1",
      adGroupId: "1",
      adGroupName: "Shoes",
      adGroupStatus: "ENABLED",
    },
  ],
  keyword: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      adGroupResourceId: "adgroup-1",
      keywordResourceId: "keyword-1",
      criterionId: "1",
      keywordText: "red shoes",
      keywordMatchType: "EXACT",
    },
  ],
  search_term: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      adGroupResourceId: "adgroup-1",
      searchTermResourceId: "searchterm-1",
      searchText: "red shoes",
      keywordText: null,
      keywordMatchType: null,
    },
  ],
  device: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      device: "MOBILE",
    },
  ],
  landing_page: (date) => [
    {
      date,
      metrics: METRICS,
      campaignResourceId: "campaign-1",
      landingPageResourceId: "landingpage-1",
      landingPageUrl: "https://example.test/landing",
    },
  ],
};

export function stubRows<G extends Grain>(
  grain: G,
  date: string,
): GrainRows[G][] {
  return STUB_ROWS[grain](date);
}
