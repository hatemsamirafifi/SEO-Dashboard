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
import * as reportSections from "@/server/features/reports/services/reportSections";
import { AutopilotBudgets } from "./autopilotBudgets";
import { driveRunToCompletion } from "./stepExecutor";
import {
  clearAutopilotWorkflows,
  getAutopilotWorkflow,
} from "./autopilotTypes";
import {
  buildChangedRows,
  deriveMonthWindows,
} from "./autopilotWorkflowContent";
import {
  containsBannedCausalVerb,
  containsUpliftPattern,
} from "./autopilotSerializer";
import { ensureAutopilotWorkflowsRegistered } from "./autopilotWorkflows";
import { resetAutopilotTestDb, setupAutopilotTestDb } from "./autopilotTestDb";
import {
  BILLING,
  fakeRunner,
  seedRun,
  sourceState,
} from "./autopilotTestFixtures";

type Visibility = Awaited<
  ReturnType<typeof reportSections.collectSearchVisibility>
>;
type Traffic = Awaited<
  ReturnType<typeof reportSections.collectTrafficAndConversions>
>;
type Overview = Awaited<
  ReturnType<typeof reportSections.collectOverviewParts>
>;
type StoredOpportunity = Awaited<
  ReturnType<typeof reportSections.collectOpportunities>
>[number];
type StoredInsight = Awaited<
  ReturnType<typeof reportSections.collectInsights>
>[number];

const ready = { available: true as const, reason: null };
const down = (reason: string) => ({ available: false as const, reason });

function searchVisibility(
  clicks: number,
  impressions: number,
  ctr: number,
  position: number,
): Visibility {
  return { status: ready, totals: { clicks, impressions, ctr, position } };
}

function trafficTotals(
  sessions: number,
  screenPageViews: number,
  keyEvents: number,
  transactions: number,
): Traffic {
  return {
    traffic: {
      status: ready,
      totals: {
        sessions,
        engagedSessions: sessions,
        screenPageViews,
        eventCount: sessions,
        newUsers: sessions,
        keyEvents,
        totalRevenue: 0,
        transactions,
      },
    },
    conversions: { status: ready, keyEvents, transactions },
  };
}

function overviewReady(): Overview {
  return {
    rankings: {
      status: ready,
      trackedKeywords: 10,
      improved: 2,
      declined: 1,
      top10: 5,
      lastCheckedAt: "2026-09-30T00:00:00.000Z",
    },
    technical: {
      status: ready,
      auditStatus: "completed",
      pagesCrawled: 5,
      topIssues: [],
    },
    backlinks: {
      status: ready,
      referringDomains: 12,
      capturedAt: "2026-09-30T00:00:00.000Z",
    },
  };
}

function openOpportunity(): StoredOpportunity {
  return {
    id: "opp-month",
    logicalKey: "ranking_drop:/pricing",
    type: "ranking_drop",
    status: "open",
    priority: "High",
    impactScore: 72,
    confidenceScore: 68,
    title: "Pricing lost rank",
    explanationFact: "Position moved down in the window",
    recommendation: "Inspect the page",
    completedAt: null,
  };
}

function openInsight(): StoredInsight {
  return {
    insightKey: "insight-month",
    type: "ranking_drop",
    detectorKey: "ranking_drop",
    severity: "high",
    title: "Pricing demand softened",
    explanationFact: "Clicks moved down in the window",
    recommendation: "Inspect the page",
    detectedAt: "2026-09-20T00:00:00.000Z",
    contentVersion: 1,
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

function summaryField(
  stepEvidenceJson: string | null,
  key: string,
): Record<string, unknown>[] {
  const summary = parseJsonObject(stepEvidenceJson ?? "null")["summary"];
  if (typeof summary !== "object" || summary === null) return [];
  const raw: unknown = (summary as Record<string, unknown>)[key];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry: unknown): entry is Record<string, unknown> =>
      typeof entry === "object" && entry !== null,
  );
}

function fieldOf(record: Record<string, unknown>, key: string): unknown {
  return record[key] ?? null;
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

// Spec 013 (US3 T015): deterministic UTC month windows.
describe("monthly review windows", () => {
  it("derives the previous complete UTC month and its predecessor", () => {
    expect(deriveMonthWindows(new Date("2026-10-04T12:00:00.000Z"))).toEqual({
      month: { from: "2026-09-01", to: "2026-09-30" },
      prior: { from: "2026-08-01", to: "2026-08-31" },
    });
  });

  it("rolls back across the year boundary", () => {
    expect(deriveMonthWindows(new Date("2026-01-15T00:00:00.000Z"))).toEqual({
      month: { from: "2025-12-01", to: "2025-12-31" },
      prior: { from: "2025-11-01", to: "2025-11-30" },
    });
  });

  it("handles leap-year February", () => {
    expect(deriveMonthWindows(new Date("2024-03-10T00:00:00.000Z"))).toEqual({
      month: { from: "2024-02-01", to: "2024-02-29" },
      prior: { from: "2024-01-01", to: "2024-01-31" },
    });
  });
});

// Spec 013 (US3 T016): envelope-aware comparison, additive deltas only.
describe("monthly changed rows", () => {
  it("differences additive metrics only when both windows are READY", () => {
    const out = buildChangedRows({
      searchVisibility: {
        month: searchVisibility(1000, 50000, 0.02, 8.5),
        prior: searchVisibility(1200, 48000, 0.025, 9.2),
      },
      traffic: {
        month: trafficTotals(5000, 12000, 300, 20),
        prior: trafficTotals(5500, 11000, 350, 18),
      },
    });
    const byMetric = new Map(out.changed.map((row) => [row.metric, row]));
    expect(byMetric.get("clicks")).toMatchObject({
      monthValue: 1000,
      priorValue: 1200,
      delta: -200,
    });
    expect(byMetric.get("impressions")).toMatchObject({ delta: 2000 });
    expect(byMetric.get("sessions")).toMatchObject({ delta: -500 });
    expect(byMetric.get("transactions")).toMatchObject({ delta: 2 });
    expect(byMetric.get("clicks")?.agreement).toBe("corroborated");
    expect(byMetric.get("sessions")?.agreement).toBe("corroborated");
    expect(out.ratios).toEqual([
      { metric: "ctr", monthValue: 0.02, priorValue: 0.025 },
      { metric: "position", monthValue: 8.5, priorValue: 9.2 },
    ]);
    expect(out.unavailable).toEqual([]);
  });

  it("marks lone movers provisional and lists unavailable sources", () => {
    const downTraffic: Traffic = {
      traffic: { status: down("no_coverage"), totals: null },
      conversions: {
        status: down("no_coverage"),
        keyEvents: null,
        transactions: null,
      },
    };
    const out = buildChangedRows({
      searchVisibility: {
        month: searchVisibility(1000, 50000, 0.02, 8.5),
        prior: searchVisibility(1200, 48000, 0.025, 9.2),
      },
      traffic: { month: trafficTotals(5000, 11000, 300, 20), prior: downTraffic },
    });
    const byMetric = new Map(out.changed.map((row) => [row.metric, row]));
    // Only GSC compares: each direction is unique, so both stay provisional.
    expect(byMetric.get("clicks")).toMatchObject({
      delta: -200,
      agreement: "single_source",
    });
    expect(byMetric.get("impressions")).toMatchObject({
      delta: 2000,
      agreement: "single_source",
    });
    // GA4 had no prior coverage: unavailable rows, never zero-deltas.
    expect(byMetric.has("sessions")).toBe(false);
    expect(byMetric.has("keyEvents")).toBe(false);
    expect(byMetric.has("transactions")).toBe(false);
    expect(out.unavailable.length).toBeGreaterThan(0);
    expect(
      out.unavailable.every(
        (row) => typeof row.source === "string" && typeof row.reason === "string",
      ),
    ).toBe(true);
  });
});

// Spec 013 (US3 T017): end-to-end drives with mocked collectors.
describe("monthly_review workflow", () => {
  it("registers monthly_review with collect/correlate/synthesize seqs", () => {
    const def = getAutopilotWorkflow("monthly_review");
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

  it("summarizes a two-window month with honest envelopes", async () => {
    vi.spyOn(
      reportSections,
      "collectSearchVisibility",
    ).mockImplementation(async (_projectId, from) =>
      from.startsWith("2026-09")
        ? searchVisibility(1000, 50000, 0.02, 8.5)
        : searchVisibility(1200, 48000, 0.025, 9.2),
    );
    vi.spyOn(
      reportSections,
      "collectTrafficAndConversions",
    ).mockImplementation(async (_projectId, _orgId, from) =>
      from.startsWith("2026-09")
        ? trafficTotals(5000, 11000, 300, 20)
        : trafficTotals(5500, 11000, 350, 18),
    );
    vi.spyOn(reportSections, "collectOverviewParts").mockImplementation(
      async () => overviewReady(),
    );
    vi.spyOn(reportSections, "collectInsights").mockImplementation(
      async () => [openInsight()],
    );
    vi.spyOn(reportSections, "collectOpportunities").mockImplementation(
      async () => [openOpportunity()],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("monthly_review");
    if (!workflow) throw new Error("monthly_review was not registered");
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
    const evidence = synthesis?.evidenceJson ?? null;
    expect(parseJsonObject(evidence ?? "null")["evidenceType"]).toBe(
      "observational",
    );
    expect(synthesis?.toolCalls).toBe(1);
    const changed = summaryField(evidence, "changed");
    const clicks = changed.find((row) => row["metric"] === "clicks");
    expect(clicks ? fieldOf(clicks, "delta") : null).toBe(-200);
    const pageViews = changed.find((row) => row["metric"] === "pageViews");
    expect(pageViews ? fieldOf(pageViews, "delta") : null).toBe(0);
    expect(pageViews ? fieldOf(pageViews, "agreement") : null).toBe(
      "single_source",
    );
    expect(summaryField(evidence, "unresolved").length).toBeGreaterThan(0);
    expect(summaryField(evidence, "nextActions")).toHaveLength(2);
    const text = JSON.stringify(parseJsonObject(evidence ?? "null"));
    expect(containsBannedCausalVerb(text)).toBe(false);
    expect(containsUpliftPattern(text)).toBe(false);
  });

  it("completes honestly for a project with no stored data", async () => {
    vi.spyOn(
      reportSections,
      "collectSearchVisibility",
    ).mockImplementation(async () => ({
      status: down("not_connected"),
      totals: null,
    }));
    vi.spyOn(
      reportSections,
      "collectTrafficAndConversions",
    ).mockImplementation(async () => ({
      traffic: { status: down("not_connected"), totals: null },
      conversions: {
        status: down("not_connected"),
        keyEvents: null,
        transactions: null,
      },
    }));
    vi.spyOn(reportSections, "collectOverviewParts").mockImplementation(
      async () => ({
        rankings: {
          status: down("no_data"),
          trackedKeywords: null,
          improved: null,
          declined: null,
          top10: null,
          lastCheckedAt: null,
        },
        technical: {
          status: down("no_data"),
          auditStatus: null,
          pagesCrawled: null,
          topIssues: null,
        },
        backlinks: {
          status: down("no_data"),
          referringDomains: null,
          capturedAt: null,
        },
      }),
    );
    vi.spyOn(reportSections, "collectInsights").mockImplementation(
      async () => [],
    );
    vi.spyOn(reportSections, "collectOpportunities").mockImplementation(
      async () => [],
    );
    const runId = await seedRun();
    const workflow = getAutopilotWorkflow("monthly_review");
    if (!workflow) throw new Error("monthly_review was not registered");
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
    const evidence = steps.find((step) => step.seq === 2)?.evidenceJson ?? null;
    expect(summaryField(evidence, "changed")).toEqual([]);
    expect(summaryField(evidence, "unresolved")).toEqual([]);
    expect(summaryField(evidence, "nextActions")).toEqual([]);
    expect(summaryField(evidence, "unavailable").length).toBeGreaterThan(0);
  });
});
