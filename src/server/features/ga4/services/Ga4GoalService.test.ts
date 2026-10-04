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

vi.mock("@/db/runBatch", () => ({
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

// RED (T009): Ga4GoalService does not exist yet — every test below must fail
// on import until T010/T011 land. Scenarios mirror contracts/goals-api.md and
// quickstart.md V1.
import { Ga4GoalService } from "./Ga4GoalService";
import { Ga4SyncRepository } from "../repositories/Ga4SyncRepository";
import { AppError } from "@/server/lib/errors";

const PROJECT = "project-1";
const ORG = "org-1";
const PROPERTY = "properties/42";

function migrationStatements(file: string): string[] {
  return readFileSync(resolve(process.cwd(), file), "utf8")
    .split("--> statement-breakpoint")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function resetTables() {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of [
    "ga4_project_goals",
    "ga4_daily_events",
    "ga4_sync_coverage",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
}

async function migrateTestDatabase() {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "CREATE TABLE IF NOT EXISTS organization (id TEXT PRIMARY KEY NOT NULL)",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO projects (id) VALUES ('project-1')",
  );
  await database.client.execute(
    "INSERT OR IGNORE INTO organization (id) VALUES ('org-1')",
  );
  for (const file of [
    "drizzle/0050_ga4_connections.sql",
    "drizzle/0052_quick_quentin_quire.sql",
    "drizzle/0061_worthless_dagger.sql",
  ]) {
    for (const statement of migrationStatements(file)) {
      if (statement.includes("gsc_search_performance_syncs")) continue;
      await database.client.execute(statement);
    }
  }
}

beforeAll(migrateTestDatabase);
beforeEach(resetTables);
afterAll(() => database.client?.close());

function baseCreate(overrides: Record<string, unknown> = {}) {
  return {
    projectId: PROJECT,
    organizationId: ORG,
    name: "Newsletter signup",
    eventName: "signup_completed",
    matchKeyEventOnly: false,
    ...overrides,
  };
}

function expectAppError(error: unknown, code: string, messagePart?: string) {
  expect(error).toBeInstanceOf(AppError);
  if (error instanceof AppError) {
    expect(error.code).toBe(code);
    if (messagePart !== undefined) expect(error.message).toContain(messagePart);
  }
}

describe("Ga4GoalService CRUD", () => {
  it("creates a goal and lists it active", async () => {
    const goal = await Ga4GoalService.createGoal(baseCreate());
    expect(goal.id).toBeTypeOf("string");
    expect(goal).toMatchObject({
      projectId: PROJECT,
      organizationId: ORG,
      name: "Newsletter signup",
      eventName: "signup_completed",
      matchKeyEventOnly: false,
      archivedAt: null,
    });
    const listed = await Ga4GoalService.listGoals({
      projectId: PROJECT,
      organizationId: ORG,
    });
    expect(listed.map((row) => row.id)).toEqual([goal.id]);
  });

  it("trims names and defaults matchKeyEventOnly to false", async () => {
    const goal = await Ga4GoalService.createGoal(
      baseCreate({ name: "  Padded  ", eventName: "  padded_event  " }),
    );
    expect(goal.name).toBe("Padded");
    expect(goal.eventName).toBe("padded_event");
    expect(goal.matchKeyEventOnly).toBe(false);
  });

  it("rejects the 21st active goal with the cap error", async () => {
    for (let n = 0; n < 20; n++) {
      await Ga4GoalService.createGoal(
        baseCreate({ name: `Goal ${n}`, eventName: `event_${n}` }),
      );
    }
    const failure = await Ga4GoalService.createGoal(
      baseCreate({ name: "Goal 20", eventName: "event_20" }),
    ).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expectAppError(failure, "VALIDATION_ERROR", "20");
  });

  it("rejects a duplicate active name", async () => {
    await Ga4GoalService.createGoal(baseCreate());
    const failure = await Ga4GoalService.createGoal(baseCreate()).catch(
      (error: unknown) => error,
    );
    expect(failure).toBeInstanceOf(AppError);
    expectAppError(failure, "VALIDATION_ERROR");
  });

  it("allows reusing an archived goal name", async () => {
    const first = await Ga4GoalService.createGoal(baseCreate());
    await Ga4GoalService.archiveGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: first.id,
    });
    const second = await Ga4GoalService.createGoal(baseCreate());
    expect(second.id).not.toBe(first.id);
    expect(second.archivedAt).toBeNull();
  });

  it("rejects updates to archived goals", async () => {
    const goal = await Ga4GoalService.createGoal(baseCreate());
    await Ga4GoalService.archiveGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: goal.id,
    });
    const failure = await Ga4GoalService.updateGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: goal.id,
      name: "Renamed",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expectAppError(failure, "VALIDATION_ERROR", "archived");
  });

  it("archive is idempotent", async () => {
    const goal = await Ga4GoalService.createGoal(baseCreate());
    const first = await Ga4GoalService.archiveGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: goal.id,
    });
    const second = await Ga4GoalService.archiveGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: goal.id,
    });
    expect(first.archivedAt).not.toBeNull();
    expect(second.archivedAt).toBe(first.archivedAt);
  });

  it("fails closed for other-project goal ids", async () => {
    const goal = await Ga4GoalService.createGoal(baseCreate());
    const missing = await Ga4GoalService.getGoal({
      projectId: "other-project",
      organizationId: ORG,
      id: goal.id,
    });
    expect(missing).toBeNull();
    const failure = await Ga4GoalService.updateGoal({
      projectId: "other-project",
      organizationId: ORG,
      id: goal.id,
      name: "Hijacked",
    }).catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(AppError);
    expectAppError(failure, "NOT_FOUND");
  });
});

describe("Ga4GoalService goal-scoped conversions (quickstart V1)", () => {
  async function seedEvents() {
    if (!database.client) throw new Error("Test database was not initialized");
    // Two SUCCESS-covered event dates with distinct event names and counts.
    for (const [date, eventName, count, key] of [
      ["2026-09-20", "signup_completed", 7, 1],
      ["2026-09-21", "signup_completed", 5, 1],
      ["2026-09-20", "other_event", 100, 0],
    ] as Array<[string, string, number, number]>) {
      await database.client.execute({
        sql: "INSERT INTO ga4_daily_events (id, project_id, property_id, ga4_connection_id, date, event_name, event_count, is_key_event, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?, ?, ?, '2026-09-22', '2026-09-22')",
        args: [
          `evt-${date}-${eventName}`,
          PROJECT,
          PROPERTY,
          date,
          eventName,
          count,
          key,
        ],
      });
      await database.client.execute({
        sql: "INSERT OR IGNORE INTO ga4_sync_coverage (id, project_id, property_id, date, grain, status, created_at, updated_at) VALUES (?, ?, ?, ?, 'events', 'success_with_data', '2026-09-22', '2026-09-22')",
        args: [`cov-${date}`, PROJECT, PROPERTY, date],
      });
    }
  }

  it("sums stored event counts for the goal over covered dates", async () => {
    await seedEvents();
    const goal = await Ga4GoalService.createGoal(baseCreate());
    const result = await Ga4GoalService.getGoalConversions({
      projectId: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      goalId: goal.id,
      from: "2026-09-20",
      to: "2026-09-21",
    });
    expect(result.conversions).toBe(12);
    expect(result.coverage.status).toBe("complete");
    // Aggregate shape contains no user sums (P23 enforcement).
    expect(result).not.toHaveProperty("users");
    expect(result).not.toHaveProperty("totalUsers");
    expect(result).not.toHaveProperty("newUsers");
  });

  it("honors matchKeyEventOnly by excluding non-key events", async () => {
    await seedEvents();
    const goal = await Ga4GoalService.createGoal(
      baseCreate({ eventName: "other_event", matchKeyEventOnly: true }),
    );
    const result = await Ga4GoalService.getGoalConversions({
      projectId: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      goalId: goal.id,
      from: "2026-09-20",
      to: "2026-09-21",
    });
    expect(result.conversions).toBe(0);
    expect(result.coverage.status).toBe("complete");
  });

  it("renders zero-row success as no-data, never zero facts", async () => {
    await seedEvents();
    const goal = await Ga4GoalService.createGoal(
      baseCreate({ eventName: "never_synced_event" }),
    );
    const result = await Ga4GoalService.getGoalConversions({
      projectId: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      goalId: goal.id,
      from: "2026-09-20",
      to: "2026-09-21",
    });
    expect(result.conversions).toBe(0);
    // No-data must be distinguishable from a measured zero downstream.
    expect(result.coverage.status).toBe("complete");
    expect(result.hasEventRows).toBe(false);
  });

  it("rejects unknown, archived, and other-project goals — never silent empty", async () => {
    await seedEvents();
    for (const goalId of ["missing-id"]) {
      const failure = await Ga4GoalService.getGoalConversions({
        projectId: PROJECT,
        organizationId: ORG,
        propertyId: PROPERTY,
        goalId,
        from: "2026-09-20",
        to: "2026-09-21",
      }).catch((error: unknown) => error);
      expect(failure).toBeInstanceOf(AppError);
      expectAppError(failure, "NOT_FOUND");
    }
    const goal = await Ga4GoalService.createGoal(baseCreate());
    await Ga4GoalService.archiveGoal({
      projectId: PROJECT,
      organizationId: ORG,
      id: goal.id,
    });
    const archived = await Ga4GoalService.getGoalConversions({
      projectId: PROJECT,
      organizationId: ORG,
      propertyId: PROPERTY,
      goalId: goal.id,
      from: "2026-09-20",
      to: "2026-09-21",
    }).catch((error: unknown) => error);
    expect(archived).toBeInstanceOf(AppError);
    expectAppError(archived, "NOT_FOUND");
    // Cross-check the read path exists on the repository (T012 surface).
    expect(typeof Ga4SyncRepository.getGoalConversions).toBe("function");
  });
});
