import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { GoogleAdsTokenError } from "@/server/lib/googleAdsClient";
import { runSync } from "./GoogleAdsSyncService";
import {
  DATE,
  SCOPE,
  TestAdsClient,
  closeTestDatabase,
  createSyncTables,
  resetSyncTables,
  stubRows,
  GRAINS,
} from "./GoogleAdsSyncService.testSupport";
import { GoogleAdsConnectionRepository } from "../repositories/GoogleAdsConnectionRepository";
import { GoogleAdsSyncRepository } from "../repositories/GoogleAdsSyncRepository";

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

beforeEach(async () => {
  await resetSyncTables();
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
});

afterAll(closeTestDatabase);

function runOptions(
  overrides: Partial<Parameters<typeof runSync>[0]> = {},
): Parameters<typeof runSync>[0] {
  return {
    projectId: "project-1",
    organizationId: "org-a",
    today: new Date(`${DATE}T12:00:00.000Z`),
    retryBaseDelayMs: 1,
    ...overrides,
  };
}

describe("GoogleAdsSyncService.runSync", () => {
  it("returns the clean disconnected envelope without touching Google", async () => {
    await GoogleAdsConnectionRepository.deleteByProjectId("project-1", "org-a");
    const result = await runSync(runOptions());
    expect(result).toMatchObject({
      ok: false,
      connected: false,
      mode: null,
      window: null,
      run: null,
      status: "none",
      errorClass: "DISCONNECTED",
    });
  });

  it("rejects one-sided windows and scheduled explicit windows without claiming", async () => {
    const client = new TestAdsClient();
    const oneSided = await runSync(
      runOptions({ startDate: DATE, createClient: () => client.asClient() }),
    );
    expect(oneSided).toMatchObject({
      ok: false,
      status: "failed",
      errorClass: "INVALID_WINDOW",
      run: null,
    });
    expect(client.fetchCalls).toHaveLength(0);

    const invalid = await runSync(
      runOptions({
        startDate: "2026-02-30",
        endDate: "2026-03-01",
        createClient: () => client.asClient(),
      }),
    );
    expect(invalid).toMatchObject({ errorClass: "INVALID_WINDOW" });
    expect(client.fetchCalls).toHaveLength(0);

    const scheduled = await runSync(
      runOptions({
        mode: "scheduled",
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    expect(scheduled).toMatchObject({ errorClass: "INVALID_WINDOW" });
    expect(client.fetchCalls).toHaveLength(0);

    const backfill = await runSync(runOptions({ mode: "backfill" }));
    expect(backfill).toMatchObject({ errorClass: "INVALID_WINDOW" });
  });

  it("runs a full manual window to success and finalizes the durable ledger", async () => {
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
    expect(result).toMatchObject({
      ok: true,
      connected: true,
      mode: "manual",
      status: "success",
      unitsPlanned: 7,
      unitsSucceeded: 7,
      unitsFailed: 0,
      errorClass: null,
      message: null,
    });
    expect(result.window).toEqual({
      startDate: DATE,
      endDate: DATE,
      syncType: "manual",
    });
    expect(client.fetchCalls).toHaveLength(7);
    // The run is a public shape: no grant/fingerprint fields leak.
    expect(Object.keys(result.run ?? {})).not.toContain(
      "fingerprintGrantAccountId",
    );
    const history = await GoogleAdsSyncRepository.getRunHistory(SCOPE, {
      limit: 5,
    });
    expect(history[0]).toMatchObject({
      mode: "manual",
      status: "success",
      unitsTotal: 7,
      unitsSucceeded: 7,
      unitsFailed: 0,
      errorClass: null,
    });
  });

  it("records a fatal auth failure as an abandoned run and leaves the rest pending", async () => {
    const client = new TestAdsClient();
    // account is the first planned grain: its fatal failure halts the run.
    client.behavior("account", {
      throw: new GoogleAdsTokenError("refresh failed"),
    });
    const result = await runSync(
      runOptions({
        startDate: DATE,
        endDate: DATE,
        createClient: () => client.asClient(),
      }),
    );
    expect(result).toMatchObject({
      ok: false,
      status: "failed",
      errorClass: "oauth_reconnect_required",
    });
    // Only the account unit was attempted; no other grain was fetched.
    expect(client.fetchCalls).toHaveLength(1);
    expect(client.fetchCalls[0]?.grain).toBe("account");
    const history = await GoogleAdsSyncRepository.getRunHistory(SCOPE, {
      limit: 5,
    });
    expect(history[0]).toMatchObject({ status: "failed", errorClass: "AUTH" });
  });
});
