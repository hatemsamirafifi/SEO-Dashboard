import { beforeEach, describe, expect, it, vi } from "vitest";
import { GOOGLE_ADS_SYNC_MIN_INTERVAL_MS } from "./googleAdsSyncUtils";
import { runScheduledGoogleAdsSync } from "./scheduledGoogleAdsSync";

vi.mock("cloudflare:workers", () => ({ env: {} }));

type SyncedConnection = {
  projectId: string;
  organizationId: string;
  customerId: string;
};

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => listConnections(),
    }),
  },
}));

const listConnections = vi.hoisted(() =>
  vi.fn<() => Promise<Array<SyncedConnection>>>(),
);
const getRunHistory = vi.hoisted(() => vi.fn());
const runSync = vi.hoisted(() => vi.fn());

vi.mock("./GoogleAdsSyncService", () => ({
  GoogleAdsSyncService: { runSync },
}));

vi.mock("../repositories/GoogleAdsSyncRepository", () => ({
  GoogleAdsSyncRepository: { getRunHistory },
}));

type HistoryRow = {
  status: "pending" | "running" | "success" | "partial" | "failed";
  startedAt: string;
};

type Connection = {
  projectId: string;
  organizationId: string;
  customerId: string;
};

const CONNECTED: Connection = {
  projectId: "project-1",
  organizationId: "org-1",
  customerId: "1234567890",
};

beforeEach(() => {
  listConnections.mockReset();
  getRunHistory.mockReset();
  runSync.mockReset();
  vi.restoreAllMocks();
});

describe("runScheduledGoogleAdsSync", () => {
  it("invokes the sync service in scheduled mode for eligible projects", async () => {
    listConnections.mockResolvedValue([CONNECTED]);
    getRunHistory.mockResolvedValue([]);
    runSync.mockResolvedValue({
      ok: true,
      status: "success",
      unitsSucceeded: 7,
    });

    await runScheduledGoogleAdsSync();

    expect(getRunHistory).toHaveBeenCalledWith(
      {
        projectId: "project-1",
        organizationId: "org-1",
        customerId: "1234567890",
      },
      { limit: 1 },
    );
    expect(runSync).toHaveBeenCalledWith({
      projectId: "project-1",
      organizationId: "org-1",
      mode: "scheduled",
    });
  });

  it("skips projects that already have an active run", async () => {
    listConnections.mockResolvedValue([CONNECTED]);
    getRunHistory.mockResolvedValue([
      {
        status: "pending",
        startedAt: "2020-01-01T00:00:00.000Z",
      } as HistoryRow,
    ]);

    await runScheduledGoogleAdsSync();

    expect(runSync).not.toHaveBeenCalled();
  });

  it("skips projects synced within the six hour floor", async () => {
    listConnections.mockResolvedValue([CONNECTED]);
    getRunHistory.mockResolvedValue([
      { status: "success", startedAt: new Date().toISOString() } as HistoryRow,
    ]);

    await runScheduledGoogleAdsSync();

    expect(runSync).not.toHaveBeenCalled();
  });

  it("syncs finished runs once the six hour floor has passed", async () => {
    listConnections.mockResolvedValue([CONNECTED]);
    getRunHistory.mockResolvedValue([
      {
        status: "partial",
        startedAt: new Date(
          Date.now() - GOOGLE_ADS_SYNC_MIN_INTERVAL_MS - 1,
        ).toISOString(),
      } as HistoryRow,
    ]);
    runSync.mockResolvedValue({ ok: true, status: "partial" });

    await runScheduledGoogleAdsSync();

    expect(runSync).toHaveBeenCalledTimes(1);
  });

  it("survives a runSync that ends alreadyRunning or failed", async () => {
    listConnections.mockResolvedValue([CONNECTED]);
    getRunHistory.mockResolvedValue([
      {
        status: "failed",
        startedAt: new Date(
          Date.now() - GOOGLE_ADS_SYNC_MIN_INTERVAL_MS - 1,
        ).toISOString(),
      } as HistoryRow,
    ]);
    runSync.mockResolvedValue({ ok: false, alreadyRunning: true });

    await expect(runScheduledGoogleAdsSync()).resolves.toBeUndefined();
    expect(getRunHistory).toHaveBeenCalledTimes(1);
  });

  it("keeps syncing later projects when one project throws", async () => {
    const later = {
      projectId: "project-2",
      organizationId: "org-1",
      customerId: "9876543210",
    } as Connection;
    listConnections.mockResolvedValue([CONNECTED, later]);
    getRunHistory
      .mockResolvedValueOnce([
        {
          status: "failed",
          startedAt: "2020-01-01T00:00:00.000Z",
        } as HistoryRow,
      ])
      .mockResolvedValueOnce([
        {
          status: "failed",
          startedAt: "2020-01-01T00:00:00.000Z",
        } as HistoryRow,
      ]);
    runSync.mockRejectedValueOnce(new Error("boom")).mockResolvedValueOnce({
      ok: true,
      status: "success",
      unitsSucceeded: 7,
    });

    await runScheduledGoogleAdsSync();

    expect(runSync).toHaveBeenCalledTimes(2);
    expect(runSync).toHaveBeenNthCalledWith(2, {
      projectId: "project-2",
      organizationId: "org-1",
      mode: "scheduled",
    });
  });

  it("logs and returns when listing connections fails", async () => {
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    listConnections.mockRejectedValue(new Error("db down"));

    await expect(runScheduledGoogleAdsSync()).resolves.toBeUndefined();

    expect(runSync).not.toHaveBeenCalled();
  });
});
