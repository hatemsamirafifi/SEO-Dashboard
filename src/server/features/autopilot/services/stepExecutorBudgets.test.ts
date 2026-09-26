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
import { assertSynthesisInput } from "./synthesisFirewall";
import {
  clearAutopilotWorkflows,
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

describe("budgets", () => {
  it("refuses the thirteenth step", async () => {
    const steps: AutopilotStepDef[] = [];
    for (let i = 0; i < 13; i += 1) {
      steps.push(computeStep(`step-${i}`, {}, i));
    }
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef(steps),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("failed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.errorClass).toBe("STEP_BUDGET_EXCEEDED");
  });

  it("enforces the tool-call cap across steps", async () => {
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([
        {
          seq: 0,
          kind: "synthesize",
          name: "draft",
          run: async () => ({ evidence: { text: "hi" }, toolCalls: 21 }),
        },
      ]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("failed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.errorClass).toBe("TOOL_CALL_BUDGET_EXCEEDED");
  });

  it("fails fast on depleted hosted credits", async () => {
    vi.spyOn(AutopilotBudgets, "isHostedMode").mockResolvedValue(true);
    vi.spyOn(AutopilotBudgets, "checkCreditsDepleted").mockResolvedValue({
      depleted: true,
      monthlyRemaining: 0,
    });
    const runId = await seedRun();
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow: workflowDef([collectStep("gather", {})]),
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("failed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.errorClass).toBe("INSUFFICIENT_CREDITS");
  });
});

describe("assertSynthesisInput", () => {
  it("accepts frozen evidence from one attempt and rejects the rest", async () => {
    const runId = await seedRun();
    await driveRunToCompletion({
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
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    const attemptId = attempts[0]?.id ?? "";
    const accepted = await assertSynthesisInput({ attemptId, seqs: [0, 1] });
    expect(accepted.map((entry) => entry.seq)).toEqual([0, 1]);
    await expect(
      assertSynthesisInput({ attemptId, seqs: [0, 9] }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      assertSynthesisInput({ attemptId: "missing", seqs: [0] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
