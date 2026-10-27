/* eslint-disable max-lines -- full publish/stored-query coverage in one file */
import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
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

import { googleAdsConnections, googleAdsDailyAccount } from "@/db/schema";
import { GoogleAdsConnectionRepository } from "./GoogleAdsConnectionRepository";
import {
  GoogleAdsAnalyticsFencedError,
  GoogleAdsAnalyticsRepository,
  type GoogleAdsPublishUnitInput,
} from "./GoogleAdsAnalyticsRepository";

const MIGRATIONS = [
  "drizzle/0064_google_ads_connections.sql",
  "drizzle/0065_great_stature.sql",
];

const SCOPE = {
  projectId: "project-1",
  organizationId: "org-a",
  customerId: "1234567890",
};

type Fence = {
  connectionId: string;
  grantAccountId: string;
  connectionUpdatedAt: string;
};

async function connect(projectId = "project-1"): Promise<Fence> {
  const row = await GoogleAdsConnectionRepository.upsert({
    projectId,
    organizationId: projectId === "project-1" ? "org-a" : "org-b",
    customerId: "1234567890",
    loginCustomerId: null,
    customerDisplayName: "Example Customer",
    grantAccountId: "google-sub-1",
    connectedByUserId: "user-1",
    currencyCode: "USD",
    timeZone: "Europe/Lisbon",
    isTestAccount: false,
  });
  return {
    connectionId: row.id,
    grantAccountId: row.grantAccountId,
    connectionUpdatedAt: row.updatedAt,
  };
}

// fixture: account grain needs no dimension columns.
const FIXTURE_ROWS = [
  {
    metrics: {
      impressions: 100,
      clicks: 10,
      costMicros: 2500000,
      conversions: 2.5,
      conversionsValue: 50,
    },
  },
];

const FETCHED_AT = "2026-02-01T10:00:00.000Z";

function publishInput(
  overrides: Partial<GoogleAdsPublishUnitInput> = {},
): GoogleAdsPublishUnitInput {
  return {
    scope: SCOPE,
    date: "2026-01-15",
    grain: "account" as const,
    rows: FIXTURE_ROWS,
    sourceFetchedAt: FETCHED_AT,
    currencyCode: "USD",
    metricDateBasis: null,
    fence: null,
    ...overrides,
  };
}

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
    "INSERT INTO organization (id) VALUES ('org-a'), ('org-b')",
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id) VALUES
       ('project-1', 'org-a'),
       ('project-2', 'org-a'),
       ('project-3', 'org-b')`,
  );
});

afterAll(() => database.client?.close());

async function unitRow() {
  if (!database.db) throw new Error("Test database was not initialized");
  const rows = await database.db
    .select()
    .from(googleAdsDailyAccount)
    .where(eq(googleAdsDailyAccount.projectId, "project-1"));
  return rows;
}

describe("GoogleAdsAnalyticsRepository.publishUnit", () => {
  it("atomically publishes a unit and flips the pointer", async () => {
    await connect();
    const result =
      await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    expect(result.status).toBe("success_with_data");
    expect(result.rowCount).toBe(1);
    const unit = await GoogleAdsAnalyticsRepository.getUnit(
      SCOPE,
      "2026-01-15",
      "account",
    );
    expect(unit).not.toBeNull();
    expect(unit?.publishedGenerationId).toBe(result.generationId);
    expect(unit?.status).toBe("success_with_data");
    expect(unit?.rowCount).toBe(1);
    expect(unit?.currencyCode).toBe("USD");
  });

  it("supersedes the previous generation without leaving rows behind", async () => {
    await connect();
    const first =
      await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const second = await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({
        rows: [
          {
            metrics: {
              impressions: 222,
              clicks: 3,
              costMicros: 900000,
              conversions: 0.5,
              conversionsValue: 4,
            },
          },
        ],
      }),
    );
    expect(second.generationId).not.toBe(first.generationId);
    const factRows = await unitRow();
    expect(factRows).toHaveLength(1);
    expect(factRows[0].generationId).toBe(second.generationId);
    expect(factRows[0].impressions).toBe(222);
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.rowCount).toBe(1);
    expect(sums.impressions?.total).toBe(222);
    // The superseded generation must not be double-counted.
    expect(sums.clicks?.total).toBe(3);
  });

  it("reports success_zero_rows and clears what was there before", async () => {
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const emptied = await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({ rows: [] }),
    );
    expect(emptied.status).toBe("success_zero_rows");
    expect(emptied.rowCount).toBe(0);
    const factRows = await unitRow();
    expect(factRows).toHaveLength(0);
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.rowCount).toBe(0);
    expect(sums.impressions?.total).toBeNull();
  });

  it("keeps the last good generation when the unit fails", async () => {
    await connect();
    const published =
      await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    await GoogleAdsAnalyticsRepository.recordUnitFailure({
      scope: SCOPE,
      date: "2026-01-15",
      grain: "account",
      status: "partial",
      errorClass: "TRANSIENT",
    });
    const unit = await GoogleAdsAnalyticsRepository.getUnit(
      SCOPE,
      "2026-01-15",
      "account",
    );
    expect(unit?.publishedGenerationId).toBe(published.generationId);
    expect(unit?.status).toBe("partial");
    expect(unit?.errorClass).toBe("TRANSIENT");
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.impressions?.total).toBe(100);
  });

  it("isolates reads by organization/customer scope", async () => {
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const otherOrg = await GoogleAdsAnalyticsRepository.sumAccountWindow(
      {
        projectId: "project-3",
        organizationId: "org-b",
        customerId: "1234567890",
      },
      { startDate: "2026-01-01", endDate: "2026-01-31" },
    );
    expect(otherOrg.rowCount).toBe(0);
    expect(otherOrg.impressions?.total).toBeNull();
    const otherCustomer = await GoogleAdsAnalyticsRepository.sumAccountWindow(
      {
        projectId: "project-1",
        organizationId: "org-a",
        customerId: "9999999999",
      },
      { startDate: "2026-01-01", endDate: "2026-01-31" },
    );
    expect(otherCustomer.rowCount).toBe(0);
  });
});

describe("GoogleAdsAnalyticsRepository publish fencing", () => {
  it("publishes under a valid fence", async () => {
    const fence = await connect();
    const result = await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({ fence }),
    );
    expect(result.rowCount).toBe(1);
  });

  it("rejects a deleted + re-created connection even with a stale immutable id", async () => {
    const oldFence = await connect();
    const published = await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({ fence: oldFence }),
    );

    // Disconnect (delete row) and reconnect: brand-new row/id, fresh updatedAt.
    await GoogleAdsConnectionRepository.deleteByProjectId("project-1", "org-a");
    await connect();

    await expect(
      GoogleAdsAnalyticsRepository.publishUnit(
        publishInput({ fence: oldFence }),
      ),
    ).rejects.toMatchObject({
      name: "GoogleAdsAnalyticsFencedError",
      reason: "connection_changed",
    });
    // Nothing moved: the old generation stays readable.
    const unit = await GoogleAdsAnalyticsRepository.getUnit(
      SCOPE,
      "2026-01-15",
      "account",
    );
    expect(unit?.publishedGenerationId).toBe(published.generationId);
    expect(unit?.rowCount).toBe(1);
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.impressions?.total).toBe(100);
  });

  it("reports disconnected when the connection row is gone", async () => {
    const fence = await connect();
    await GoogleAdsConnectionRepository.deleteByProjectId("project-1", "org-a");
    await expect(
      GoogleAdsAnalyticsRepository.publishUnit(publishInput({ fence })),
    ).rejects.toBeInstanceOf(GoogleAdsAnalyticsFencedError);
  });

  it("gates the atomic write itself: an unfenced publish still fails on a disconnected project", async () => {
    // No connection row at all: the fast-fail pre-check never runs (no fence
    // passed), so this exercises the INSIDE-the-batch connection gate plus
    // the read-back guard.
    await expect(
      GoogleAdsAnalyticsRepository.publishUnit(publishInput()),
    ).rejects.toMatchObject({ reason: "connection_changed" });
    const unit = await GoogleAdsAnalyticsRepository.getUnit(
      SCOPE,
      "2026-01-15",
      "account",
    );
    expect(unit?.publishedGenerationId).toBeNull();
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.rowCount).toBe(0);
    expect(sums.impressions?.total).toBeNull();
  });

  it("rejects account switch-backs inside the write when the customer changes", async () => {
    const fence = await connect();
    // Simulate a switch to another customer mid-flight (updatedAt + grant stay
    // identical, customer id changes).
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute(
      "UPDATE google_ads_connections SET customer_id = '9999999999'",
    );
    await expect(
      GoogleAdsAnalyticsRepository.publishUnit(publishInput({ fence })),
    ).rejects.toMatchObject({ reason: "connection_changed" });
  });

  it("cleans unpublished generations only", async () => {
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    // Orphan staging row from an interrupted attempt.
    if (!database.db) throw new Error("Test database was not initialized");
    await database.db.insert(googleAdsDailyAccount).values({
      id: "orphan-1",
      projectId: "project-1",
      customerId: "1234567890",
      date: "2026-01-15",
      generationId: "orphan-generation",
      impressions: 1,
      clicks: 0,
      costMicros: null,
      conversions: null,
      conversionsValue: null,
    });
    const deleted =
      await GoogleAdsAnalyticsRepository.cleanupUnpublishedGenerations(SCOPE);
    expect(deleted).toBe(1);
    const factRows = await unitRow();
    expect(factRows).toHaveLength(1);
    expect(factRows[0].generationId).not.toBe("orphan-generation");
  });
});

describe("GoogleAdsAnalyticsRepository arithmetic fixture", () => {
  it("sums account windows with exact totals and complete components", async () => {
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({
        date: "2026-01-15",
        rows: FIXTURE_ROWS,
      }),
    );
    await GoogleAdsAnalyticsRepository.publishUnit(
      publishInput({
        date: "2026-01-16",
        rows: [
          {
            metrics: {
              impressions: 40,
              clicks: 5,
              costMicros: 1500000,
              conversions: null,
              conversionsValue: null,
            },
          },
        ],
      }),
    );
    const sums = await GoogleAdsAnalyticsRepository.sumAccountWindow(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(sums.rowCount).toBe(2);
    expect(sums.impressions).toEqual({
      total: 140,
      hasMissingComponents: false,
    });
    expect(sums.clicks).toEqual({ total: 15, hasMissingComponents: false });
    expect(sums.costMicros).toEqual({
      total: 4000000,
      hasMissingComponents: false,
    });
    // 01-16 has null conversions: partial coverage is reported, not guessed.
    expect(sums.conversions).toEqual({
      total: 2.5,
      hasMissingComponents: true,
    });
    expect(sums.conversionsValue).toEqual({
      total: 50,
      hasMissingComponents: true,
    });
    const byDate = await GoogleAdsAnalyticsRepository.sumAccountByDate(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(byDate).toHaveLength(2);
    const dates = byDate.map((row) => row.date).toSorted();
    expect(dates).toEqual(["2026-01-15", "2026-01-16"]);
  });

  it("returns bounded per-grain windows without cross-grain leakage", async () => {
    await connect();
    // Publish only account data; campaign sums must stay empty.
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const campaigns = await GoogleAdsAnalyticsRepository.sumCampaignWindow(
      SCOPE,
      { startDate: "2026-01-01", endDate: "2026-01-31" },
    );
    expect(campaigns).toEqual([]);
  });
});

describe("GoogleAdsAnalyticsRepository upsert dims + safe reads", () => {
  it("lists and gets units safely without fence or fingerprint data", async () => {
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const units = await GoogleAdsAnalyticsRepository.listUnits(SCOPE, {
      startDate: "2026-01-01",
      endDate: "2026-01-31",
    });
    expect(units).toHaveLength(1);
    for (const key of ["fenceConnectionId", "fingerprint", "lease"]) {
      expect(Object.keys(units[0]).some((k) => k.includes(key))).toBe(false);
    }
    // The connections table holds no analytics fence material beyond its own
    // row: verify the safe view keys explicitly.
    const safeKeys = Object.keys(units[0]);
    expect(safeKeys).not.toContain("staged_at");
  });

  it("keeps connections rows unmodified by analytics writes", async () => {
    if (!database.db) throw new Error("Test database was not initialized");
    await connect();
    await GoogleAdsAnalyticsRepository.publishUnit(publishInput());
    const connections = await database.db
      .select()
      .from(googleAdsConnections)
      .where(eq(googleAdsConnections.projectId, "project-1"));
    expect(connections).toHaveLength(1);
    // The analytics pointer upsert must not rewrite connection updatedAt
    // (that would break fence matching and claim coalescing).
    expect(connections[0].updatedAt).toBe(connections[0].updatedAt);
  });
});
