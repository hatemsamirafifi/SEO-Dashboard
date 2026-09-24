import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

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

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
  captureServerError: vi.fn(),
}));

import {
  OpportunityRepository,
  type OpportunityInsert,
} from "../repositories/OpportunityRepository";
import {
  InvalidStatusTransitionError,
  OpportunityService,
} from "./OpportunityService";

function occurrence(
  overrides: Partial<OpportunityInsert> = {},
): OpportunityInsert {
  return {
    id: `occ-${Math.random().toString(36).slice(2)}`,
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey: "low_ctr_query:q",
    type: "ctr",
    detectorKey: "low_ctr_query",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 60,
    confidenceScore: 70,
    priority: "High",
    title: "t",
    explanationFact: "f",
    recommendation: "r",
    evidenceJson: "{}",
    sourcesJson: "[]",
    firstDetectedAt: "2026-01-01T00:00:00.000Z",
    lastDetectedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

async function seed(row: OpportunityInsert): Promise<string> {
  await OpportunityRepository.insertIgnoreConflict(row);
  const found = await OpportunityRepository.findLatestByKey(
    row.projectId,
    row.logicalKey,
  );
  if (!found) throw new Error("seed failed");
  return found.id;
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

describe("OpportunityService.listOpportunities", () => {
  it("sorts canonically and filters", async () => {
    await seed(
      occurrence({ id: "occ-medium", logicalKey: "k:1", priority: "Medium" }),
    );
    await seed(
      occurrence({
        id: "occ-critical",
        logicalKey: "k:2",
        priority: "Critical",
        lastDetectedAt: "2026-01-03T00:00:00.000Z",
      }),
    );
    await seed(
      occurrence({
        id: "occ-done",
        logicalKey: "k:3",
        priority: "Critical",
        status: "completed",
        lastDetectedAt: "2026-01-02T00:00:00.000Z",
      }),
    );

    const all = await OpportunityService.listOpportunities({
      projectId: "project-1",
    });
    expect(all.map((r) => r.id)).toEqual([
      "occ-critical",
      "occ-done",
      "occ-medium",
    ]);
    const open = await OpportunityService.listOpportunities({
      projectId: "project-1",
      status: "open",
    });
    expect(open).toHaveLength(2);
  });
});

describe("OpportunityService.getOpportunity", () => {
  it("returns the row with its events, null across projects", async () => {
    const id = await seed(occurrence({ id: "occ-1" }));
    const found = await OpportunityService.getOpportunity({
      id,
      projectId: "project-1",
    });
    expect(found?.opportunity.id).toBe(id);
    expect(found?.events).toEqual([]);
    expect(
      await OpportunityService.getOpportunity({
        id,
        projectId: "other-project",
      }),
    ).toBeNull();
  });
});

describe("OpportunityService.updateOpportunityStatus", () => {
  it("advances open → in_progress with a status_changed event", async () => {
    const id = await seed(occurrence({ id: "occ-1" }));
    const updated = await OpportunityService.updateOpportunityStatus({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      userId: "user-1",
      status: "in_progress",
    });
    expect(updated.status).toBe("in_progress");
    const events = await OpportunityRepository.listEventsByOccurrence(id);
    expect(events.map((e) => e.type)).toEqual(["status_changed"]);
  });

  it("completes with completedAt and a completed event", async () => {
    const id = await seed(occurrence({ id: "occ-1" }));
    const updated = await OpportunityService.updateOpportunityStatus({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      status: "completed",
    });
    expect(updated.status).toBe("completed");
    expect(updated.completedAt).not.toBeNull();
    const events = await OpportunityRepository.listEventsByOccurrence(id);
    expect(events.map((e) => e.type)).toEqual(["completed"]);
  });

  it("requires a reason for dismissal", async () => {
    const id = await seed(occurrence({ id: "occ-1" }));
    await expect(
      OpportunityService.updateOpportunityStatus({
        id,
        projectId: "project-1",
        organizationId: "org-1",
        status: "dismissed",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const updated = await OpportunityService.updateOpportunityStatus({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      status: "dismissed",
      reason: "Not relevant this quarter.",
    });
    expect(updated.dismissalReason).toBe("Not relevant this quarter.");
  });

  it("refuses terminal transitions and no-ops same-status writes", async () => {
    const id = await seed(occurrence({ id: "occ-1", status: "completed" }));
    await expect(
      OpportunityService.updateOpportunityStatus({
        id,
        projectId: "project-1",
        organizationId: "org-1",
        status: "open",
      }),
    ).rejects.toBeInstanceOf(InvalidStatusTransitionError);

    const same = await OpportunityService.updateOpportunityStatus({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      status: "completed",
    });
    expect(same.status).toBe("completed");
    expect(await OpportunityRepository.listEventsByOccurrence(id)).toEqual([]);
  });

  it("throws NOT_FOUND across projects", async () => {
    const id = await seed(occurrence({ id: "occ-1" }));
    await expect(
      OpportunityService.updateOpportunityStatus({
        id,
        projectId: "other-project",
        organizationId: "org-1",
        status: "completed",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
