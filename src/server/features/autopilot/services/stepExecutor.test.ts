import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  // Widened: the drizzle handle carries the relational schema (db.query).
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client, { schema });
  return {
    db: database.db,
    withPgClient: async (fn: () => Promise<unknown>) => fn(),
  };
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
}));

import type { BillingCustomerContext } from "@/server/billing/subscription";
import { AutopilotRepository } from "../repositories/AutopilotRepository";
import {
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import { AutopilotBudgets } from "./autopilotBudgets";
import { driveRunToCompletion, type StepRunner } from "./stepExecutor";
import {
  clearAutopilotWorkflows,
  registerAutopilotWorkflow,
  type AutopilotStepDef,
  type AutopilotWorkflowDef,
} from "./autopilotTypes";

function sourceState(version: string | null): DetectionSourceState {
  return {
    versions: {
      gsc: version,
      ga4: null,
      rank: null,
      audit: null,
      backlinks: null,
    },
    sourceSet: version === null ? [] : ["gsc"],
    detectorVersions: {},
    thresholdVersion: 2,
    activeMutations: {
      gsc: { isMutating: false, activeRunIds: [] },
      ga4: { isMutating: false, activeRunIds: [] },
      rank: { isMutating: false, activeRunIds: [] },
      audit: { isMutating: false, activeRunIds: [] },
      backlinks: { isMutating: false, activeRunIds: [] },
    },
  };
}

function isMigrationJournal(value: unknown): value is {
  entries: Array<{ tag: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("entries" in value)) return false;
  const entries: unknown = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string",
    )
  );
}

function migrationStatements(file: string): string[] {
  const withoutBlocks = readFileSync(
    resolve(process.cwd(), file),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
    .filter(Boolean);
}

const BILLING: BillingCustomerContext = {
  userId: "user-1",
  userEmail: "owner@example.com",
  organizationId: "org-1",
  projectId: "project-1",
};

function fakeRunner(): StepRunner {
  return {
    do: (_name, _config, fn) => fn(),
  };
}

function collectStep(
  name: string,
  evidence: unknown,
  seq = 0,
): AutopilotStepDef {
  return {
    seq,
    kind: "collect",
    name,
    run: async () => ({ evidence }),
  };
}

function computeStep(
  name: string,
  evidence: Record<string, unknown>,
  seq = 1,
): AutopilotStepDef {
  return {
    seq,
    kind: "correlate",
    name,
    run: async (ctx) => ({
      evidence: { ...evidence, inputs: ctx.priorEvidence.length },
    }),
  };
}

function workflowDef(steps: AutopilotStepDef[]): AutopilotWorkflowDef {
  return { type: "test-flow", steps };
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (!isMigrationJournal(journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of journal.entries) {
    for (const statement of migrationStatements(`drizzle/${entry.tag}.sql`)) {
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

const TABLES = [
  "autopilot_steps",
  "autopilot_run_attempts",
  "autopilot_runs",
  "projects",
  "organization",
];

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of TABLES) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
  clearAutopilotWorkflows();
  vi.restoreAllMocks();
  vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
    sourceState(null),
  );
  vi.spyOn(AutopilotBudgets, "checkCreditsDepleted").mockResolvedValue({
    depleted: false,
    monthlyRemaining: 100,
  });
  vi.spyOn(AutopilotBudgets, "resolveProvider").mockResolvedValue({
    provider: "openai",
    model: "gpt-test",
    baseUrl: null,
    baseUrlSource: "environment",
    credential: null,
    credentialSource: "environment",
    providerSource: "environment",
  });
});

async function seedRun(): Promise<string> {
  const run = await AutopilotRepository.insertRun({
    id: crypto.randomUUID(),
    projectId: "project-1",
    organizationId: "org-1",
    workflowType: "test-flow",
    status: "pending",
    trigger: "manual",
  });
  return run.id;
}

describe("driveRunToCompletion", () => {
  it("completes a collect→correlate run with frozen evidence", async () => {
    registerAutopilotWorkflow(
      workflowDef([
        collectStep("gather", { rows: 3 }),
        computeStep("merge", { merged: true }),
      ]),
    );
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([
        collectStep("gather", { rows: 3 }),
        computeStep("merge", { merged: true }),
      ]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.evidenceHash).toHaveLength(64);
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("completed");
    const steps = await AutopilotRepository.listStepsByAttempt(
      attempts[0]?.id ?? "",
    );
    expect(steps.map((step) => step.status)).toEqual([
      "completed",
      "completed",
    ]);
    expect(steps[0]?.evidenceHash).toHaveLength(64);
  });

  it("returns terminal runs without re-executing", async () => {
    const runId = await seedRun();
    await AutopilotRepository.updateRun(runId, {
      status: "completed",
      evidenceHash: "h",
    });
    const calls = vi.fn(async () => ({ evidence: {} }));
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([
        { seq: 0, kind: "collect", name: "g", run: calls },
      ]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    expect(calls).not.toHaveBeenCalled();
  });

  it("invalidates on mid-collect drift and retries with a fresh pin", async () => {
    const assemble = vi.spyOn(SourceTokens, "assembleDetectionSourceState");
    assemble
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState("sync-2"))
      .mockResolvedValue(sourceState("sync-2"));
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([collectStep("gather", { rows: 1 })]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    expect(attempts.map((attempt) => attempt.status)).toEqual([
      "invalidated",
      "completed",
    ]);
    expect(attempts[0]?.invalidationReason).toBe("SOURCE_CHANGED");
    expect(attempts[0]?.supersededByAttemptId).toBe(attempts[1]?.id);
  });

  it("fails the run after exhausting attempts", async () => {
    vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockImplementation(
      (() => {
        let calls = 0;
        return async () => {
          calls += 1;
          return sourceState(calls % 2 === 0 ? "sync-2" : "sync-1");
        };
      })(),
    );
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([collectStep("gather", { rows: 1 })]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("failed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.errorClass).toBe("SOURCE_CHANGED_DURING_AUTOPILOT");
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    expect(attempts).toHaveLength(3);
  });

  it("resumes a cancelled attempt without re-collecting evidence", async () => {
    const gather = vi.fn(async () => ({ evidence: { rows: 2 } }));
    let runs = 0;
    const runId = await seedRun();
    const def = workflowDef([
      { seq: 0, kind: "collect", name: "gather", run: gather },
      {
        seq: 1,
        kind: "correlate",
        name: "merge",
        run: async () => {
          runs += 1;
          if (runs === 1) {
            // A user cancel racing the final step: the attempt stays
            // runnable, the run must not flip to completed.
            await AutopilotRepository.updateRun(runId, {
              status: "cancelled",
            });
          }
          return { evidence: { merged: true } };
        },
      },
    ]);
    const drive = {
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: def,
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    };
    const first = await driveRunToCompletion(drive);
    expect(first.status).toBe("cancelled");
    expect(gather).toHaveBeenCalledTimes(1);
    // Resume continues the same attempt: completed steps are skipped.
    const second = await driveRunToCompletion(drive);
    expect(second.status).toBe("completed");
    expect(gather).toHaveBeenCalledTimes(1);
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe("completed");
  });

  it("reuses invariant transforms across attempts", async () => {
    // Drift lands after shape completes: pin, gather×2, finish-before all
    // stable; finish-after trips the invalidation with shape already frozen.
    const assemble = vi.spyOn(SourceTokens, "assembleDetectionSourceState");
    assemble
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState(null))
      .mockResolvedValueOnce(sourceState("sync-2"))
      .mockResolvedValue(sourceState("sync-2"));
    const expensive = vi.fn(async () => ({ evidence: { shaped: true } }));
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([
        collectStep("gather", { rows: 1 }),
        {
          seq: 1,
          kind: "transform",
          name: "shape",
          invariant: true,
          run: expensive,
        },
        collectStep("finish", { done: true }, 2),
      ]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    // First attempt ran shape, then invalidated; second attempt reused it.
    expect(expensive).toHaveBeenCalledTimes(1);
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    const retried = await AutopilotRepository.listStepsByAttempt(
      attempts[1]?.id ?? "",
    );
    expect(retried.find((step) => step.seq === 1)?.reusedFromAttempt).toBe(
      attempts[0]?.id,
    );
  });
});
