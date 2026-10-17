// Spec 014 (T018) — server-function authorization + response-shaping tests
// for the competitor-gap spike surface. Mirrors the intelligence
// authorization-test harness: wrong-organization access is rejected before
// any spike work runs; response shaping is covered via the pure mappers.

import type { AsyncLocalStorage } from "node:async_hooks";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  projectLookup: vi.fn(),
  resolveUser: vi.fn(),
  runSpike: vi.fn(),
  gateState: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {},
  waitUntil: vi.fn(),
}));

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: () =>
    new Request("https://openseo.test/_server", { method: "POST" }),
}));

vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUser,
}));

vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.projectLookup,
  },
}));

vi.mock("@/server/lib/competitor-gap/spikeHarness", () => ({
  runSpike: mocks.runSpike,
  SpikeBudgetExceededError: class SpikeBudgetExceededError extends Error {
    constructor(
      readonly budgetCapCredits: number,
      readonly projectedCredits: number,
    ) {
      super("SPIKE_BUDGET_EXCEEDED");
      this.name = "SpikeBudgetExceededError";
    }
  },
}));

vi.mock("@/server/lib/competitor-gap/verdictLedger", () => ({
  competitorGapGateState: mocks.gateState,
}));

import {
  getCompetitorGapVerdict,
  runCompetitorGapSpike,
  toSpikeTriggerResponse,
  toVerdictStatusResponse,
} from "./competitorGap";
import { globalServerFunctionMiddleware } from "./middleware";
import type { CompetitorGapVerdictRow } from "@/shared/competitorGap";

type ServerFunction = {
  __executeServer(input: {
    method: "POST";
    data: Record<string, unknown>;
    context: Record<string, never>;
  }): Promise<unknown>;
};

type StartStorage = AsyncLocalStorage<{
  getRouter: () => never;
  request: Request;
  startOptions: { functionMiddleware: typeof globalServerFunctionMiddleware };
  contextAfterGlobalMiddlewares: Record<string, never>;
  executedRequestMiddlewares: Set<unknown>;
  handlerType: "serverFn";
}>;

async function executeServerFunction(
  serverFunction: ServerFunction,
  data: Record<string, unknown>,
) {
  const storage = (
    globalThis as typeof globalThis & {
      [key: symbol]: StartStorage | undefined;
    }
  )[Symbol.for("tanstack-start:start-storage-context")];

  if (!storage) throw new Error("TanStack Start test context is unavailable");

  return storage.run(
    {
      getRouter: () => {
        throw new Error("Router is not used by this server-function test");
      },
      request: new Request("https://openseo.test/_server", {
        method: "POST",
      }),
      startOptions: { functionMiddleware: globalServerFunctionMiddleware },
      contextAfterGlobalMiddlewares: {},
      executedRequestMiddlewares: new Set(),
      handlerType: "serverFn",
    },
    () => serverFunction.__executeServer({ method: "POST", data, context: {} }),
  );
}

const SPIKE_INPUT = {
  projectId: "other-project",
  sampleDomains: ["competitor-a.com"],
  keywordSetRef: "kw-set-1",
  market: { locationCode: 2840, languageCode: "en" },
  budgetCapCredits: 100,
  timeBoxHours: 4,
  thresholds: {
    minKeywordCoverageRatio: 0.5,
    minFirstPartyCoverageRatio: 0.5,
    maxCostPerAnalysisCredits: 100,
    repeatCacheHitRate: 1.0,
    identityCollisionsAllowed: 0,
  },
};

function verdictRowFixture(
  overrides: Partial<CompetitorGapVerdictRow> = {},
): CompetitorGapVerdictRow {
  return {
    id: "cgv_row_1",
    organizationId: "org-1",
    projectId: "project-1",
    verdict: "COMPETITOR_GAP_READY",
    evidence: {
      quality: {
        status: "measured",
        value: { keywordCoverageRatio: 0.9, requiredFieldMissingRate: 0 },
      },
      coverage: {
        status: "measured",
        value: {
          firstPartyCoverageRatio: 0.9,
          window: { from: "2026-09-11", to: "2026-10-09" },
        },
      },
      cost: {
        status: "measured",
        value: {
          measuredCreditsPerAnalysis: 10,
          extrapolatedMonthlyPerProject: 40,
        },
      },
      identity: {
        status: "measured",
        value: { collisionsObserved: 0, nonDeterministicMappings: 0 },
      },
      cache: {
        status: "measured",
        value: { repeatAnalysisPaidCalls: 0, repeatCacheHitRate: 1 },
      },
    },
    thresholds: SPIKE_INPUT.thresholds,
    inputManifest: {
      organizationId: "org-1",
      projectId: "project-1",
      sampleDomains: ["competitor-a.com"],
      keywordSetRef: "kw-set-1",
      market: { locationCode: 2840, languageCode: "en" },
      budgetCapCredits: 100,
      timeBoxHours: 4,
      thresholds: SPIKE_INPUT.thresholds,
    },
    recordedAt: "2026-10-09T12:00:00.000Z",
    ...overrides,
  };
}

describe("competitor-gap server-function project authorization", () => {
  beforeEach(() => {
    mocks.resolveUser.mockResolvedValue({
      userId: "user-1",
      userEmail: "owner@example.com",
      emailVerified: true,
      organizationId: "organization-1",
    });
    mocks.projectLookup.mockResolvedValue(null);
    mocks.runSpike.mockReset();
    mocks.gateState.mockReset();
  });

  it.each([
    ["runCompetitorGapSpike", runCompetitorGapSpike],
    ["getCompetitorGapVerdict", getCompetitorGapVerdict],
  ])("rejects unauthenticated access before %s runs", async (_name, fn) => {
    mocks.resolveUser.mockRejectedValue(new Error("UNAUTHENTICATED"));

    const result = await executeServerFunction(fn, SPIKE_INPUT);

    expect(result).toMatchObject({ error: new Error("UNAUTHENTICATED") });
    expect(mocks.runSpike).not.toHaveBeenCalled();
    expect(mocks.gateState).not.toHaveBeenCalled();
  });

  it.each([
    ["runCompetitorGapSpike", runCompetitorGapSpike],
    ["getCompetitorGapVerdict", getCompetitorGapVerdict],
  ])("rejects wrong-organization access before %s runs", async (_name, fn) => {
    const result = await executeServerFunction(fn, SPIKE_INPUT);

    expect(result).toMatchObject({ error: new Error("NOT_FOUND") });
    expect(mocks.runSpike).not.toHaveBeenCalled();
    expect(mocks.gateState).not.toHaveBeenCalled();
  });

  it("shapes the trigger response for READY verdicts and budget refusal", () => {
    expect(
      toSpikeTriggerResponse({ ok: true, row: verdictRowFixture() }),
    ).toMatchObject({
      ok: true,
      verdict: "COMPETITOR_GAP_READY",
      verdictId: "cgv_row_1",
    });

    expect(
      toSpikeTriggerResponse({
        ok: false,
        budgetExceeded: true,
        message: "SPIKE_BUDGET_EXCEEDED",
      }),
    ).toMatchObject({ ok: false, budgetExceeded: true });
  });

  it("shapes the verdict poll for NO_VERDICT, BLOCKED, and READY", () => {
    expect(toVerdictStatusResponse(null)).toMatchObject({
      verdict: null,
      gateState: "NO_VERDICT",
    });

    expect(
      toVerdictStatusResponse(
        verdictRowFixture({ verdict: "COMPETITOR_GAP_BLOCKED" }),
      ),
    ).toMatchObject({
      verdict: "COMPETITOR_GAP_BLOCKED",
      gateState: "BLOCKED",
    });

    const ready = toVerdictStatusResponse(verdictRowFixture());
    expect(ready).toMatchObject({
      verdict: "COMPETITOR_GAP_READY",
      gateState: "READY",
      verdictId: "cgv_row_1",
    });
    expect(ready).toHaveProperty("evidence");
    expect(ready).toHaveProperty("thresholds");
  });
});
