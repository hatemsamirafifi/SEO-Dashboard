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
import { WORKFLOW_PROMPTS } from "./autopilotWorkflowContent";
import {
  containsBannedCausalVerb,
  containsUpliftPattern,
} from "./autopilotSerializer";
import { ensureAutopilotWorkflowsRegistered } from "./autopilotWorkflows";
import { resetAutopilotTestDb, setupAutopilotTestDb } from "./autopilotTestDb";
import {
  BILLING,
  fakeRunner,
  makeOpportunity,
  seedRun,
  sourceState,
} from "./autopilotTestFixtures";

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

// Spec 013 (US1 T007/T008): registration shape and prompt language.
describe("content_refresh registration", () => {
  it("registers with collect/correlate/synthesize seqs", () => {
    const def = getAutopilotWorkflow("content_refresh");
    expect(def).not.toBeNull();
    expect(def?.steps.map((step) => step.seq)).toEqual([0, 1, 2]);
    expect(def?.steps.map((step) => step.kind)).toEqual([
      "collect",
      "correlate",
      "synthesize",
    ]);
    expect(
      def?.steps.some((step) => step.kind === "side_effect"),
    ).toBe(false);
  });

  it("keeps the content_refresh prompt observational", () => {
    const prompt = WORKFLOW_PROMPTS["content_refresh"];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(containsBannedCausalVerb(prompt)).toBe(false);
  });
});

// Spec 013 (US1 T007): end-to-end drive over stored engine state.
describe("content_refresh drive", () => {
  it("ranks refresh candidates by priority, impact, then confidence", async () => {
    const make = (
      id: string,
      overrides: Partial<OpportunityRow> = {},
    ) =>
      makeOpportunity({
        logicalKey: `content_decay:/page-${id}`,
        type: "content_decay",
        detectorKey: "content_decay",
        page: `/page-${id}`,
        keyword: null,
        ...overrides,
        id,
      });
    const candidates = [
      make("low", { priority: "Low", impactScore: 90, confidenceScore: 90 }),
      make("med", {
        priority: "Medium",
        impactScore: 50,
        confidenceScore: 50,
      }),
      make("high-a", {
        priority: "High",
        impactScore: 60,
        confidenceScore: 60,
      }),
      make("high-b", {
        priority: "High",
        impactScore: 80,
        confidenceScore: 40,
      }),
      make("crit", {
        priority: "Critical",
        impactScore: 30,
        confidenceScore: 30,
      }),
      // Keyword-only rows are not refresh candidates even at top priority.
      make("nonpage", {
        id: "nonpage",
        logicalKey: "low_ctr_query:head term",
        type: "low_ctr_query",
        detectorKey: "low_ctr_query",
        page: null,
        keyword: "head term",
        priority: "Critical",
        impactScore: 99,
        confidenceScore: 99,
      }),
    ];
    // Seven more low-priority page rows: 12 page-bearing candidates, 10 ranked.
    for (let i = 0; i < 7; i++) {
      candidates.push(
        make(`extra-${i}`, {
          logicalKey: `content_decay:/extra-${i}`,
          page: `/extra-${i}`,
          priority: "Low",
          impactScore: 10 + i,
          confidenceScore: 10,
        }),
      );
    }
    vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
      async () => candidates,
    );
    vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
      async () => [] as InsightRow[],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("content_refresh");
    if (!workflow) throw new Error("content_refresh was not registered");
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
    expect(totalConsideredOf(correlate?.evidenceJson ?? null)).toBe(12);
    expect(rankedIdsOf(correlate?.evidenceJson ?? null)).toEqual([
      "crit",
      "high-b",
      "high-a",
      "med",
      "low",
      "extra-6",
      "extra-5",
      "extra-4",
      "extra-3",
      "extra-2",
    ]);
    const synthesis = steps.find((step) => step.seq === 2);
    expect(evidenceTypeOf(synthesis?.evidenceJson ?? null)).toBe(
      "observational",
    );
    expect(synthesis?.toolCalls).toBe(1);
    const recommendations = recommendationsOf(
      synthesis?.evidenceJson ?? null,
    );
    expect(recommendations.length).toBeGreaterThan(0);
    for (const rec of recommendations) {
      expect(
        containsBannedCausalVerb(stringField(rec, "reasoningSummary")),
      ).toBe(false);
      expect(
        containsUpliftPattern(
          `${stringField(rec, "reasoningSummary")} ${stringField(rec, "suggestedAction")}`,
        ),
      ).toBe(false);
      expect(String(rec["dataSource"] ?? "")).toContain("opportunity:");
      const confidence = confidenceOf(rec);
      expect(typeof confidence["value"]).toBe("number");
    }
  });
});
