import type { Client } from "@libsql/client";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
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

import { AutopilotRepository } from "../repositories/AutopilotRepository";
import { SourceTokens } from "@/server/features/intelligence/services/SourceTokens";
import {
  InsightRepository,
  type InsightRow,
} from "@/server/features/intelligence/repositories/InsightRepository";
import {
  OpportunityRepository,
  type OpportunityRow,
} from "@/server/features/intelligence/repositories/OpportunityRepository";
import { AutopilotBudgets } from "./autopilotBudgets";
import { driveRunToCompletion } from "./stepExecutor";
import {
  clearAutopilotWorkflows,
  getAutopilotWorkflow,
} from "./autopilotTypes";
import {
  WORKFLOW_PROMPTS,
  ensureAutopilotWorkflowsRegistered,
} from "./autopilotWorkflows";
import { containsBannedCausalVerb } from "./autopilotSerializer";
import { resetAutopilotTestDb, setupAutopilotTestDb } from "./autopilotTestDb";
import {
  BILLING,
  fakeRunner,
  seedRun,
  sourceState,
} from "./autopilotTestFixtures";

function makeOpportunity(
  overrides: Partial<OpportunityRow> & { id: string },
): OpportunityRow {
  const now = "2026-09-20T00:00:00.000Z";
  return {
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey: "organic_traffic_change:/pricing",
    occurrenceNumber: 1,
    type: "organic_traffic_change",
    detectorKey: "organic_traffic_change",
    detectorVersion: 1,
    scoreVersion: 1,
    status: "open",
    impactScore: 72,
    confidenceScore: 68,
    priority: "High",
    title: "Pricing traffic moved",
    explanationFact: "Clicks moved in the window",
    recommendation: "Inspect the page",
    evidenceJson: "{}",
    keyword: null,
    page: "/pricing",
    sourceMetricsJson: null,
    sourcesJson: "[]",
    impactFactorsJson: null,
    confidenceInputsJson: null,
    lastSeenScanId: null,
    consecutiveMisses: 0,
    stale: false,
    staleAt: null,
    recurrenceOfId: null,
    supersededById: null,
    firstDetectedAt: now,
    lastDetectedAt: now,
    completedAt: null,
    dismissedAt: null,
    dismissalReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function parseJsonObject(text: string): Record<string, unknown> {
  const parsed: unknown = JSON.parse(text);
  if (typeof parsed !== "object" || parsed === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(parsed)) {
    out[key] = value;
  }
  return out;
}

function recommendationsOf(
  stepEvidenceJson: string | null,
): Record<string, unknown>[] {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record["recommendations"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function evidenceTypeOf(stepEvidenceJson: string | null): unknown {
  return parseJsonObject(stepEvidenceJson ?? "null")["evidenceType"];
}

function rankedIdsOf(stepEvidenceJson: string | null): string[] {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record["rankedIds"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
}

function totalConsideredOf(stepEvidenceJson: string | null): unknown {
  return parseJsonObject(stepEvidenceJson ?? "null")["totalConsidered"];
}

function correlationRowsOf(
  stepEvidenceJson: string | null,
): Record<string, unknown>[] {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record["rows"];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function stringField(record: Record<string, unknown>, key: string): string {
  const value: unknown = record[key];
  return typeof value === "string" ? value : "";
}

function confidenceOf(rec: Record<string, unknown>): Record<string, unknown> {
  const value: unknown = rec["confidence"];
  if (typeof value !== "object" || value === null) return {};
  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = entry;
  }
  return out;
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await setupAutopilotTestDb(database.client);
});

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await resetAutopilotTestDb(database.client);
  clearAutopilotWorkflows();
  ensureAutopilotWorkflowsRegistered();
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

describe("autopilot workflow definitions", () => {
  it("registers growth_plan, quick_wins, and traffic_drop with dense seqs", () => {
    for (const type of ["growth_plan", "quick_wins", "traffic_drop"] as const) {
      const def = getAutopilotWorkflow(type);
      expect(def).not.toBeNull();
      expect(def?.steps.map((step) => step.seq)).toEqual([0, 1, 2]);
      expect(def?.steps.map((step) => step.kind)).toEqual([
        "collect",
        "correlate",
        "synthesize",
      ]);
    }
  });

  it("keeps every prompt free of banned causal verbs", () => {
    for (const prompt of Object.values(WORKFLOW_PROMPTS)) {
      expect(containsBannedCausalVerb(prompt)).toBe(false);
    }
  });

  it("drives growth_plan to completion with evidence and confidence", async () => {
    vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
      async () => [
        makeOpportunity({ id: "opp-1" }),
        makeOpportunity({
          id: "opp-2",
          logicalKey: "low_ctr_query:head term",
          type: "low_ctr_query",
          detectorKey: "low_ctr_query",
          priority: "Medium",
          impactScore: 45,
          confidenceScore: 55,
          title: "Head term CTR soft",
          page: null,
          keyword: "head term",
        }),
      ],
    );
    vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
      async () => [] as InsightRow[],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("growth_plan");
    if (!workflow) throw new Error("growth_plan was not registered");
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow,
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    const steps = await AutopilotRepository.listStepsByAttempt(
      attempts[0]?.id ?? "",
    );
    const synthesis = steps.find((step) => step.seq === 2);
    expect(evidenceTypeOf(synthesis?.evidenceJson ?? null)).toBe(
      "observational",
    );
    const recommendations = recommendationsOf(synthesis?.evidenceJson ?? null);
    expect(recommendations.length).toBeGreaterThan(0);
    for (const rec of recommendations) {
      const confidence = confidenceOf(rec);
      expect(typeof confidence["value"]).toBe("number");
      expect(String(confidence["why"]).length).toBeGreaterThan(0);
    }
    expect(synthesis?.toolCalls).toBe(1);
  });

  it("limits quick_wins to Critical and High opportunities", async () => {
    vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
      async () => [
        makeOpportunity({ id: "opp-1", priority: "High" }),
        makeOpportunity({
          id: "opp-low",
          logicalKey: "backlink_change:example.com",
          type: "backlink_change",
          detectorKey: "backlink_change",
          priority: "Low",
          title: "Backlink drift",
          page: null,
          keyword: null,
        }),
      ],
    );
    vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
      async () => [] as InsightRow[],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("quick_wins");
    if (!workflow) throw new Error("quick_wins was not registered");
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow,
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    const steps = await AutopilotRepository.listStepsByAttempt(
      attempts[0]?.id ?? "",
    );
    const correlate = steps.find((step) => step.seq === 1);
    expect(totalConsideredOf(correlate?.evidenceJson ?? null)).toBe(1);
    expect(rankedIdsOf(correlate?.evidenceJson ?? null)).toEqual(["opp-1"]);
  });

  it("builds a language-guarded correlation table for traffic_drop", async () => {
    vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
      async () => [
        makeOpportunity({ id: "opp-1" }),
        makeOpportunity({
          id: "opp-2",
          logicalKey: "ga4_organic_change:/pricing",
          type: "ga4_organic_change",
          detectorKey: "ga4_organic_change",
          title: "GA4 sessions moved",
        }),
        makeOpportunity({
          id: "opp-3",
          logicalKey: "low_ctr_query:other term",
          type: "low_ctr_query",
          detectorKey: "low_ctr_query",
          priority: "Medium",
          title: "Other CTR soft",
          page: null,
          keyword: "other term",
        }),
      ],
    );
    vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
      async () => [] as InsightRow[],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("traffic_drop");
    if (!workflow) throw new Error("traffic_drop was not registered");
    const result = await driveRunToCompletion({
      runId,
      projectId: "project-1",
      organizationId: "org-1",
      workflow,
      billingCustomer: BILLING,
      stepRunner: fakeRunner(),
    });
    expect(result.status).toBe("completed");
    const attempts = await AutopilotRepository.listAttemptsByRun(runId);
    const steps = await AutopilotRepository.listStepsByAttempt(
      attempts[0]?.id ?? "",
    );
    const rows = correlationRowsOf(
      steps.find((step) => step.seq === 1)?.evidenceJson ?? null,
    );
    expect(rows).toHaveLength(1);
    expect(stringField(rows[0] ?? {}, "entity")).toBe("/pricing");
    expect(stringField(rows[0] ?? {}, "agreement")).toBe("corroborated");
    const recommendations = recommendationsOf(
      steps.find((step) => step.seq === 2)?.evidenceJson ?? null,
    );
    for (const rec of recommendations) {
      expect(
        containsBannedCausalVerb(stringField(rec, "reasoningSummary")),
      ).toBe(false);
    }
  });
});
