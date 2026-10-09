/* eslint-disable max-lines */
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
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";
import * as auditSummaryQueries from "@/server/features/audit/repositories/auditSummaryQueries";
import {
  InsightRepository,
  type InsightRow,
} from "@/server/features/intelligence/repositories/InsightRepository";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
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

function stringField(record: Record<string, unknown>, key: string): string {
  const value: unknown = record[key];
  return typeof value === "string" ? value : "";
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

function recordField(
  stepEvidenceJson: string | null,
  key: string,
): Record<string, unknown> {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record[key];
  if (typeof raw !== "object" || raw === null) return {};
  const out: Record<string, unknown> = {};
  for (const [entryKey, entry] of Object.entries(raw)) {
    out[entryKey] = entry;
  }
  return out;
}

function stringListOf(
  stepEvidenceJson: string | null,
  key: string,
): string[] {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is string => typeof entry === "string",
  );
}

function recordListOf(
  stepEvidenceJson: string | null,
  key: string,
): Record<string, unknown>[] {
  const record = parseJsonObject(stepEvidenceJson ?? "null");
  const raw: unknown = record[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

type AuditRow = {
  id: string;
  projectId: string;
  startedByUserId: string;
  startUrl: string;
  status: "running" | "completed" | "failed";
  workflowInstanceId: string | null;
  config: string;
  pagesCrawled: number;
  pagesTotal: number;
  lighthouseTotal: number;
  lighthouseCompleted: number;
  lighthouseFailed: number;
  currentPhase: string | null;
  startedAt: string;
  completedAt: string | null;
};

function makeAudit(overrides: Partial<AuditRow> = {}): AuditRow {
  const now = "2026-09-20T00:00:00.000Z";
  return {
    id: "audit-1",
    projectId: "project-1",
    startedByUserId: "user-1",
    startUrl: "https://example.com",
    status: "completed",
    workflowInstanceId: null,
    config: "{}",
    pagesCrawled: 42,
    pagesTotal: 42,
    lighthouseTotal: 0,
    lighthouseCompleted: 0,
    lighthouseFailed: 0,
    currentPhase: "done",
    startedAt: now,
    completedAt: now,
    ...overrides,
  };
}

async function driveTechnicalSeo(): Promise<{
  status: string;
  steps: Awaited<
    ReturnType<typeof AutopilotRepository.listStepsByAttempt>
  >;
}> {
  const runId = await seedRun();
  const workflow = getAutopilotWorkflow("technical_seo");
  if (!workflow) throw new Error("technical_seo was not registered");
  const result = await driveRunToCompletion({
    runId,
    projectId: "project-1",
    organizationId: "org-1",
    workflow,
    billingCustomer: BILLING,
    stepRunner: fakeRunner(),
  });
  const attempts = await AutopilotRepository.listAttemptsByRun(runId);
  const steps = await AutopilotRepository.listStepsByAttempt(
    attempts[0]?.id ?? "",
  );
  return { status: result.status, steps };
}

function mockEngineEmpty() {
  vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
    async () => [],
  );
  vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
    async () => [] as InsightRow[],
  );
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

// Spec 013 (US2 T011): registration shape and prompt language.
describe("technical_seo registration", () => {
  it("registers with collect/correlate/synthesize seqs", () => {
    const def = getAutopilotWorkflow("technical_seo");
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

  it("keeps the technical_seo prompt observational", () => {
    const prompt = WORKFLOW_PROMPTS["technical_seo"];
    expect(typeof prompt).toBe("string");
    expect(prompt.length).toBeGreaterThan(0);
    expect(containsBannedCausalVerb(prompt)).toBe(false);
  });
});

// Spec 013 (US2 T011): honest coverage states — never an invented "no issues".
describe("technical_seo coverage states", () => {
  it("reports never_run coverage when no audit exists", async () => {
    mockEngineEmpty();
    vi.spyOn(
      AuditRepository,
      "getLatestAuditForProject",
    ).mockImplementation(async () => undefined);
    const issueCounts = vi.spyOn(
      auditSummaryQueries,
      "getIssueTypePageCountsForAudit",
    );
    const { status, steps } = await driveTechnicalSeo();
    expect(status).toBe("completed");
    expect(issueCounts).not.toHaveBeenCalled();
    const collect = steps.find((step) => step.seq === 0);
    expect(recordField(collect?.evidenceJson ?? null, "auditCoverage")).toEqual(
      { state: "never_run" },
    );
    const synthesis = steps.find((step) => step.seq === 2);
    expect(evidenceTypeOf(synthesis?.evidenceJson ?? null)).toBe(
      "observational",
    );
    const recommendations = recommendationsOf(
      synthesis?.evidenceJson ?? null,
    );
    expect(recommendations).toHaveLength(1);
    expect(
      stringField(recommendations[0] ?? {}, "suggestedAction"),
    ).toContain("audit");
  });

  it("reports stale_or_failed coverage for running and failed audits", async () => {
    mockEngineEmpty();
    const latestAudit = vi.spyOn(
      AuditRepository,
      "getLatestAuditForProject",
    );
    for (const auditStatus of ["running", "failed"] as const) {
      latestAudit.mockImplementation(
        async () => makeAudit({ status: auditStatus, pagesCrawled: 5 }),
      );
      const { status, steps } = await driveTechnicalSeo();
      expect(status).toBe("completed");
      const collect = steps.find((step) => step.seq === 0);
      expect(
        recordField(collect?.evidenceJson ?? null, "auditCoverage"),
      ).toEqual({ state: "stale_or_failed", auditStatus });
      const synthesis = steps.find((step) => step.seq === 2);
      const recommendations = recommendationsOf(
        synthesis?.evidenceJson ?? null,
      );
      expect(recommendations).toHaveLength(1);
      expect(
        stringField(recommendations[0] ?? {}, "suggestedAction"),
      ).toContain("audit");
    }
  });

  it("reports empty_crawl coverage for a completed audit with zero pages", async () => {
    mockEngineEmpty();
    vi.spyOn(
      AuditRepository,
      "getLatestAuditForProject",
    ).mockImplementation(
      async () => makeAudit({ status: "completed", pagesCrawled: 0 }),
    );
    const { status, steps } = await driveTechnicalSeo();
    expect(status).toBe("completed");
    const collect = steps.find((step) => step.seq === 0);
    expect(recordField(collect?.evidenceJson ?? null, "auditCoverage")).toEqual(
      { state: "empty_crawl" },
    );
    const synthesis = steps.find((step) => step.seq === 2);
    expect(
      recommendationsOf(synthesis?.evidenceJson ?? null),
    ).toHaveLength(1);
  });
});

// Spec 013 (US2 T011/T012): ready-state ranking and opportunity echo.
describe("technical_seo ready evidence", () => {
  it("ranks ready audit issues by severity then page count, facts apart", async () => {
    mockEngineEmpty();
    vi.spyOn(
      AuditRepository,
      "getLatestAuditForProject",
    ).mockImplementation(async () => makeAudit({ pagesCrawled: 42 }));
    vi.spyOn(
      auditSummaryQueries,
      "getIssueTypePageCountsForAudit",
    ).mockImplementation(async () => [
      { issueType: "missing-alt", severity: "info", pages: 30 },
      { issueType: "noindex-important", severity: "critical", pages: 2 },
      { issueType: "slow-ttfb", severity: "warning", pages: 12 },
      { issueType: "broken-links", severity: "critical", pages: 9 },
    ]);
    const { status, steps } = await driveTechnicalSeo();
    expect(status).toBe("completed");
    const correlate = steps.find((step) => step.seq === 1);
    const ranked = recordListOf(correlate?.evidenceJson ?? null, "rankedIssues");
    expect(ranked.map((row) => stringField(row, "type"))).toEqual([
      "broken-links",
      "noindex-important",
      "slow-ttfb",
      "missing-alt",
    ]);
    const synthesis = steps.find((step) => step.seq === 2);
    expect(evidenceTypeOf(synthesis?.evidenceJson ?? null)).toBe(
      "observational",
    );
    expect(synthesis?.toolCalls).toBe(1);
    expect(
      Object.keys(recordField(synthesis?.evidenceJson ?? null, "facts")),
    ).toContain("rankedIssues");
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
    }
  });

  it("ranks technical opportunities and echoes coverage into correlate", async () => {
    vi.spyOn(OpportunityRepository, "listActiveByProject").mockImplementation(
      async () => [
        makeOpportunity({
          id: "tech-high",
          logicalKey: "technical_on_important_page:/pricing",
          type: "technical_on_important_page",
          detectorKey: "technical_on_important_page",
          priority: "High",
          impactScore: 70,
          confidenceScore: 60,
          title: "Pricing has critical issues",
          page: "/pricing",
          keyword: null,
        }),
        makeOpportunity({
          id: "content-high",
          logicalKey: "content_decay:/blog",
          type: "content_decay",
          detectorKey: "content_decay",
          priority: "Critical",
          impactScore: 95,
          confidenceScore: 95,
          title: "Blog decayed",
          page: "/blog",
          keyword: null,
        }),
        makeOpportunity({
          id: "tech-med",
          logicalKey: "technical_on_important_page:/about",
          type: "technical_on_important_page",
          detectorKey: "technical_on_important_page",
          priority: "Medium",
          impactScore: 40,
          confidenceScore: 50,
          title: "About has warnings",
          page: "/about",
          keyword: null,
        }),
      ],
    );
    vi.spyOn(InsightRepository, "listUnresolvedByProject").mockImplementation(
      async () => [] as InsightRow[],
    );
    vi.spyOn(
      AuditRepository,
      "getLatestAuditForProject",
    ).mockImplementation(async () => makeAudit({ pagesCrawled: 10 }));
    vi.spyOn(
      auditSummaryQueries,
      "getIssueTypePageCountsForAudit",
    ).mockImplementation(async () => []);
    const { status, steps } = await driveTechnicalSeo();
    expect(status).toBe("completed");
    const correlate = steps.find((step) => step.seq === 1);
    expect(
      stringListOf(correlate?.evidenceJson ?? null, "rankedOpportunityIds"),
    ).toEqual(["tech-high", "tech-med"]);
    expect(
      recordField(correlate?.evidenceJson ?? null, "auditCoverage"),
    ).toEqual({
      state: "ready",
      auditId: "audit-1",
      pagesCrawled: 10,
      completedAt: "2026-09-20T00:00:00.000Z",
    });
  });
});
