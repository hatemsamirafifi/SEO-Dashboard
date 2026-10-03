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
  OpportunityRepository,
  type OpportunityEventInsert,
  type OpportunityInsert,
} from "./OpportunityRepository";

function occurrence(
  overrides: Partial<OpportunityInsert> = {},
): OpportunityInsert {
  return {
    id: `occ-${Math.random().toString(36).slice(2)}`,
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey: "low_ctr_query:best shoes",
    type: "ctr",
    detectorKey: "low_ctr_query",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 60,
    confidenceScore: 70,
    priority: "High",
    title: "Low CTR",
    explanationFact: "CTR 0.4% below floor.",
    recommendation: "Rewrite the title.",
    evidenceJson: "{}",
    sourcesJson: '["gsc"]',
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const migration = readFileSync(
    resolve(process.cwd(), "drizzle/0054_mighty_mole_man.sql"),
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
  for (const table of ["opportunity_events", "opportunities", "projects"]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
});

describe("OpportunityRepository", () => {
  it("finds active rows and ignores terminal ones", async () => {
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-old", status: "completed" }),
    );
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-new", status: "open", occurrenceNumber: 2 }),
    );

    const active = await OpportunityRepository.findActiveByKey(
      "project-1",
      "low_ctr_query:best shoes",
    );
    expect(active?.id).toBe("occ-new");

    const latest = await OpportunityRepository.findLatestByKey(
      "project-1",
      "low_ctr_query:best shoes",
    );
    expect(latest?.id).toBe("occ-new");
  });

  it("ignores conflicting inserts (race-safe first step)", async () => {
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-1" }),
    );
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-2" }),
    );

    const rows = await OpportunityRepository.listActiveByProject("project-1");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.id).toBe("occ-1");
  });

  it("dedupes events by (occurrence_id, event_key)", async () => {
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-1" }),
    );
    const event: OpportunityEventInsert = {
      id: "evt-1",
      occurrenceId: "occ-1",
      type: "detected",
      eventKey: "key-1",
    };
    await OpportunityRepository.insertEventIgnoreConflict(event);
    await OpportunityRepository.insertEventIgnoreConflict({
      ...event,
      id: "evt-2",
    });

    const events = await OpportunityRepository.listEventsByOccurrence("occ-1");
    expect(events).toHaveLength(1);
    expect(events[0]?.id).toBe("evt-1");
  });

  it("scopes reads by project", async () => {
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-1" }),
    );
    expect(
      await OpportunityRepository.getByIdForProject("occ-1", "other-project"),
    ).toBeNull();
    expect(
      await OpportunityRepository.listByProject("project-1", {
        status: "open",
      }),
    ).toHaveLength(1);
    expect(
      await OpportunityRepository.listByProject("project-1", {
        status: "completed",
      }),
    ).toHaveLength(0);
  });

  describe("listByProject filters (spec 010)", () => {
    async function seedMatrix() {
      await OpportunityRepository.insertIgnoreConflict(
        occurrence({
          id: "occ-ga4",
          logicalKey: "conversion_drop:goal:goal-1",
          type: "ga4_conversion",
          detectorKey: "conversion_drop",
          status: "open",
          priority: "High",
          keyword: null,
          page: null,
          sourcesJson: '["ga4"]',
        }),
      );
      await OpportunityRepository.insertIgnoreConflict(
        occurrence({
          id: "occ-decay",
          logicalKey: "content_decay:/guide",
          type: "decay",
          detectorKey: "content_decay",
          status: "in_progress",
          priority: "Medium",
          keyword: null,
          page: "https://example.com/guide",
          sourcesJson: '["gsc","ga4"]',
        }),
      );
      await OpportunityRepository.insertIgnoreConflict(
        occurrence({
          id: "occ-ctr",
          logicalKey: "low_ctr_query:best shoes",
          type: "ctr",
          detectorKey: "low_ctr_query",
          status: "open",
          priority: "Critical",
          keyword: "best shoes",
          page: "https://example.com/shoes",
          sourcesJson: '["gsc"]',
        }),
      );
    }

    it("composes dimensions with AND across and OR within", async () => {
      await seedMatrix();
      const byIds = async (
        filters: Parameters<
          typeof OpportunityRepository.listByProject
        >[1],
      ) =>
        (
          await OpportunityRepository.listByProject("project-1", filters)
        ).map((row) => row.id);
      // Single dimensions.
      expect(await byIds({ page: "https://example.com/guide" })).toEqual([
        "occ-decay",
      ]);
      expect(await byIds({ keyword: "best shoes" })).toEqual(["occ-ctr"]);
      expect(await byIds({ source: "ga4" })).toEqual(
        expect.arrayContaining(["occ-ga4", "occ-decay"]),
      );
      expect(await byIds({ priority: "Critical" })).toEqual(["occ-ctr"]);
      // AND across dimensions.
      expect(
        await byIds({ type: "decay", status: "in_progress" }),
      ).toEqual(["occ-decay"]);
      expect(await byIds({ source: "ga4", status: "open" })).toEqual([
        "occ-ga4",
      ]);
      // OR within dimensions.
      expect(
        await byIds({ statuses: ["open", "in_progress"] }),
      ).toHaveLength(3);
      expect(await byIds({ types: ["ctr", "decay"] })).toHaveLength(2);
      expect(
        await byIds({ priorities: ["Critical", "High"] }),
      ).toHaveLength(2);
      // Empty arrays mean "all".
      expect(
        await byIds({ statuses: [], types: [], priorities: [] }),
      ).toHaveLength(3);
      // No-match combinations return empty, never error.
      expect(await byIds({ page: "https://example.com/missing" })).toEqual(
        [],
      );
      expect(
        await byIds({ source: "ga4", priority: "Critical" }),
      ).toEqual([]);
    });

    it("matches source elements exactly, never substrings", async () => {
      await seedMatrix();
      // "gs" is a substring of "gsc" but not an element: zero rows.
      expect(await OpportunityRepository.listByProject("project-1", {
        source: "gs",
      })).toHaveLength(0);
      expect(
        await OpportunityRepository.listByProject("project-1", {
          source: "backlinks",
        }),
      ).toHaveLength(0);
    });
  });
});
