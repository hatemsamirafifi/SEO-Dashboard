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

import { captureServerEvent } from "@/server/lib/posthog";
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

describe("startAutopilotRun", () => {
  it("persists the run and creates the workflow instance", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("pending");
    expect(run?.workflowType).toBe("test-flow");
    expect(workflowMocks.create).toHaveBeenCalledWith(
      expect.objectContaining({ id: runId }),
    );
    expect(vi.mocked(captureServerEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "autopilot:start" }),
    );
  });

  it("rejects unregistered workflow types without side effects", async () => {
    await expect(
      AutopilotService.startAutopilotRun({ ...BASE, workflowType: "nope" }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(
      await AutopilotRepository.listRunsByProject("project-1"),
    ).toHaveLength(0);
    expect(workflowMocks.create).not.toHaveBeenCalled();
  });

  it("fails the run when instance creation fails", async () => {
    workflowMocks.create.mockRejectedValueOnce(new Error("capacity"));
    await expect(
      AutopilotService.startAutopilotRun({
        ...BASE,
        workflowType: "test-flow",
      }),
    ).rejects.toThrow("capacity");
    const runs = await AutopilotRepository.listRunsByProject("project-1");
    expect(runs).toHaveLength(1);
    expect(runs[0]?.status).toBe("failed");
    expect(runs[0]?.errorClass).toBe("WORKFLOW_START_FAILED");
  });
});

describe("get/list", () => {
  it("returns runs with attempts and steps, scoped by project", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    const view = await AutopilotService.getAutopilotRun({
      runId,
      projectId: "project-1",
    });
    expect(view?.run.id).toBe(runId);
    expect(view?.attempts).toEqual([]);
    expect(view?.steps).toEqual([]);
    expect(
      await AutopilotService.getAutopilotRun({
        runId,
        projectId: "other",
      }),
    ).toBeNull();
    expect(
      await AutopilotService.getAutopilotRun({
        runId: "missing",
        projectId: "project-1",
      }),
    ).toBeNull();
    const listed = await AutopilotService.listAutopilotRuns({
      projectId: "project-1",
    });
    expect(listed.map((run) => run.id)).toEqual([runId]);
  });
});

describe("cancelAutopilotRun", () => {
  it("terminates the instance and marks cancelled", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    const result = await AutopilotService.cancelAutopilotRun({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    expect(result).toEqual({ status: "cancelled" });
    expect(instances.states.get(runId)).toBe("terminated");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("cancelled");
  });

  it("leaves terminal runs and missing rows alone", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    expect(
      await AutopilotService.cancelAutopilotRun({
        runId,
        projectId: "project-1",
        organizationId: "org-1",
      }),
    ).toEqual({ status: "completed" });
    await expect(
      AutopilotService.cancelAutopilotRun({
        runId: "missing",
        projectId: "project-1",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("resumeAutopilotRun", () => {
  it("continues cancelled runs on a fresh instance", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotService.cancelAutopilotRun({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    const resumed = await AutopilotService.resumeAutopilotRun({
      ...BASE,
      runId,
    });
    expect(resumed).toEqual({ runId, resumed: true });
    expect(instances.states.get(runId)).toBe("running");
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("running");
  });

  it("is a no-op while the instance is alive", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(runId, { status: "running" });
    const resumed = await AutopilotService.resumeAutopilotRun({
      ...BASE,
      runId,
    });
    expect(resumed).toEqual({ runId, resumed: false });
  });

  it("refuses terminal and missing runs", async () => {
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "test-flow",
    });
    await AutopilotRepository.updateRun(runId, {
      status: "completed",
      completedAt: new Date().toISOString(),
    });
    await expect(
      AutopilotService.resumeAutopilotRun({ ...BASE, runId }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      AutopilotService.resumeAutopilotRun({ ...BASE, runId: "missing" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
