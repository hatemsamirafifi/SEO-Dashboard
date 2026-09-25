import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
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

import {
  InsightRepository,
  type InsightInsert,
} from "./InsightRepository";

function insightRow(overrides: Partial<InsightInsert> = {}): InsightInsert {
  return {
    id: `ins-${Math.random().toString(36).slice(2)}`,
    projectId: "project-1",
    organizationId: "org-1",
    insightKey: "dashboard:ranking_drop",
    type: "ranking_drop",
    detectorKey: "ranking_drop",
    severity: "high",
    title: "t",
    explanationFact: "f",
    evidenceSummary: "e",
    scanId: "run-1",
    detectedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    contentVersion: 1,
    contentHash: "h",
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0055_certain_infant_terrible.sql"),
    "utf8",
  );
  for (const statement of migration
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean)) {
    await database.client.execute(statement);
  }
  await database.client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL
     )`,
  );
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of [
    "insight_user_preferences",
    "dashboard_insights",
    "projects",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
});

describe("InsightRepository", () => {
  it("upserts rows by key and lists unresolved only", async () => {
    await InsightRepository.insertRow(insightRow({ id: "ins-1" }));
    await InsightRepository.insertRow(
      insightRow({
        id: "ins-2",
        insightKey: "dashboard:low_ctr_query",
        type: "low_ctr_query",
        detectorKey: "low_ctr_query",
        resolvedAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    expect(
      (await InsightRepository.findByKey(
        "project-1",
        "dashboard:ranking_drop",
      ))?.id,
    ).toBe("ins-1");
    expect(
      await InsightRepository.findByKey("project-1", "dashboard:nope"),
    ).toBeNull();
    const unresolved =
      await InsightRepository.listUnresolvedByProject("project-1");
    expect(unresolved.map((r) => r.id)).toEqual(["ins-1"]);

    const updated = await InsightRepository.updateById("ins-1", {
      contentVersion: 2,
    });
    expect(updated?.contentVersion).toBe(2);
    expect(
      await InsightRepository.updateById("ins-missing", { contentVersion: 2 }),
    ).toBeNull();
  });

  it("upserts preferences by compound key", async () => {
    await InsightRepository.upsertPreference({
      userId: "user-1",
      projectId: "project-1",
      insightKey: "dashboard:ranking_drop",
      dismissedContentVersion: 1,
      snoozedUntil: null,
      hash: "h1",
    });
    await InsightRepository.upsertPreference({
      userId: "user-1",
      projectId: "project-1",
      insightKey: "dashboard:ranking_drop",
      dismissedContentVersion: 2,
      snoozedUntil: null,
      hash: "h2",
    });
    const pref = await InsightRepository.getPreference(
      "user-1",
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(pref?.dismissedContentVersion).toBe(2);
    expect(
      await InsightRepository.listPreferencesByProject("user-1", "project-1"),
    ).toHaveLength(1);
  });

  it("counts runs since a timestamp", async () => {
    await database.client?.execute(
      `CREATE TABLE IF NOT EXISTS intelligence_runs (id TEXT PRIMARY KEY NOT NULL, project_id TEXT NOT NULL, started_at TEXT NOT NULL)`,
    );
    await database.client?.execute(
      `INSERT INTO intelligence_runs (id, project_id, started_at) VALUES
       ('run-old', 'project-1', '2026-01-01T00:00:00.000Z'),
       ('run-new', 'project-1', '2026-01-03T00:00:00.000Z')`,
    );
    expect(
      await InsightRepository.countRunsSince(
        "project-1",
        "2026-01-02T00:00:00.000Z",
      ),
    ).toBe(1);
  });
});
