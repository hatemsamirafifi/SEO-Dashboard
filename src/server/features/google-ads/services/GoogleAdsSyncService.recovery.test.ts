import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { googleAdsSyncRuns, googleAdsSyncUnits } from "@/db/schema";
import { GoogleAdsApiError } from "@/server/lib/googleAdsClient";
import { runSync } from "./GoogleAdsSyncService";
import {
  DATE,
  CUSTOMER_ID,
  GRAINS,
  ORGANIZATION_ID,
  PROJECT_ID,
  TestAdsClient,
  closeTestDatabase,
  createSyncTables,
  resetSyncTables,
  stubRows,
  testDatabase,
} from "./GoogleAdsSyncService.testSupport";
import { GoogleAdsConnectionRepository } from "../repositories/GoogleAdsConnectionRepository";

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", async () => {
  const support = await import("./GoogleAdsSyncService.testSupport");
  return { db: (await support.createTestDatabaseModule()).db };
});

vi.mock("@/db/runBatch", async () => {
  const support = await import("./GoogleAdsSyncService.testSupport");
  return {
    runBatch: support.runBatchStatements,
    executeInBatches: support.executeInBatches,
  };
});

beforeAll(createSyncTables);

let connectionRow: {
  id: string;
  updatedAt: string;
  grantAccountId: string;
  loginCustomerId: string | null;
};

beforeEach(async () => {
  await resetSyncTables();
  connectionRow = await GoogleAdsConnectionRepository.upsert({
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    customerId: CUSTOMER_ID,
    loginCustomerId: null,
    customerDisplayName: "Example Customer",
    grantAccountId: "google-sub-1",
    connectedByUserId: "user-1",
    currencyCode: "USD",
    timeZone: "Europe/Lisbon",
    isTestAccount: false,
  });
});

afterAll(() => closeTestDatabase());

function runOptions(
  overrides: Partial<Parameters<typeof runSync>[0]> = {},
): Parameters<typeof runSync>[0] {
  return {
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    today: new Date(`${DATE}T12:00:00.000Z`),
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

/** Inserts a durable run directly (used to steer claim outcomes). */
async function insertRun(input: {
  id: string;
  status: string;
  leaseExpiresInMs: number;
  windowStartDate: string;
  windowEndDate: string;
  attempt?: number;
}): Promise<void> {
  if (!testDatabase.db) throw new Error("Test database was not initialized");
  const db = testDatabase.db;
  const now = new Date();
  await db.insert(googleAdsSyncRuns).values({
    id: input.id,
    projectId: PROJECT_ID,
    organizationId: ORGANIZATION_ID,
    customerId: CUSTOMER_ID,
    runKey: `run-key-${input.id}`,
    mode: "manual",
    windowStartDate: input.windowStartDate,
    windowEndDate: input.windowEndDate,
    scheduledSlot: null,
    fingerprintConnectionId: connectionRow.id,
    fingerprintGrantAccountId: connectionRow.grantAccountId,
    fingerprintLoginCustomerId: connectionRow.loginCustomerId,
    fingerprintConnectionUpdatedAt: connectionRow.updatedAt,
    attempt: input.attempt ?? 1,
    status: input.status,
    leaseExpiresAt: new Date(
      now.getTime() + input.leaseExpiresInMs,
    ).toISOString(),
    startedAt: now.toISOString(),
  });
}

async function insertUnitCommitted(
  runId: string,
  date: string,
  status: "success_with_data" | "success_zero_rows",
): Promise<void> {
  if (!testDatabase.db) throw new Error("Test database was not initialized");
  const db = testDatabase.db;
  for (const grain of GRAINS) {
    await db.insert(googleAdsSyncUnits).values({
      id: `${runId}-${date}-${grain}`,
      projectId: PROJECT_ID,
      organizationId: ORGANIZATION_ID,
      runId,
      customerId: CUSTOMER_ID,
      date,
      grain,
      status,
    });
  }
}

describe("GoogleAdsSyncService.runSync (recovery, truncation and fences)", () => {
  it("retries transient failures with the bounded budget and then succeeds", async () => {
    const client = new TestAdsClient();
    for (const grain of GRAINS) {
      client.behavior(grain, { rows: stubRows(grain, DATE) });
    }
    client.failFirst(
      "campaign",
      2,
      new GoogleAdsApiError(503, "upstream unavailable"),
    );
    const result = await runSync(
      runOptions({
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    expect(result.status).toBe("success");
    expect(result.unitsFailed).toBe(0);
    expect(
      client.fetchCalls.filter((call) => call.grain === "campaign"),
    ).toHaveLength(3);
  });

  it("records truncated reads as partial units and a partial run", async () => {
    const client = new TestAdsClient();
    for (const grain of GRAINS) {
      client.behavior(grain, { rows: stubRows(grain, DATE) });
    }
    client.behavior("device", {
      rows: stubRows("device", DATE),
      truncated: true,
    });
    const result = await runSync(
      runOptions({
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    expect(result).toMatchObject({
      ok: true,
      status: "partial",
      unitsSucceeded: 6,
      unitsFailed: 1,
    });
    expect(result.errorClass).toBe("malformed_response");
    expect(client.fetchCalls).toHaveLength(7);
  });

  it("verifies the fence: a resumed claim replays committed units without re-fetch", async () => {
    // A stale attempt lost its lease with all units already committed.
    await insertRun({
      id: "run-expired",
      status: "running",
      leaseExpiresInMs: -600_000,
      windowStartDate: DATE,
      windowEndDate: DATE,
      attempt: 1,
    });
    await insertUnitCommitted("run-expired", DATE, "success_with_data");

    const client = new TestAdsClient();
    for (const grain of GRAINS) {
      client.behavior(grain, { rows: stubRows(grain, DATE) });
    }
    const result = await runSync(
      runOptions({
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    // The claim resumed (attempt bumped) and the committed units replay-free;
    // only the fresh pending units of the same identity get planned.
    expect(result.alreadyRunning).toBe(false);
    expect(client.fetchCalls).toHaveLength(0);
    expect(result.unitsPlanned).toBe(0);
    expect(result.status).toBe("success");
  });

  it("coalesces an overlapping live run instead of duplicating paid fetches", async () => {
    await insertRun({
      id: "run-live",
      status: "running",
      leaseExpiresInMs: 600_000,
      windowStartDate: DATE,
      windowEndDate: DATE,
      attempt: 1,
    });
    const client = new TestAdsClient();
    const result = await runSync(
      runOptions({
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      alreadyRunning: true,
      status: "running",
      errorClass: null,
      message: "A Google Ads run is already active for this account.",
    });
    expect(client.fetchCalls).toHaveLength(0);
  });
});
