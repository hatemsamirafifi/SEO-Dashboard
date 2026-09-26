import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

const mocks = vi.hoisted(() => ({
  runSync: vi.fn(),
  getLatestSyncRun: vi.fn(),
  getActiveSyncRun: vi.fn(),
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

vi.mock("@/server/features/ga4/services/Ga4SyncService", () => ({
  Ga4SyncService: { runSync: mocks.runSync },
}));

vi.mock("@/server/features/ga4/repositories/Ga4SyncRepository", () => ({
  Ga4SyncRepository: {
    getLatestSyncRun: mocks.getLatestSyncRun,
    getActiveSyncRun: mocks.getActiveSyncRun,
  },
}));

import { runScheduledGa4Sync } from "./scheduledGa4Sync";

async function setupTables() {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS ga4_connections (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, organization_id TEXT NOT NULL, property_id TEXT NOT NULL)",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS ga4_syncs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, property_id TEXT NOT NULL, status TEXT NOT NULL, started_at TEXT NOT NULL)",
  );
  await database.client.execute("DELETE FROM ga4_syncs");
  await database.client.execute("DELETE FROM ga4_connections");
}

describe("runScheduledGa4Sync", () => {
  beforeEach(async () => {
    vi.clearAllMocks();
    await setupTables();
    mocks.getLatestSyncRun.mockResolvedValue(null);
    mocks.getActiveSyncRun.mockResolvedValue(null);
    mocks.runSync.mockResolvedValue({ ok: true, status: "completed" });
  });

  it("runs an incremental sync for a connected property with no prior run", async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute({
      sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id) VALUES (?, ?, ?, ?)",
      args: ["conn-1", "p1", "o1", "42"],
    });
    await runScheduledGa4Sync();
    expect(mocks.runSync).toHaveBeenCalledWith({
      projectId: "p1",
      organizationId: "o1",
      syncType: "incremental",
    });
  });

  it("skips properties synced within the 6h floor", async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute({
      sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id) VALUES (?, ?, ?, ?)",
      args: ["conn-1", "p1", "o1", "42"],
    });
    mocks.getLatestSyncRun.mockResolvedValueOnce({
      id: "sync-recent",
      startedAt: new Date().toISOString(),
    });
    await runScheduledGa4Sync();
    expect(mocks.runSync).not.toHaveBeenCalled();
  });

  it("syncs properties whose latest run is older than the floor", async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute({
      sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id) VALUES (?, ?, ?, ?)",
      args: ["conn-1", "p1", "o1", "42"],
    });
    mocks.getLatestSyncRun.mockResolvedValueOnce({
      id: "sync-old",
      startedAt: new Date(Date.now() - 7 * 60 * 60 * 1000).toISOString(),
    });
    await runScheduledGa4Sync();
    expect(mocks.runSync).toHaveBeenCalledTimes(1);
  });

  it("skips properties with an active run and isolates per-connection failures", async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute({
      sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id) VALUES (?, ?, ?, ?)",
      args: ["conn-1", "p1", "o1", "42"],
    });
    await database.client.execute({
      sql: "INSERT INTO ga4_connections (id, project_id, organization_id, property_id) VALUES (?, ?, ?, ?)",
      args: ["conn-2", "p2", "o1", "84"],
    });
    mocks.getActiveSyncRun.mockResolvedValueOnce({ id: "active-1" });
    mocks.runSync.mockRejectedValueOnce(new Error("boom"));
    await runScheduledGa4Sync();
    // conn-1 skipped (active), conn-2 attempted and failed in isolation.
    expect(mocks.runSync).toHaveBeenCalledTimes(1);
    expect(mocks.runSync).toHaveBeenCalledWith({
      projectId: "p2",
      organizationId: "o1",
      syncType: "incremental",
    });
  });
});
