import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeRankingLib from "@/server/lib/seranking";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const repoMocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  updateRun: vi.fn(),
  insertSnapshots: vi.fn(),
  insertProviderCalls: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  getLatestPositionsMap: vi.fn(),
}));

const targetRepoMocks = vi.hoisted(() => ({
  getTargetsForConfig: vi.fn(),
  getTargetsForProject: vi.fn(),
  findTarget: vi.fn(),
  createTarget: vi.fn(),
  updateTarget: vi.fn(),
  getKeywordTargetsForTargets: vi.fn(),
}));

const bindingRepoMocks = vi.hoisted(() => ({
  getKeywordMappingsForProject: vi.fn(),
  getEngineBindingsForProject: vi.fn(),
  updateProjectBinding: vi.fn(),
}));

const syncServiceMocks = vi.hoisted(() => ({
  ensureProject: vi.fn(),
  ensureSearchEngines: vi.fn(),
  syncTrackedKeywords: vi.fn(),
}));

const projectServiceMocks = vi.hoisted(() => ({
  recheckPositions: vi.fn(),
  getCheckDates: vi.fn(),
  getPositions: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
  () => ({ RankTrackingTargetRepository: targetRepoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/SeRankingBindingRepository",
  () => ({ SeRankingBindingRepository: bindingRepoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/services/SeRankingProjectSyncService",
  () => ({ SeRankingProjectSyncService: syncServiceMocks }),
);
vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<typeof SeRankingLib>();
  return {
    ...actual,
    createSeRankingClient: vi.fn(() => ({ request: vi.fn() })),
    SeRankingProjectService: projectServiceMocks,
  };
});
vi.mock("@/server/workflows/pgStep", () => ({
  pgStep: async (
    _step: unknown,
    _name: string,
    _opts: unknown,
    fn: () => Promise<unknown>,
  ) => fn(),
}));

import { toDeviceResult } from "@/server/features/rank-tracking/services/rankTrackingResults";
import { runSeRankingCheck } from "./seRankingCheckExecution";

describe("runSeRankingCheck - Durable Async Execution & Desktop/Mobile Parsing", () => {
  const today = new Date().toISOString().slice(0, 10);

  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.getRunById.mockResolvedValue({
      id: "run-async-1",
      status: "running",
    });
    repoMocks.getLatestPositionsMap.mockResolvedValue(
      new Map<string, number | null>([
        ["kw-1:desktop", 6],
        ["kw-1:mobile", 9],
      ]),
    );
    repoMocks.getSnapshotsForRun.mockResolvedValue([]);
    syncServiceMocks.ensureProject.mockResolvedValue({
      projectBinding: { id: "pb-1", remoteSiteId: 5001 },
      remoteSiteId: 5001,
    });
    targetRepoMocks.getTargetsForConfig.mockResolvedValue([
      {
        id: "t-eg-desk",
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        countryCode: "eg",
        regionCode: null,
        cityName: "Cairo",
        languageCode: "ar",
        device: "desktop",
        enabled: true,
      },
      {
        id: "t-eg-mob",
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        countryCode: "eg",
        regionCode: null,
        cityName: "Cairo",
        languageCode: "ar",
        device: "mobile",
        enabled: true,
      },
    ]);
    bindingRepoMocks.getEngineBindingsForProject.mockResolvedValue([
      {
        id: "eb-desk",
        projectBindingId: "pb-1",
        trackingTargetId: "t-eg-desk",
        remoteSiteEngineId: 1001,
      },
      {
        id: "eb-mob",
        projectBindingId: "pb-1",
        trackingTargetId: "t-eg-mob",
        remoteSiteEngineId: 1002,
      },
    ]);
    bindingRepoMocks.getKeywordMappingsForProject.mockResolvedValue([
      {
        id: "km-1",
        projectBindingId: "pb-1",
        trackingKeywordId: "kw-1",
        remoteKeywordId: "88001",
      },
      {
        id: "km-2",
        projectBindingId: "pb-1",
        trackingKeywordId: "kw-2",
        remoteKeywordId: "88002",
      },
    ]);
    targetRepoMocks.getKeywordTargetsForTargets.mockResolvedValue([]);
    projectServiceMocks.recheckPositions.mockResolvedValue({
      ok: true,
      status: "queued",
    });
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
  });

  it("polls asynchronously with step.sleep across Desktop & Mobile, normalizes pos=0 to NO_RESULT, and preserves prevPos", async () => {
    const stepMock = {
      sleep: vi.fn(async () => {}),
    } as any;

    let pollCall = 0;
    projectServiceMocks.getPositions.mockImplementation(
      async (_client, params) => {
        pollCall++;
        // Round 1 (first 2 calls for engine 1001 & 1002): Desktop completed, Mobile still pending!
        if (params.siteEngineId === 1001) {
          return [
            {
              id: "88001",
              keyword: "seo agency cairo",
              positions: [
                {
                  date: today,
                  pos: 4,
                  landing_pages: [{ url: "https://example.com/seo-cairo" }],
                },
              ],
              normalizedKeywordId: "88001",
              normalizedKeyword: "seo agency cairo",
              serpFeaturesList: ["sitelinks"],
            },
            {
              id: "88002",
              keyword: "unranked term",
              positions: [{ date: today, pos: 0 }],
              normalizedKeywordId: "88002",
              normalizedKeyword: "unranked term",
              serpFeaturesList: [],
            },
          ];
        }

        // Engine 1002 (Mobile): pending in round 0, completed in round 1!
        if (pollCall <= 2) {
          return [
            {
              id: "88001",
              keyword: "seo agency cairo",
              positions: [{ date: "2026-01-01", pos: 9 }], // old date only -> still pending today
              normalizedKeywordId: "88001",
              normalizedKeyword: "seo agency cairo",
              serpFeaturesList: [],
            },
          ];
        }

        return [
          {
            id: "88001",
            keyword: "seo agency cairo",
            positions: [
              { date: today, pos: 2, landing_page: "https://example.com/m" },
            ],
            normalizedKeywordId: "88001",
            normalizedKeyword: "seo agency cairo",
            serpFeaturesList: [],
          },
          {
            id: "88002",
            keyword: "unranked term",
            positions: [{ date: today, pos: 0 }],
            normalizedKeywordId: "88002",
            normalizedKeyword: "unranked term",
            serpFeaturesList: [],
          },
        ];
      },
    );

    const outcome = await runSeRankingCheck(stepMock, {
      runId: "run-async-1",
      projectId: "proj-1",
      configId: "cfg-1",
      domain: "example.com",
      billingCustomer: { organizationId: "org-1" } as any,
      keywords: [
        { id: "kw-1", keyword: "seo agency cairo" },
        { id: "kw-2", keyword: "unranked term" },
      ],
      devices: "both",
      locationCode: 2818,
      languageCode: "ar",
      locationName: "Cairo",
      apiKey: "test-key",
      pollIntervals: ["1 second", "1 second"],
    });

    expect(outcome.batchError).toBeNull();
    expect(outcome.checkedCount).toBe(4);
    expect(stepMock.sleep).toHaveBeenCalledTimes(2);

    // Check snapshots inserted across rounds
    const allInserted = repoMocks.insertSnapshots.mock.calls.flatMap(
      (call) => call[0] as any[],
    );
    expect(allInserted).toHaveLength(4);

    const kw1Desk = allInserted.find(
      (s) => s.trackingKeywordId === "kw-1" && s.device === "desktop",
    );
    expect(kw1Desk).toMatchObject({
      position: 4,
      previousPosition: 6,
      rankingStatus: "RANKED",
      provider: "seranking",
      countryCode: "eg",
      cityName: "Cairo",
      trackingTargetId: "t-eg-desk",
    });

    const kw2Desk = allInserted.find(
      (s) => s.trackingKeywordId === "kw-2" && s.device === "desktop",
    );
    // pos=0 must become null and NO_RESULT, NEVER 0/RANKED
    expect(kw2Desk).toMatchObject({
      position: null,
      rankingStatus: "NO_RESULT",
      provider: "seranking",
    });

    const kw1Mob = allInserted.find(
      (s) => s.trackingKeywordId === "kw-1" && s.device === "mobile",
    );
    expect(kw1Mob).toMatchObject({
      position: 2,
      previousPosition: 9,
      rankingStatus: "RANKED",
      trackingTargetId: "t-eg-mob",
    });
  });

  it("marks unfinished pairs as CHECK_FAILED when polling window closes rather than faking NO_RESULT", async () => {
    const stepMock = { sleep: vi.fn(async () => {}) } as any;
    projectServiceMocks.getPositions.mockResolvedValue([]); // never returns today's observation

    const outcome = await runSeRankingCheck(stepMock, {
      runId: "run-async-1",
      projectId: "proj-1",
      configId: "cfg-1",
      domain: "example.com",
      billingCustomer: { organizationId: "org-1" } as any,
      keywords: [{ id: "kw-1", keyword: "pending keyword" }],
      devices: "both",
      locationCode: 2818,
      languageCode: "ar",
      apiKey: "test-key",
      pollIntervals: ["1 second"],
    });

    expect(outcome.checkedCount).toBe(0);
    expect(outcome.batchError).toContain("polling window");

    const inserted = repoMocks.insertSnapshots.mock.calls[0]?.[0] as any[];
    expect(inserted).toHaveLength(2);
    expect(inserted.every((s) => s.rankingStatus === "CHECK_FAILED")).toBe(
      true,
    );
    expect(inserted.every((s) => s.position === null)).toBe(true);
  });

  it("halts polling immediately when run is cancelled", async () => {
    const stepMock = { sleep: vi.fn(async () => {}) } as any;
    // Active for dispatch check, then cancelled during sleep
    repoMocks.getRunById
      .mockResolvedValueOnce({ id: "run-async-1", status: "running" })
      .mockResolvedValueOnce({ id: "run-async-1", status: "running" })
      .mockResolvedValue({ id: "run-async-1", status: "cancelled" });

    const outcome = await runSeRankingCheck(stepMock, {
      runId: "run-async-1",
      projectId: "proj-1",
      configId: "cfg-1",
      domain: "example.com",
      billingCustomer: { organizationId: "org-1" } as any,
      keywords: [{ id: "kw-1", keyword: "seo agency cairo" }],
      devices: "both",
      locationCode: 2818,
      languageCode: "ar",
      apiKey: "test-key",
      pollIntervals: ["1 second", "1 second"],
    });

    expect(projectServiceMocks.getPositions).not.toHaveBeenCalled();
    expect(outcome.checkedCount).toBe(0);
    const inserted = repoMocks.insertSnapshots.mock.calls[0]?.[0] as any[];
    expect(inserted).toHaveLength(2);
    expect(inserted.every((s) => s.rankingStatus === "NOT_CHECKED")).toBe(true);
    expect(inserted.every((s) => s.position === null)).toBe(true);
  });

  it("uses GET /sites/check-dates to skip premature position reads while check date is pending, then collects observation", async () => {
    const stepMock = { sleep: vi.fn(async () => {}) } as any;
    let dateCall = 0;
    projectServiceMocks.getCheckDates.mockImplementation(async () => {
      dateCall++;
      // First engine check-dates call has only yesterday; subsequent rounds include today
      return dateCall <= 2 ? ["2026-01-01"] : ["2026-01-01", today];
    });
    projectServiceMocks.getPositions.mockResolvedValue([
      {
        id: "88001",
        keyword: "seo agency cairo",
        positions: [
          { date: today, pos: 5, landing_page: "https://example.com" },
        ],
        normalizedKeywordId: "88001",
        normalizedKeyword: "seo agency cairo",
        serpFeaturesList: [],
      },
    ]);

    const outcome = await runSeRankingCheck(stepMock, {
      runId: "run-async-1",
      projectId: "proj-1",
      configId: "cfg-1",
      domain: "example.com",
      billingCustomer: { organizationId: "org-1" } as any,
      keywords: [{ id: "kw-1", keyword: "seo agency cairo" }],
      devices: "both",
      locationCode: 2818,
      languageCode: "ar",
      apiKey: "test-key",
      pollIntervals: ["1 second", "1 second"],
    });

    expect(outcome.checkedCount).toBe(2);
    expect(projectServiceMocks.getCheckDates).toHaveBeenCalled();
    // Round 0 skipped getPositions completely until check-dates included today in round 1
    expect(projectServiceMocks.getPositions).toHaveBeenCalledTimes(2);
  });

  it("maps NOT_CHECKED snapshot status to 'not_checked' rather than 'not_ranking' in results", () => {
    const result = toDeviceResult(
      {
        id: 1,
        runId: "r1",
        trackingKeywordId: "kw-1",
        keyword: "seo",
        device: "desktop",
        position: null,
        previousPosition: 7,
        rankingStatus: "NOT_CHECKED",
        url: null,
        serpFeatures: null,
        provider: "seranking",
        providerStatus: "cancelled",
        providerStatusCode: null,
        errorMessage: "Cancelled",
        checkedAt: "2026-11-11T10:00:00Z",
      },
      7,
      7,
    );

    expect(result.status).toBe("not_checked");
    expect(result.rankingStatus).toBe("NOT_CHECKED");
    expect(result.latestValidPosition).toBe(7);
  });
});
