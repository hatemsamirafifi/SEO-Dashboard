/* eslint-disable max-lines -- full run-lifecycle coverage in one file */
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
import type {
  GoogleAdsConnectionInput,
  GoogleAdsConnection,
} from "./GoogleAdsConnectionRepository";

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

import { googleAdsSyncRuns } from "@/db/schema";
import { GoogleAdsConnectionRepository } from "./GoogleAdsConnectionRepository";
import { GoogleAdsSyncRepository } from "./GoogleAdsSyncRepository";

const MIGRATIONS = [
  "drizzle/0064_google_ads_connections.sql",
  "drizzle/0065_great_stature.sql",
];

function connectionInput(
  overrides: Partial<GoogleAdsConnectionInput> = {},
): GoogleAdsConnectionInput {
  return {
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
    ...overrides,
  };
}

let connectionRow: GoogleAdsConnection | undefined;

async function connect(
  overrides: Partial<GoogleAdsConnectionInput> = {},
): Promise<GoogleAdsConnection> {
  connectionRow = await GoogleAdsConnectionRepository.upsert({
    ...connectionInput(),
    ...overrides,
  });
  return connectionRow;
}

const SCOPE = {
  projectId: "project-1",
  organizationId: "org-a",
  customerId: "1234567890",
};

function fingerprint(
  row: { id: string; grantAccountId: string; updatedAt: string },
  overrides: Partial<{
    connectionId: string;
    grantAccountId: string;
    loginCustomerId: string | null;
    connectionUpdatedAt: string;
  }> = {},
) {
  return {
    connectionId: row.id,
    grantAccountId: row.grantAccountId,
    loginCustomerId: null,
    connectionUpdatedAt: row.updatedAt,
    ...overrides,
  };
}

function claimInput(
  overrides: Partial<{
    window: { startDate: string; endDate: string };
    mode: "scheduled" | "manual" | "backfill";
    scheduledSlot: string | null;
  }> = {},
) {
  return {
    scope: SCOPE,
    mode: "scheduled" as const,
    window: { startDate: "2026-01-01", endDate: "2026-01-31" },
    scheduledSlot: null,
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
  await database.client.execute("DELETE FROM google_ads_sync_units");
  await database.client.execute("DELETE FROM google_ads_sync_runs");
  await database.client.execute("DELETE FROM google_ads_daily_account");
  await database.client.execute("DELETE FROM google_ads_analytics_units");
  await database.client.execute("DELETE FROM google_ads_connections");
  await database.client.execute("DELETE FROM projects");
  await database.client.execute("DELETE FROM organization");
  await database.client.execute(
    "INSERT INTO organization (id) VALUES ('org-a'), ('org-b')",
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id) VALUES
       ('project-1', 'org-a'),
       ('project-2', 'org-a'),
       ('project-3', 'org-b')`,
  );
  connectionRow = undefined;
});

afterAll(() => database.client?.close());

async function runRowsById(id: string) {
  if (!database.db) throw new Error("Test database was not initialized");
  const rows = await database.db
    .select()
    .from(googleAdsSyncRuns)
    .where(eq(googleAdsSyncRuns.id, id));
  return rows[0] ?? null;
}

describe("GoogleAdsSyncRepository.claimRun", () => {
  it("creates a run with persisted fingerprint fields", async () => {
    const row = await connect();
    const result = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    expect(result.run.mode).toBe("scheduled");
    expect(result.run.windowStartDate).toBe("2026-01-01");
    expect(result.run.windowEndDate).toBe("2026-01-31");
    const stored = await runRowsById(result.run.id);
    expect(stored?.fingerprintConnectionId).toBe(row.id);
    expect(stored?.fingerprintGrantAccountId).toBe("google-sub-1");
    expect(stored?.status).toBe("running");
    expect(stored?.leaseExpiresAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stored?.leaseExpiresAt > stored.startedAt).toBe(true);
  });

  it("coalesces identical run keys AND merely overlapping windows", async () => {
    const row = await connect();
    const first = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    expect(first.outcome).toBe("created");
    if (first.outcome !== "created") return;

    const sameIdentity = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    expect(sameIdentity.outcome).toBe("coalesced");
    if (
      sameIdentity.outcome === "coalesced" ||
      sameIdentity.outcome === "resumed"
    ) {
      expect(sameIdentity.run.id).toBe(first.run.id);
    }

    // Overlapping window with a different mode/run key: still coalesced so
    // two workers never process the same account/day units concurrently.
    const overlapping = await GoogleAdsSyncRepository.claimRun({
      ...claimInput({
        mode: "backfill",
        window: { startDate: "2026-01-20", endDate: "2026-02-15" },
      }),
      fingerprint: fingerprint(row),
    });
    expect(overlapping.outcome).toBe("coalesced");
    if (
      overlapping.outcome === "coalesced" ||
      overlapping.outcome === "resumed"
    ) {
      expect(overlapping.run.id).toBe(first.run.id);
      expect(overlapping.run.windowStartDate).toBe("2026-01-01");
      expect(overlapping.run.windowEndDate).toBe("2026-01-31");
    }
  });

  it("creates a separate run for a non-overlapping window", async () => {
    const row = await connect();
    const first = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    const later = await GoogleAdsSyncRepository.claimRun({
      ...claimInput({
        window: { startDate: "2026-02-01", endDate: "2026-02-28" },
      }),
      fingerprint: fingerprint(row),
    });
    expect(later.outcome).toBe("created");
    if (first.outcome !== "created" || later.outcome !== "created") return;
    expect(later.run.id).not.toBe(first.run.id);
  });

  it("fences the overlapping run when reconnecting produces a new immutable connection id", async () => {
    const row = await connect();
    const first = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (first.outcome !== "created") return;

    // Disconnect and reconnect: new row, new id, fresh updatedAt.
    await GoogleAdsConnectionRepository.deleteByProjectId(
      SCOPE.projectId,
      SCOPE.organizationId,
    );
    const reconnected = await connect();
    const second = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(reconnected),
    });
    // A fresh fingerprint matches the current row, so the trigger proceeds…
    expect(second.outcome === "created" || second.outcome === "coalesced").toBe(
      true,
    );

    // …but a trigger still carrying the OLD fingerprint must never resurrect
    // the old claim: it fencing-marks the active run instead.
    const staleTrigger = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    expect(staleTrigger.outcome).toBe("connection_changed");
    expect(staleTrigger.run).not.toBeNull();
    expect(staleTrigger.run?.status).toBe("fenced");
    expect(staleTrigger.run?.errorClass).toBe("CONNECTION_CHANGED");
    const firstRow = await runRowsById(first.run.id);
    expect(firstRow?.status).toBe("fenced");
  });

  it("rejects a trigger with no connection row at all", async () => {
    const result = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint({
        id: "missing",
        grantAccountId: "google-sub-1",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    });
    expect(result.outcome).toBe("disconnected");
    expect(result.run).toBeNull();
  });

  it("rejects a trigger with a stale grant account id", async () => {
    const row = await connect();
    const first = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (first.outcome !== "created") return;
    // Same (overlapping) window: the stale trigger must fence the active run
    // instead of quietly starting a new one.
    const stale = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row, { grantAccountId: "google-sub-old" }),
    });
    expect(stale.outcome).toBe("connection_changed");
    expect(stale.run?.id).toBe(first.run.id);
    expect(stale.run?.status).toBe("fenced");
  });
});

describe("GoogleAdsSyncRepository lease + stale fencing", () => {
  it("resumes an expired lease and makes old attempts stale", async () => {
    const row = await connect();
    const first = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (first.outcome !== "created") return;
    const expireOneUnit = await GoogleAdsSyncRepository.planUnits(
      first.run.id,
      1,
      [{ date: "2026-01-01", grain: "account" }],
    );
    expect(expireOneUnit.outcome).toBe("planned");

    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute(
      "UPDATE google_ads_sync_runs SET lease_expires_at = '2025-01-01T00:00:00.000Z'",
    );

    const second = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    expect(second.outcome).toBe("resumed");
    if (second.outcome !== "resumed") return;
    expect(second.run.id).toBe(first.run.id);
    expect(second.run.attempt).toBe(2);

    // Stale attempt report recording is a no-op; the new attempt can report.
    const staleRecord = await GoogleAdsSyncRepository.recordUnitResult(
      first.run.id,
      1,
      { date: "2026-01-01", grain: "account" },
      { status: "success_with_data" },
    );
    expect(staleRecord.outcome).toBe("stale");
    const currentRecord = await GoogleAdsSyncRepository.recordUnitResult(
      second.run.id,
      2,
      { date: "2026-01-01", grain: "account" },
      { status: "success_with_data" },
    );
    expect(currentRecord.outcome).toBe("recorded");
    expect(
      await GoogleAdsSyncRepository.isRunClaimCurrent(first.run.id, 1),
    ).toBe(false);
    expect(
      await GoogleAdsSyncRepository.isRunClaimCurrent(second.run.id, 2),
    ).toBe(true);
    expect(
      await GoogleAdsSyncRepository.renewLease(second.run.id, 1, 900),
    ).toBe(false);
    expect(
      await GoogleAdsSyncRepository.renewLease(second.run.id, 2, 900),
    ).toBe(true);
  });
});

describe("GoogleAdsSyncRepository.planUnits", () => {
  it("is replay-safe and never resets recorded units", async () => {
    const row = await connect();
    const claim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (claim.outcome !== "created") return;

    const plannedFirst = await GoogleAdsSyncRepository.planUnits(
      claim.run.id,
      1,
      [
        { date: "2026-01-01", grain: "account" },
        { date: "2026-01-02", grain: "account" },
      ],
    );
    expect(plannedFirst.outcome).toBe("planned");
    if (plannedFirst.outcome !== "planned") return;
    expect(plannedFirst.pendingUnits).toHaveLength(2);

    const recorded = await GoogleAdsSyncRepository.recordUnitResult(
      claim.run.id,
      1,
      { date: "2026-01-01", grain: "account" },
      { status: "success_with_data" },
    );
    expect(recorded.outcome).toBe("recorded");

    const replanned = await GoogleAdsSyncRepository.planUnits(claim.run.id, 1, [
      { date: "2026-01-01", grain: "account" },
      { date: "2026-01-02", grain: "account" },
      { date: "2026-01-03", grain: "campaign" },
    ]);
    expect(replanned.outcome).toBe("planned");
    if (replanned.outcome !== "planned") return;
    // 01-01 recorded was not reset; 01-03 is newly planned.
    expect(replanned.pendingUnits).toEqual([
      { date: "2026-01-02", grain: "account" },
      { date: "2026-01-03", grain: "campaign" },
    ]);

    expect(
      await GoogleAdsSyncRepository.planUnits(claim.run.id, 99, []),
    ).toEqual({ outcome: "stale" });
  });
});

describe("GoogleAdsSyncRepository.finalizeRun", () => {
  it("derives success/partial/failed from the unit ledger", async () => {
    const row = await connect();

    const successClaim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput({
        window: { startDate: "2026-01-01", endDate: "2026-01-02" },
      }),
      fingerprint: fingerprint(row),
    });
    if (successClaim.outcome !== "created") return;
    await GoogleAdsSyncRepository.recordUnitResult(
      successClaim.run.id,
      1,
      { date: "2026-01-01", grain: "account" },
      { status: "success_with_data" },
    );
    await GoogleAdsSyncRepository.recordUnitResult(
      successClaim.run.id,
      1,
      { date: "2026-01-02", grain: "account" },
      { status: "success_zero_rows" },
    );
    const success = await GoogleAdsSyncRepository.finalizeRun(
      successClaim.run.id,
      1,
    );
    expect(success).toMatchObject({
      outcome: "finalized",
      status: "success",
      unitsSucceeded: 2,
      unitsFailed: 0,
    });

    const partialClaim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput({
        window: { startDate: "2026-02-01", endDate: "2026-02-02" },
      }),
      fingerprint: fingerprint(row),
    });
    if (partialClaim.outcome !== "created") return;
    await GoogleAdsSyncRepository.recordUnitResult(
      partialClaim.run.id,
      1,
      { date: "2026-02-01", grain: "account" },
      { status: "success_zero_rows" },
    );
    await GoogleAdsSyncRepository.recordUnitResult(
      partialClaim.run.id,
      1,
      { date: "2026-02-02", grain: "account" },
      { status: "failed", errorClass: "TRANSIENT" },
    );
    const partial = await GoogleAdsSyncRepository.finalizeRun(
      partialClaim.run.id,
      1,
    );
    expect(partial).toMatchObject({
      outcome: "finalized",
      status: "partial",
      unitsSucceeded: 1,
      unitsFailed: 1,
    });

    // Pending units count as failed; none succeeded => failed.
    const failedClaim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput({
        window: { startDate: "2026-03-01", endDate: "2026-03-02" },
      }),
      fingerprint: fingerprint(row),
    });
    if (failedClaim.outcome !== "created") return;
    await GoogleAdsSyncRepository.planUnits(failedClaim.run.id, 1, [
      { date: "2026-03-01", grain: "account" },
      { date: "2026-03-02", grain: "account" },
    ]);
    const failed = await GoogleAdsSyncRepository.finalizeRun(
      failedClaim.run.id,
      1,
    );
    expect(failed).toMatchObject({
      outcome: "finalized",
      status: "failed",
      unitsSucceeded: 0,
      unitsFailed: 2,
    });

    // After finalization the run is no longer claimable-current.
    expect(
      await GoogleAdsSyncRepository.finalizeRun(successClaim.run.id, 1),
    ).toEqual({ outcome: "stale" });
    expect(
      await GoogleAdsSyncRepository.abandonRun(
        failedClaim.run.id,
        9,
        "INTERNAL",
        null,
      ),
    ).toEqual({ outcome: "stale" });
  });

  it("abandons with a bounded error class and rejects unknown classes", async () => {
    const row = await connect();
    const claim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (claim.outcome !== "created") return;
    const abandoned = await GoogleAdsSyncRepository.abandonRun(
      claim.run.id,
      1,
      "DISCONNECTED",
      "connection removed",
    );
    expect(abandoned).toEqual({ outcome: "finalized" });
    const afterRows = await runRowsById(claim.run.id);
    expect(afterRows?.status).toBe("failed");
    expect(afterRows?.errorClass).toBe("DISCONNECTED");
    await expect(
      GoogleAdsSyncRepository.abandonRun(claim.run.id, 1, "NOT_A_CLASS", null),
    ).rejects.toThrow();
  });
});

describe("GoogleAdsSyncRepository safe reads", () => {
  it("strips fingerprints, grant ids and lease/heartbeat fields", async () => {
    const row = await connect();
    const claim = await GoogleAdsSyncRepository.claimRun({
      ...claimInput(),
      fingerprint: fingerprint(row),
    });
    if (claim.outcome !== "created") return;
    await GoogleAdsSyncRepository.recordUnitResult(
      claim.run.id,
      1,
      { date: "2026-01-15", grain: "account" },
      { status: "success_with_data" },
    );

    const history = await GoogleAdsSyncRepository.getRunHistory(SCOPE);
    expect(history).toHaveLength(1);
    for (const key of [
      "fingerprintConnectionId",
      "fingerprintGrantAccountId",
      "fingerprintLoginCustomerId",
      "fingerprintConnectionUpdatedAt",
      "leaseExpiresAt",
      "heartbeatAt",
    ]) {
      expect(Object.keys(history[0])).not.toContain(key);
    }
    const units = await GoogleAdsSyncRepository.listRunUnits(
      SCOPE,
      claim.run.id,
    );
    expect(units).toHaveLength(1);
    expect(units[0]).toMatchObject({
      date: "2026-01-15",
      grain: "account",
      status: "success_with_data",
    });
    // Scope isolation: another customer sees nothing.
    expect(
      await GoogleAdsSyncRepository.listRunUnits(
        {
          projectId: "project-2",
          organizationId: "org-a",
          customerId: "1111111111",
        },
        claim.run.id,
      ),
    ).toHaveLength(0);
  });
});
