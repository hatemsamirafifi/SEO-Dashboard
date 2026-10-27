/* eslint-disable max-lines -- spec 021 added the triage, filter, and
   next-actions suites to an already-full service contract file. */
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
import { getNextActions } from "./nextActions";

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
  for (const migrationFile of [
    "drizzle/0054_mighty_mole_man.sql",
    // Spec 021: assignee/effort triage columns.
    "drizzle/0072_next_actions_triage.sql",
  ]) {
    const migration = readFileSync(
      resolve(process.cwd(), migrationFile),
      "utf8",
    );
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
      await database.client.execute(statement);
    }
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

describe("OpportunityService impact breakdown", () => {
  it("recomputes the stored score from factors plus weights", async () => {
    // (30×0.6 + 20×0.8) / 50 = 0.68 → 68
    const id = await seed(
      occurrence({
        id: "occ-why",
        impactScore: 68,
        impactFactorsJson: JSON.stringify({
          trafficPotential: 0.6,
          proximity: null,
          decline: 0.8,
          businessIntent: null,
          conversionSignal: null,
        }),
        confidenceInputsJson: JSON.stringify({ coverage: 1 }),
      }),
    );
    const found = await OpportunityService.getOpportunity({
      id,
      projectId: "project-1",
    });
    expect(found?.opportunity.impactBreakdown?.score).toBe(68);
    expect(found?.opportunity.impactBreakdown?.divisor).toBe(50);
    expect(found?.opportunity.impactBreakdown?.rows).toHaveLength(5);
    expect(found?.opportunity.confidenceInputs).toMatchObject({
      coverage: 1,
    });
  });

  it("returns a null breakdown for missing factors", async () => {
    const id = await seed(occurrence({ id: "occ-nofactors" }));
    const found = await OpportunityService.getOpportunity({
      id,
      projectId: "project-1",
    });
    expect(found?.opportunity.impactBreakdown).toBeNull();
    expect(found?.opportunity.confidenceInputs).toBeNull();
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

describe("OpportunityService.listOpportunities recency + reopened (spec 021)", () => {
  it("narrows by the recent-day window on lastDetectedAt", async () => {
    const nowIso = new Date().toISOString();
    await seed(
      occurrence({
        id: "occ-fresh",
        logicalKey: "k:fresh",
        firstDetectedAt: nowIso,
        lastDetectedAt: nowIso,
      }),
    );
    await seed(
      occurrence({
        id: "occ-old",
        logicalKey: "k:old",
        firstDetectedAt: "2026-01-01T00:00:00.000Z",
        lastDetectedAt: "2026-01-01T00:00:00.000Z",
      }),
    );

    const recent = await OpportunityService.listOpportunities({
      projectId: "project-1",
      recentDays: 7,
    });
    expect(recent.map((row) => row.id)).toEqual(["occ-fresh"]);

    // A window that spans both rows keeps the long-lived one visible.
    const wide = await OpportunityService.listOpportunities({
      projectId: "project-1",
      recentDays: 365,
    });
    expect(wide.map((row) => row.id)).toHaveLength(2);
  });

  it("narrows reopened to the stored recurrence chain", async () => {
    await seed(occurrence({ id: "occ-plain", logicalKey: "k:plain" }));
    await seed(
      occurrence({
        id: "occ-back",
        logicalKey: "k:back",
        recurrenceOfId: "occ-plain",
      }),
    );

    const reopened = await OpportunityService.listOpportunities({
      projectId: "project-1",
      reopened: true,
    });
    expect(reopened.map((row) => row.id)).toEqual(["occ-back"]);
  });
});

describe("OpportunityService.updateOpportunityTriage (spec 021)", () => {
  it("sets assignee and effort with one idempotent triage event", async () => {
    const id = await seed(occurrence({ logicalKey: "k:triage-1" }));

    const first = await OpportunityService.updateOpportunityTriage({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      assignee: "alice",
      effort: "medium",
    });
    expect(first.assignee).toBe("alice");
    expect(first.effort).toBe("medium");
    expect(first.status).toBe("open");

    // Replaying the same values is a no-op: no second event.
    await OpportunityService.updateOpportunityTriage({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      assignee: "alice",
      effort: "medium",
    });
    let events = await OpportunityRepository.listEventsByOccurrence(id);
    const triageEvents = events.filter((e) => e.type === "triage_changed");
    expect(triageEvents).toHaveLength(1);

    // A changed value appends exactly one more event.
    await OpportunityService.updateOpportunityTriage({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      effort: "large",
    });
    events = await OpportunityRepository.listEventsByOccurrence(id);
    const after = events.filter((e) => e.type === "triage_changed");
    expect(after).toHaveLength(2);
    const payload: unknown = JSON.parse(after[1]?.payloadJson ?? "{}");
    expect(payload).toMatchObject({
      to: { assignee: "alice", effort: "large" },
    });
  });

  it("clears fields with null and never resurrects a terminal row", async () => {
    const id = await seed(
      occurrence({
        logicalKey: "k:triage-2",
        status: "completed",
        assignee: "bob",
        effort: "small",
      }),
    );

    const cleared = await OpportunityService.updateOpportunityTriage({
      id,
      projectId: "project-1",
      organizationId: "org-1",
      assignee: null,
      effort: null,
    });
    expect(cleared.assignee).toBeNull();
    expect(cleared.effort).toBeNull();
    // Triage never moves the lifecycle.
    expect(cleared.status).toBe("completed");
  });

  it("throws NOT_FOUND across projects", async () => {
    const id = await seed(occurrence({ logicalKey: "k:triage-3" }));
    await expect(
      OpportunityService.updateOpportunityTriage({
        id,
        projectId: "other-project",
        organizationId: "org-1",
        assignee: "alice",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getNextActions (spec 021)", () => {
  it("derives the four views with honest counts and deterministic order", async () => {
    const now = Date.parse("2026-10-26T00:00:00.000Z");
    await seed(
      occurrence({
        id: "occ-top",
        logicalKey: "k:top",
        priority: "Critical",
        impactScore: 90,
        firstDetectedAt: "2026-10-25T00:00:00.000Z",
        lastDetectedAt: "2026-10-25T00:00:00.000Z",
      }),
    );
    await seed(
      occurrence({
        id: "occ-low",
        logicalKey: "k:low",
        priority: "Medium",
        impactScore: 40,
        firstDetectedAt: "2026-01-01T00:00:00.000Z",
        lastDetectedAt: "2026-01-01T00:00:00.000Z",
      }),
    );
    await seed(
      occurrence({
        id: "occ-done",
        logicalKey: "k:done",
        status: "completed",
        priority: "High",
        impactScore: 60,
        firstDetectedAt: "2026-10-20T00:00:00.000Z",
        lastDetectedAt: "2026-10-24T00:00:00.000Z",
        completedAt: "2026-10-24T00:00:00.000Z",
      }),
    );
    await seed(
      occurrence({
        id: "occ-back",
        logicalKey: "k:back",
        priority: "Low",
        impactScore: 30,
        recurrenceOfId: "occ-closed",
        firstDetectedAt: "2026-10-22T00:00:00.000Z",
        lastDetectedAt: "2026-10-23T00:00:00.000Z",
      }),
    );

    const snapshot = await getNextActions({
      projectId: "project-1",
      now,
    });

    // Critical: open rows in the shared canonical order (Critical first).
    expect(snapshot.critical.map((row) => row.id)).toEqual([
      "occ-top",
      "occ-low",
      "occ-back",
    ]);
    // Recent: rows first detected inside the window, newest first.
    expect(snapshot.recent.map((row) => row.id)).toEqual([
      "occ-top",
      "occ-back",
      "occ-done",
    ]);
    // Completed: most recently completed first.
    expect(snapshot.completed.map((row) => row.id)).toEqual(["occ-done"]);
    // Reopened: only the stored recurrence chain.
    expect(snapshot.reopened.map((row) => row.id)).toEqual(["occ-back"]);

    expect(snapshot.counts).toEqual({
      critical: 3,
      recent: 3,
      completed: 1,
      reopened: 1,
    });
    expect(snapshot.recentSince).toBe(
      new Date(now - 7 * 86_400_000).toISOString(),
    );
  });

  it("caps each view at the limit while counts stay pre-cap", async () => {
    for (const [index, impact] of [80, 60, 40].entries()) {
      await seed(
        occurrence({
          id: `occ-rank-${index}`,
          logicalKey: `k:rank-${index}`,
          impactScore: impact,
          firstDetectedAt: "2026-10-10T00:00:00.000Z",
          lastDetectedAt: "2026-10-10T00:00:00.000Z",
        }),
      );
    }

    const snapshot = await getNextActions({
      projectId: "project-1",
      limit: 2,
    });
    expect(snapshot.critical).toHaveLength(2);
    expect(snapshot.counts.critical).toBe(3);
  });
});
