/* eslint-disable max-lines */
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

const gateMocks = vi.hoisted(() => ({
  competitorGapGateState: vi.fn(),
}));

vi.mock("@/server/lib/competitor-gap/verdictLedger", () => ({
  competitorGapGateState: gateMocks.competitorGapGateState,
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
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
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

  it("rejects competitor_gap workflow when G5 gate is not READY", async () => {
    registerAutopilotWorkflow({ type: "competitor_gap", steps: [] });
    gateMocks.competitorGapGateState.mockResolvedValueOnce({
      state: "BLOCKED",
      latestVerdict: null,
    });
    await expect(
      AutopilotService.startAutopilotRun({
        ...BASE,
        workflowType: "competitor_gap",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("G5 gate not ready"),
    });
  });

  it("rejects competitor_gap workflow when G5 is READY but no US2 materialized evidence exists", async () => {
    registerAutopilotWorkflow({ type: "competitor_gap", steps: [] });
    gateMocks.competitorGapGateState.mockResolvedValueOnce({
      state: "READY",
      latestVerdict: null,
    });
    await expect(
      AutopilotService.startAutopilotRun({
        ...BASE,
        workflowType: "competitor_gap",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining(
        "US2 operational acceptance requires valid materialized opportunity evidence",
      ),
    });
  });

  it("allows competitor_gap workflow when G5 gate is READY and US2 opportunities exist", async () => {
    registerAutopilotWorkflow({ type: "competitor_gap", steps: [] });
    gateMocks.competitorGapGateState.mockResolvedValueOnce({
      state: "READY",
      latestVerdict: null,
    });
    await OpportunityRepository.insertIgnoreConflict({
      id: "op-gap-1",
      projectId: BASE.projectId,
      organizationId: BASE.organizationId,
      logicalKey: "competitor_gap:crm",
      type: "competitor_gap",
      detectorKey: "competitor_gap",
      detectorVersion: 1,
      scoreVersion: 1,
      status: "open",
      impactScore: 80,
      confidenceScore: 85,
      priority: "High",
      title: 'Competitor gap for "crm"',
      explanationFact: "Competitor ranks at position 2",
      recommendation: "Create content",
      evidenceJson: "{}",
      firstDetectedAt: "2026-09-28T00:00:00.000Z",
      lastDetectedAt: "2026-09-28T00:00:00.000Z",
    });
    const { runId } = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "competitor_gap",
    });
    const run = await AutopilotRepository.getRun(runId);
    expect(run?.status).toBe("pending");
    expect(run?.workflowType).toBe("competitor_gap");
    expect(gateMocks.competitorGapGateState).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: BASE.organizationId,
        projectId: BASE.projectId,
      }),
    );
  });

  it("allows competitor_gap workflow when G5 gate is READY from approved R2 evaluation and US2 evidence is fresh", async () => {
    registerAutopilotWorkflow({ type: "competitor_gap", steps: [] });
    gateMocks.competitorGapGateState.mockResolvedValueOnce({
      state: "READY",
      verdictRow: {
        id: "cgv_test_r2",
        organizationId: BASE.organizationId,
        projectId: BASE.projectId,
        verdict: "COMPETITOR_GAP_READY",
        inputManifest: {
          evaluationId: "competitor-gap-g5-r2",
        },
      },
    });
    const nowIso = new Date().toISOString();
    await OpportunityRepository.insertIgnoreConflict({
      id: "op-gap-r2-fresh",
      projectId: BASE.projectId,
      organizationId: BASE.organizationId,
      logicalKey: "competitor_gap:crm-fresh",
      type: "competitor_gap",
      detectorKey: "competitor_gap",
      detectorVersion: 1,
      scoreVersion: 1,
      status: "open",
      impactScore: 80,
      confidenceScore: 85,
      priority: "High",
      title: 'Competitor gap for "crm"',
      explanationFact: "Competitor ranks at position 2",
      recommendation: "Create content",
      evidenceJson: JSON.stringify({ competitor: "comp.com", rank: 2 }),
      firstDetectedAt: nowIso,
      lastDetectedAt: nowIso,
    });
    const result = await AutopilotService.startAutopilotRun({
      ...BASE,
      workflowType: "competitor_gap",
    });
    expect(result.runId).toBeTruthy();
  });

  it("rejects competitor_gap workflow when US2 materialized evidence is stale (> 28d)", async () => {
    registerAutopilotWorkflow({ type: "competitor_gap", steps: [] });
    gateMocks.competitorGapGateState.mockResolvedValueOnce({
      state: "READY",
      verdictRow: {
        id: "cgv_test_ok",
        organizationId: BASE.organizationId,
        projectId: BASE.projectId,
        verdict: "COMPETITOR_GAP_READY",
        inputManifest: {},
      },
    });
    // Opportunity older than 28 days (e.g. 60 days old)
    await OpportunityRepository.insertIgnoreConflict({
      id: "op-gap-stale",
      projectId: BASE.projectId,
      organizationId: BASE.organizationId,
      logicalKey: "competitor_gap:old",
      type: "competitor_gap",
      detectorKey: "competitor_gap",
      detectorVersion: 1,
      scoreVersion: 1,
      status: "open",
      impactScore: 80,
      confidenceScore: 85,
      priority: "High",
      title: 'Competitor gap for "old"',
      explanationFact: "Competitor ranks at position 2",
      recommendation: "Create content",
      evidenceJson: "{}",
      firstDetectedAt: "2026-01-01T00:00:00.000Z",
      lastDetectedAt: "2026-01-01T00:00:00.000Z",
    });
    await expect(
      AutopilotService.startAutopilotRun({
        ...BASE,
        workflowType: "competitor_gap",
      }),
    ).rejects.toMatchObject({
      code: "VALIDATION_ERROR",
      message: expect.stringContaining("lacks valid coverage or freshness"),
    });
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
