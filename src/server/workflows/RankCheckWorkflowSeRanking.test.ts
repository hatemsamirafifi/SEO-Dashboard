import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  NonRetryableError: class NonRetryableError extends Error {},
  // oxlint-disable-next-line typescript/no-extraneous-class -- mock base class must be constructible
  WorkflowEntrypoint: class WorkflowEntrypointMock {
    public readonly __mockEngine = true;
  },
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>) => fn(),
}));

const repoMocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  insertSnapshots: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  getConfigById: vi.fn(),
  updateConfig: vi.fn(),
}));

const pathsMocks = vi.hoisted(() => ({
  runLiveCheck: vi.fn(),
  runQueuedCheck: vi.fn(),
}));

const dataforseoMocks = vi.hoisted(() => ({
  createDataforseoClient: vi.fn(),
}));

const serpResolverMocks = vi.hoisted(() => ({
  createRankSerpResolver: vi.fn(),
}));

const seRankingConfigMocks = vi.hoisted(() => ({
  resolveEffectiveSeRankingConfig: vi.fn(),
}));

const seRankingExecutionMocks = vi.hoisted(() => ({
  runSeRankingCheck: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);
vi.mock("@/server/workflows/rankCheckPaths", () => pathsMocks);
vi.mock("@/server/lib/dataforseo", () => dataforseoMocks);
vi.mock("@/server/features/serp/providerResolver", () => serpResolverMocks);
vi.mock(
  "@/server/features/settings/services/SeRankingSettingsService",
  () => seRankingConfigMocks,
);
vi.mock(
  "@/server/workflows/seRankingCheckExecution",
  () => seRankingExecutionMocks,
);
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: async (
    _step: unknown,
    _name: string,
    _opts: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import { RankCheckWorkflow } from "./RankCheckWorkflow";

describe("RankCheckWorkflow - SE Ranking Execution", () => {
  const stepMock = {
    do: vi.fn(
      async (_name: string, _opts: unknown, fn: () => Promise<unknown>) => fn(),
    ),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes execution to runSeRankingCheck and NEVER invokes DataForSEO when SE Ranking is active", async () => {
    seRankingConfigMocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
      enabled: true,
      apiKey: "se-ranking-test-key",
      source: "project",
    });

    repoMocks.getConfigById.mockResolvedValue({
      id: "cfg-1",
      projectId: "proj-1",
      isActive: true,
    });

    repoMocks.getRunById.mockResolvedValue({
      id: "run-1",
      status: "pending",
      keywordsTotal: 2,
    });

    repoMocks.getKeywordsForConfig.mockResolvedValue([
      { id: "kw-1", keyword: "buy shoes" },
      { id: "kw-2", keyword: "running sneakers" },
    ]);

    seRankingExecutionMocks.runSeRankingCheck.mockResolvedValue({
      batchError: null,
      snapshotsCount: 4,
    });

    repoMocks.getSnapshotsForRun.mockResolvedValue([
      { trackingKeywordId: "kw-1", rankingStatus: "RANKED", rankPosition: 5 },
      { trackingKeywordId: "kw-2", rankingStatus: "RANKED", rankPosition: 12 },
    ]);

    const workflow = new RankCheckWorkflow({} as any, {} as any);

    const event = {
      payload: {
        runId: "run-1",
        configId: "cfg-1",
        billingCustomer: {
          organizationId: "org-1",
          projectId: "proj-1",
        },
        projectId: "proj-1",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "both",
        serpDepth: 100,
        trigger: "manual",
      },
    } as any;

    await workflow.run(event, stepMock);

    // 1. DataForSEO and Serper/Zenserp resolver must NOT be created
    expect(dataforseoMocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(serpResolverMocks.createRankSerpResolver).not.toHaveBeenCalled();

    // 2. Legacy check paths must NOT be called
    expect(pathsMocks.runLiveCheck).not.toHaveBeenCalled();
    expect(pathsMocks.runQueuedCheck).not.toHaveBeenCalled();

    // 3. SE Ranking execution must be called with accurate payload
    expect(seRankingExecutionMocks.runSeRankingCheck).toHaveBeenCalledWith(
      stepMock,
      expect.objectContaining({
        runId: "run-1",
        projectId: "proj-1",
        configId: "cfg-1",
        domain: "example.com",
        apiKey: "se-ranking-test-key",
      }),
    );

    // 4. Run must be finalized
    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run-1",
      expect.objectContaining({
        status: "completed",
        keywordsChecked: 2,
      }),
    );
  });

  it("never falls back to DataForSEO, Serper, or Zenserp when SE Ranking is selected without an API key", async () => {
    seRankingConfigMocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
      enabled: true,
      apiKey: undefined,
      source: "project",
    });

    repoMocks.getConfigById.mockResolvedValue({
      id: "cfg-1",
      projectId: "proj-1",
      isActive: true,
    });
    repoMocks.getRunById.mockResolvedValue({
      id: "run-missing-key",
      status: "pending",
      keywordsTotal: 1,
    });

    const workflow = new RankCheckWorkflow({} as any, {} as any);
    const event = {
      payload: {
        runId: "run-missing-key",
        configId: "cfg-1",
        billingCustomer: { organizationId: "org-1", projectId: "proj-1" },
        projectId: "proj-1",
        domain: "example.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "both",
        serpDepth: 100,
        trigger: "manual",
      },
    } as any;

    await expect(workflow.run(event, stepMock)).rejects.toThrow(
      "Will not fall back to DataForSEO, Serper, or Zenserp",
    );

    expect(dataforseoMocks.createDataforseoClient).not.toHaveBeenCalled();
    expect(serpResolverMocks.createRankSerpResolver).not.toHaveBeenCalled();
    expect(pathsMocks.runLiveCheck).not.toHaveBeenCalled();
    expect(pathsMocks.runQueuedCheck).not.toHaveBeenCalled();
  });
});
