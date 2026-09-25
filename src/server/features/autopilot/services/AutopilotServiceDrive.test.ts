import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const instances = vi.hoisted(() => ({
  states: new Map<string, string>(),
}));

const workflowMocks = vi.hoisted(() => ({
  create: vi.fn(async ({ id }: { id: string }) => {
    const current = instances.states.get(id);
    if (current === "running") {
      throw new Error(`instance ${id} already exists`);
    }
    instances.states.set(id, "running");
  }),
  get: vi.fn(async (id: string) => {
    const current = instances.states.get(id);
    if (current === undefined) throw new Error("instance not found");
    return {
      status: async () => ({ status: current }),
      terminate: async () => {
        instances.states.set(id, "terminated");
      },
    };
  }),
}));

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  // Widened: the drizzle handle carries the relational schema (db.query).
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    AUTOPILOT_WORKFLOW: {
      create: workflowMocks.create,
      get: workflowMocks.get,
    },
  },
  waitUntil: vi.fn(),
}));

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

import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { AutopilotService } from "./AutopilotService";
import {
  clearAutopilotWorkflows,
  registerAutopilotWorkflow,
} from "./autopilotTypes";
import { resetAutopilotTestDb, setupAutopilotTestDb } from "./autopilotTestDb";

const BASE = {
  projectId: "project-1",
  organizationId: "org-1",
  userId: "user-1",
  userEmail: "owner@example.com",
};

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await setupAutopilotTestDb(database.client);
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await resetAutopilotTestDb(database.client);
  instances.states.clear();
  clearAutopilotWorkflows();
  registerAutopilotWorkflow({ type: "test-flow", steps: [] });
  vi.restoreAllMocks();
});

describe("driveWorkflowRun", () => {
  it("drives a registered workflow to completion", async () => {
    clearAutopilotWorkflows();
    registerAutopilotWorkflow({
      type: "probe",
      steps: [
        {
          seq: 0,
          kind: "collect",
          name: "probe-collect",
          run: async () => ({ evidence: { ok: true } }),
        },
      ],
    });
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "probe",
    });
    const result = await AutopilotService.driveWorkflowRun({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflowType: "probe",
      billingCustomer: {
        userId: "user-1",
        userEmail: "owner@example.com",
        organizationId: "org-1",
        projectId: "project-1",
      },
      stepRunner: {
        do: (_name, _config, fn) => fn(),
      },
    });
    expect(result.status).toBe("completed");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("completed");
    expect(run?.evidenceHash).toHaveLength(64);
  });

  it("fails runs with unknown workflow types", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    const result = await AutopilotService.driveWorkflowRun({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflowType: "nope",
      billingCustomer: {
        userId: "user-1",
        userEmail: "owner@example.com",
        organizationId: "org-1",
        projectId: "project-1",
      },
      stepRunner: {
        do: (_name, _config, fn) => fn(),
      },
    });
    expect(result.status).toBe("failed");
  });
});

describe("reconcileAutopilotRuns", () => {
  it("fails orphaned running rows and leaves live ones", async () => {
    const { runId: orphanId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(orphanId, { status: "running" });
    instances.states.delete(orphanId);
    // The next start reconciles implicitly: orphan fails, live proceeds.
    const { runId: liveId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(liveId, { status: "running" });
    const orphan = await AutopilotRepository.getRun(orphanId);
    expect(orphan?.status).toBe("failed");
    expect(orphan?.errorClass).toBe("ORPHANED_INSTANCE");
    const { reconciled } = await AutopilotService.reconcileAutopilotRuns({
      projectId: "project-1",
    });
    expect(reconciled).toEqual([]);
    const live = await AutopilotRepository.getRun(liveId);
    expect(live?.status).toBe("running");
  });

  it("fails errored and terminated instances directly", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(runId, { status: "running" });
    instances.states.set(runId, "errored");
    const { reconciled } = await AutopilotService.reconcileAutopilotRuns({
      projectId: "project-1",
    });
    expect(reconciled).toEqual([runId]);
  });
});
