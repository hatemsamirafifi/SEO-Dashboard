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

import { db } from "@/db";
import {
  audits,
  backlinkSnapshots,
  ga4Connections,
  ga4Syncs,
  googleAdsConnections,
  googleAdsSyncRuns,
  gscSearchPerformanceSyncs,
  rankCheckRuns,
  rankSnapshots,
  rankTrackingConfigs,
} from "@/db/schema";
import { SourceTokens } from "./SourceTokens";

/** Required non-default columns of the Ads sync run ledger. */
function adsRunSeed(
  id: string,
  overrides: Partial<typeof googleAdsSyncRuns.$inferInsert> = {},
): typeof googleAdsSyncRuns.$inferInsert {
  return {
    id,
    projectId: "project-1",
    organizationId: "org-1",
    customerId: "1234567890",
    runKey: `key-${id}`,
    mode: "manual",
    windowStartDate: "2026-01-01",
    windowEndDate: "2026-01-28",
    fingerprintGrantAccountId: "grant-1",
    fingerprintConnectionId: "ads-conn-1",
    fingerprintConnectionUpdatedAt: "2026-01-01T00:00:00.000Z",
    leaseExpiresAt: "2026-01-02T00:00:00.000Z",
    ...overrides,
  };
}

// Full real migration chain: the §7 selectors use the production Drizzle
// query builders (all columns), so the test database applies every drizzle
// migration in journal order. Structural parity lives in
// schema-parity.test.ts; here the selectors' SQL semantics execute for real.
function isMigrationJournal(value: unknown): value is {
  entries: Array<{ tag: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("entries" in value)) return false;
  const entries: unknown = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string",
    )
  );
}

function migrationFiles(): string[] {
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (!isMigrationJournal(journal)) {
    throw new Error("drizzle journal has an unexpected shape");
  }
  return journal.entries.map((entry) => `drizzle/${entry.tag}.sql`);
}

function migrationStatements(file: string): string[] {
  // Block comments can span statement breakpoints (e.g. snapshot-only
  // migrations), so strip them from the whole file before splitting.
  const withoutBlocks = readFileSync(
    resolve(process.cwd(), file),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
    .filter(Boolean);
}

async function resetTables() {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of [
    "gsc_search_performance_syncs",
    "ga4_connections",
    "ga4_syncs",
    "google_ads_connections",
    "google_ads_sync_runs",
    "rank_tracking_configs",
    "rank_check_runs",
    "rank_snapshots",
    "audits",
    "backlink_snapshots",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  // Selector logic under test, not constraints: FK enforcement off so seed
  // rows don't need full parent chains (parity is covered separately).
  await database.client.execute("PRAGMA foreign_keys = OFF");
  for (const file of migrationFiles()) {
    for (const statement of migrationStatements(file)) {
      await database.client.execute(statement);
    }
  }
  await database.client.execute(
    `INSERT OR IGNORE INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    `INSERT OR IGNORE INTO projects (id, organization_id, name)
     VALUES ('project-1', 'org-1', 'Test')`,
  );
}, 120000);
beforeEach(resetTables);
afterAll(() => database.client?.close());

describe("SourceTokens selectors", () => {
  it("returns null versions on an empty project", async () => {
    const state = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(state.versions).toEqual({
      gsc: null,
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
      google_ads: null,
    });
    expect(state.sourceSet).toEqual([]);
  });

  it("selects the latest GSC run with successful units, skipping zero-success", async () => {
    await db.insert(gscSearchPerformanceSyncs).values([
      {
        id: "gsc-old",
        projectId: "project-1",
        property: "sc-domain:x.com",
        status: "completed",
        completedAt: "2026-01-01T00:00:00.000Z",
        successfulUnits: 3,
        syncType: "incremental",
        requestedStartDate: "2026-01-01",
        requestedEndDate: "2026-01-01",
      },
      {
        id: "gsc-zero",
        projectId: "project-1",
        property: "sc-domain:x.com",
        status: "failed",
        completedAt: "2026-01-02T00:00:00.000Z",
        successfulUnits: 0,
        syncType: "incremental",
        requestedStartDate: "2026-01-02",
        requestedEndDate: "2026-01-02",
      },
    ]);
    expect(await SourceTokens.selectGscVersion("project-1")).toBe("gsc-old");
  });

  it("selects GA4 versions across connection properties", async () => {
    await db.insert(ga4Connections).values({
      id: "conn-1",
      projectId: "project-1",
      organizationId: "org-1",
      propertyId: "properties/1",
      propertyDisplayName: "P1",
      connectedByUserId: "u1",
      ga4AccountId: "a1",
    });
    await db.insert(ga4Syncs).values({
      id: "ga4-run",
      projectId: "project-1",
      propertyId: "properties/1",
      status: "completed",
      syncType: "incremental",
      requestedStartDate: "2026-01-01",
      requestedEndDate: "2026-01-01",
      startedAt: "2026-01-02T00:00:00.000Z",
      completedAt: "2026-01-02T00:00:00.000Z",
      successfulUnits: 2,
    });
    expect(await SourceTokens.selectGa4Version("project-1")).toBe("ga4-run");
  });

  it("builds the rank token per config, order-invariant", async () => {
    await db.insert(rankTrackingConfigs).values([
      { id: "cfg-b", projectId: "project-1", domain: "b.com", serpDepth: 20 },
      { id: "cfg-a", projectId: "project-1", domain: "a.com", serpDepth: 20 },
    ]);
    await db.insert(rankCheckRuns).values([
      {
        id: "run-b",
        configId: "cfg-b",
        projectId: "project-1",
        status: "completed",
        completedAt: "2026-01-02T00:00:00.000Z",
      },
      {
        id: "run-a",
        configId: "cfg-a",
        projectId: "project-1",
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/no-explicit-any -- test simulation of a partial rank check run
        status: "partial" as any,
        completedAt: "2026-01-03T00:00:00.000Z",
      },
    ]);
    await db.insert(rankSnapshots).values({
      runId: "run-a",
      trackingKeywordId: "kw-1",
      keyword: "seo",
      device: "desktop",
    });
    const first = await SourceTokens.selectRankVersion("project-1");
    expect(first).not.toBeNull();
    // Newer completed run on cfg-a replaces the partial: token changes.
    await db.insert(rankCheckRuns).values({
      id: "run-a2",
      configId: "cfg-a",
      projectId: "project-1",
      status: "completed",
      completedAt: "2026-01-04T00:00:00.000Z",
    });
    expect(await SourceTokens.selectRankVersion("project-1")).not.toBe(first);
  });

  it("ignores partial rank runs without snapshots", async () => {
    await db.insert(rankTrackingConfigs).values({
      id: "cfg-1",
      projectId: "project-1",
      domain: "x.com",
      serpDepth: 20,
    });
    await db.insert(rankCheckRuns).values({
      id: "run-empty",
      configId: "cfg-1",
      projectId: "project-1",
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion, typescript/no-unsafe-assignment, typescript/no-explicit-any -- test simulation of a partial rank check run
      status: "partial" as any,
      completedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(await SourceTokens.selectRankVersion("project-1")).toBeNull();
  });

  it("takes completed audits only; running feeds active mutations", async () => {
    await db.insert(audits).values([
      {
        id: "audit-done",
        projectId: "project-1",
        startedByUserId: "u1",
        startUrl: "https://x.com",
        status: "completed",
        startedAt: "2026-01-01T00:00:00.000Z",
        completedAt: "2026-01-01T01:00:00.000Z",
      },
      {
        id: "audit-running",
        projectId: "project-1",
        startedByUserId: "u1",
        startUrl: "https://x.com",
        status: "running",
        startedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    const { version } = await SourceTokens.selectAuditVersion("project-1");
    expect(version).toBe("audit-done");
    const state = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(state.activeMutations.audit).toEqual({
      isMutating: true,
      activeRunIds: ["audit-running"],
    });
  });

  it("picks the latest backlink snapshot with id tiebreak", async () => {
    await db.insert(backlinkSnapshots).values([
      {
        projectId: "project-1",
        domain: "x.com",
        capturedAt: "2026-01-01T00:00:00.000Z",
      },
      {
        projectId: "project-1",
        domain: "x.com",
        capturedAt: "2026-01-02T00:00:00.000Z",
      },
    ]);
    const version = await SourceTokens.selectBacklinksVersion("project-1");
    expect(version).toMatch(/^backlinks:\d+$/);
  });

  it("hashes state stably and changes on any version flip", async () => {
    const before = await SourceTokens.assembleDetectionSourceState("project-1");
    const hashBefore = await SourceTokens.hashSourceState(before);
    expect(hashBefore).toHaveLength(64);
    await db.insert(backlinkSnapshots).values({
      projectId: "project-1",
      domain: "x.com",
      capturedAt: "2026-01-05T00:00:00.000Z",
    });
    const after = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(after.sourceSet).toContain("backlinks");
    expect(await SourceTokens.hashSourceState(after)).not.toBe(hashBefore);
    // Reordered keys hash identically (canonical JSON).
    const reordered = {
      ...after,
      versions: {
        backlinks: after.versions.backlinks,
        audit: after.versions.audit,
        rank: after.versions.rank,
        ga4: after.versions.ga4,
        gsc: after.versions.gsc,
        google_ads: after.versions.google_ads,
      },
    };
    expect(await SourceTokens.hashSourceState(reordered)).toBe(
      await SourceTokens.hashSourceState(after),
    );
  });

  it("detects active GSC/GA4/rank mutations", async () => {
    await db.insert(gscSearchPerformanceSyncs).values({
      id: "gsc-active",
      projectId: "project-1",
      property: "sc-domain:x.com",
      status: "running",
      syncType: "incremental",
      requestedStartDate: "2026-01-02",
      requestedEndDate: "2026-01-02",
    });
    const state = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(SourceTokens.hasActiveMutations(state)).toBe(true);
    expect(SourceTokens.describeActiveMutations(state)).toEqual([
      "gsc:gsc-active",
    ]);
  });
});

describe("SourceTokens Google Ads selectors (phase 5)", () => {
  async function connectAds() {
    await db.insert(googleAdsConnections).values({
      id: "ads-conn-1",
      projectId: "project-1",
      organizationId: "org-1",
      customerId: "1234567890",
      grantAccountId: "grant-1",
      connectedByUserId: "u1",
    });
  }

  it("returns no token without a connection row", async () => {
    expect(await SourceTokens.selectGoogleAdsVersion("project-1")).toBeNull();
    expect(await SourceTokens.selectGoogleAdsMutation("project-1")).toEqual({
      isMutating: false,
      activeRunIds: [],
    });
  });

  it("advances only on runs with succeeded units for the selected customer", async () => {
    await connectAds();
    await db.insert(googleAdsSyncRuns).values([
      adsRunSeed("ads-old", {
        status: "success",
        completedAt: "2026-01-02T00:00:00.000Z",
        unitsSucceeded: 3,
      }),
      // Zero-success completed run: newer but never advances the token.
      adsRunSeed("ads-zero", {
        status: "failed",
        completedAt: "2026-01-03T00:00:00.000Z",
        unitsSucceeded: 0,
      }),
      // Unfinalized run: ignored entirely.
      adsRunSeed("ads-pending", { status: "running" }),
      // Different customer id: not the project's selected source.
      adsRunSeed("ads-other-customer", {
        customerId: "9999999999",
        fingerprintConnectionId: "ads-conn-x",
        status: "success",
        completedAt: "2026-01-04T00:00:00.000Z",
        unitsSucceeded: 9,
      }),
    ]);
    expect(await SourceTokens.selectGoogleAdsVersion("project-1")).toBe(
      "ads-old",
    );
  });

  it("prefers the newest succeeded run deterministically", async () => {
    await connectAds();
    await db.insert(googleAdsSyncRuns).values([
      adsRunSeed("ads-early", {
        status: "success",
        completedAt: "2026-01-02T00:00:00.000Z",
        unitsSucceeded: 3,
      }),
      adsRunSeed("ads-late", {
        status: "partial",
        completedAt: "2026-01-05T00:00:00.000Z",
        unitsSucceeded: 1,
      }),
    ]);
    expect(await SourceTokens.selectGoogleAdsVersion("project-1")).toBe(
      "ads-late",
    );
  });

  it("flags pending/running Ads runs as active mutations, scoped to the selected customer", async () => {
    await connectAds();
    await db.insert(googleAdsSyncRuns).values([
      adsRunSeed("ads-active", { status: "running" }),
      // Stale run for a deselected customer must not gate the detect stage.
      adsRunSeed("ads-stale-run", {
        customerId: "9999999999",
        fingerprintConnectionId: "ads-conn-x",
        status: "pending",
      }),
    ]);
    expect(await SourceTokens.selectGoogleAdsMutation("project-1")).toEqual({
      isMutating: true,
      activeRunIds: ["ads-active"],
    });
  });

  it("assembles the google_ads token into state and hashes it", async () => {
    await connectAds();
    await db.insert(googleAdsSyncRuns).values(
      adsRunSeed("ads-run", {
        status: "success",
        completedAt: "2026-01-02T00:00:00.000Z",
        unitsSucceeded: 5,
      }),
    );
    const state = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(state.versions.google_ads).toBe("ads-run");
    expect(state.sourceSet).toEqual(["google_ads"]);
    const detached = {
      ...state,
      versions: { ...state.versions },
    };
    expect(await SourceTokens.hashSourceState(detached)).toBe(
      await SourceTokens.hashSourceState(state),
    );
    await db.insert(googleAdsSyncRuns).values(
      adsRunSeed("ads-run-2", {
        status: "success",
        completedAt: "2026-01-06T00:00:00.000Z",
        unitsSucceeded: 2,
      }),
    );
    const next = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(next.versions.google_ads).toBe("ads-run-2");
    expect(await SourceTokens.hashSourceState(next)).not.toBe(
      await SourceTokens.hashSourceState(state),
    );
  });

  it("surfaces active Ads runs in the mutation description", async () => {
    await connectAds();
    await db
      .insert(googleAdsSyncRuns)
      .values([
        adsRunSeed("ads-run-a", { status: "pending" }),
        adsRunSeed("ads-run-b", { status: "running" }),
      ]);
    const state = await SourceTokens.assembleDetectionSourceState("project-1");
    expect(SourceTokens.hasActiveMutations(state)).toBe(true);
    expect(SourceTokens.describeActiveMutations(state)).toEqual([
      "google_ads:ads-run-a,ads-run-b",
    ]);
  });
});
