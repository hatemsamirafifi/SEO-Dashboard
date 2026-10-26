import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  return { db: drizzle(database.client) };
});

import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
import { resetAutopilotTestDb, setupAutopilotTestDb } from "./autopilotTestDb";
import {
  appendCompletionEvidence,
  type CompletionEvidenceResult,
} from "./opportunityEvidenceLoop";
import type { OpportunityInsert } from "@/server/features/intelligence/repositories/OpportunityRepository";

function occurrence(overrides: Partial<OpportunityInsert>): OpportunityInsert {
  return {
    id: "occ-x",
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

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  // Shared journal-driven bootstrap: applies every migration by tag, so the
  // opportunities triage columns land with the journal.
  await setupAutopilotTestDb(database.client);
});

/** Real parent rows so the FK-enforcing harness accepts the step rows. */
async function seedRunAndAttempt(): Promise<void> {
  await AutopilotRepository.insertRun({
    id: "run-1",
    projectId: "project-1",
    organizationId: "org-1",
    workflowType: "test-flow",
  });
  await AutopilotRepository.insertAttempt({
    id: "att-1",
    runId: "run-1",
    attemptNumber: 1,
    sourceVersionsJson: "{}",
    sourceVersionsHash: "hash",
    status: "completed",
  });
}

async function seedStep(
  seq: number,
  evidenceJson: string | null,
): Promise<void> {
  await AutopilotRepository.insertStepIgnoreConflict({
    id: `step-${seq}`,
    attemptId: "att-1",
    runId: "run-1",
    seq,
    kind: "collect",
    name: "collect",
    status: "completed",
    idempotencyKey: `step-${seq}`,
  });
  if (evidenceJson !== null) {
    await AutopilotRepository.updateStep("att-1", seq, { evidenceJson });
  }
}

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  // Resets the autopilot base tables and re-seeds org-1/project-1.
  await resetAutopilotTestDb(database.client);
  for (const table of ["opportunity_events", "opportunities"]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
});

describe("appendCompletionEvidence (spec 021 FR-007)", () => {
  it("appends one evidence event per referenced occurrence with step refs", async () => {
    await seedRunAndAttempt();
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-a", logicalKey: "k:a" }),
    );
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-b", logicalKey: "k:b" }),
    );
    await seedStep(
      1,
      JSON.stringify({ rankedIds: ["occ-a", "occ-b"], summary: "ranked" }),
    );
    await seedStep(2, JSON.stringify({ rankedIds: ["occ-a"], summary: "act" }));

    const result: CompletionEvidenceResult = await appendCompletionEvidence({
      runId: "run-1",
      attemptId: "att-1",
      projectId: "project-1",
      workflowType: "test-flow",
      steps: await AutopilotRepository.listStepsByAttempt("att-1"),
    });

    expect(result).toEqual({ occurrences: 2, appended: 2 });

    const eventsA = await OpportunityRepository.listEventsByOccurrence("occ-a");
    const evidenceA = eventsA.filter((e) => e.type === "completion_evidence");
    expect(evidenceA).toHaveLength(1);
    const payload: unknown = JSON.parse(evidenceA[0]?.payloadJson ?? "{}");
    expect(payload).toMatchObject({
      runId: "run-1",
      attemptId: "att-1",
      projectId: "project-1",
      workflowType: "test-flow",
      outcome: "completed",
      steps: [
        { seq: 1, kind: "collect" },
        { seq: 2, kind: "collect" },
      ],
    });

    const eventsB = await OpportunityRepository.listEventsByOccurrence("occ-b");
    expect(
      eventsB.filter((e) => e.type === "completion_evidence"),
    ).toHaveLength(1);
  });

  it("replays nothing on a retried drive for the same run", async () => {
    await seedRunAndAttempt();
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-a", logicalKey: "k:a" }),
    );
    await seedStep(1, JSON.stringify({ rankedIds: ["occ-a"] }));
    const steps = await AutopilotRepository.listStepsByAttempt("att-1");
    const input = {
      runId: "run-1",
      attemptId: "att-1",
      projectId: "project-1",
      workflowType: "test-flow",
      steps,
    } as const;

    const first = await appendCompletionEvidence(input);
    const replay = await appendCompletionEvidence(input);
    expect(first).toEqual({ occurrences: 1, appended: 1 });
    expect(replay).toEqual({ occurrences: 1, appended: 0 });
    const events = await OpportunityRepository.listEventsByOccurrence("occ-a");
    expect(events.filter((e) => e.type === "completion_evidence")).toHaveLength(
      1,
    );
  });

  it("skips corrupt evidence and still processes the other steps", async () => {
    await seedRunAndAttempt();
    await OpportunityRepository.insertIgnoreConflict(
      occurrence({ id: "occ-a", logicalKey: "k:a" }),
    );
    await seedStep(1, "{not json");
    await seedStep(2, JSON.stringify({ rankedIds: ["occ-a"] }));

    const result = await appendCompletionEvidence({
      runId: "run-1",
      attemptId: "att-1",
      projectId: "project-1",
      workflowType: "test-flow",
      steps: await AutopilotRepository.listStepsByAttempt("att-1"),
    });

    expect(result).toEqual({ occurrences: 1, appended: 1 });
    const events = await OpportunityRepository.listEventsByOccurrence("occ-a");
    const payload: unknown = JSON.parse(
      events.find((e) => e.type === "completion_evidence")?.payloadJson ?? "{}",
    );
    expect(payload).toMatchObject({ steps: [{ seq: 2, kind: "collect" }] });
  });
});
