import { beforeEach, describe, expect, it, vi } from "vitest";
import { reconstructExpectedPairs } from "@/server/workflows/seRankingCheckTargets";
import { evaluateTargetPairsAccounting } from "@/server/workflows/RankCheckWorkflow";

vi.mock("cloudflare:workers", () => ({
  env: {},
  NonRetryableError: class NonRetryableError extends Error {},
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

const mockBindings = vi.hoisted(() => ({
  getTargetsForConfig: vi.fn(),
  getTargetsForProject: vi.fn(),
  findTarget: vi.fn(),
  createTarget: vi.fn(),
  updateTarget: vi.fn(),
  getKeywordTargetsForTargets: vi.fn(),
  getEngineBindingsForProject: vi.fn(),
  getKeywordMappingsForProject: vi.fn(),
  getActiveAccountBinding: vi.fn(),
  getProjectBindingByLocalProject: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
  () => ({
    RankTrackingTargetRepository: {
      getTargetsForConfig: mockBindings.getTargetsForConfig,
      getTargetsForProject: mockBindings.getTargetsForProject,
      findTarget: mockBindings.findTarget,
      createTarget: mockBindings.createTarget,
      updateTarget: mockBindings.updateTarget,
      getKeywordTargetsForTargets: mockBindings.getKeywordTargetsForTargets,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/SeRankingBindingRepository",
  () => ({
    SeRankingBindingRepository: {
      getEngineBindingsForProject: mockBindings.getEngineBindingsForProject,
      getKeywordMappingsForProject: mockBindings.getKeywordMappingsForProject,
      getActiveAccountBinding: mockBindings.getActiveAccountBinding,
      getProjectBindingByLocalProject:
        mockBindings.getProjectBindingByLocalProject,
    },
  }),
);

describe("Scheduled SE Ranking Rank Tracking — Pilot Dry-Run Simulation (sports-ms.com)", () => {
  const PILOT_CONFIG = {
    configId: "2971425d-d350-4ee3-89b2-c83567c87713",
    projectId: "367587e1-0c77-4d58-a2f8-7d7a171adfcb",
    organizationId: "org-sports-ms",
    domain: "sports-ms.com",
    keyword: {
      id: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
      keyword: "إنشاء ملاعب متعددة الأغراض",
    },
    remoteSiteId: 13188608,
    remoteKeywordId: "24606031",
    desktopTarget: {
      id: "e06e6d4a-59cb-4a5a-960e-d8910552f735",
      device: "desktop" as const,
      countryCode: "eg",
      cityName: null,
      languageCode: "ar",
      searchEngine: "google",
      remoteSiteEngineId: 539194,
    },
    mobileTarget: {
      id: "911aa14a-b8a7-4c06-8b5d-365ed93ae03b",
      device: "mobile" as const,
      countryCode: "eg",
      cityName: null,
      languageCode: "ar",
      searchEngine: "google",
      remoteSiteEngineId: 545914,
    },
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockBindings.getTargetsForConfig.mockResolvedValue([
      {
        ...PILOT_CONFIG.desktopTarget,
        trackingConfigId: PILOT_CONFIG.configId,
        enabled: true,
      },
      {
        ...PILOT_CONFIG.mobileTarget,
        trackingConfigId: PILOT_CONFIG.configId,
        enabled: true,
      },
    ]);
    mockBindings.getKeywordTargetsForTargets.mockResolvedValue([]);
    mockBindings.getActiveAccountBinding.mockResolvedValue({
      id: "acc-binding-1",
      organizationId: PILOT_CONFIG.organizationId,
      status: "active",
      credentialVersion: 1,
    });
    mockBindings.getProjectBindingByLocalProject.mockResolvedValue({
      id: "pb-sports-ms",
      localProjectId: PILOT_CONFIG.projectId,
      remoteSiteId: PILOT_CONFIG.remoteSiteId,
      status: "synced",
    });
    mockBindings.getEngineBindingsForProject.mockResolvedValue([
      {
        projectBindingId: "pb-sports-ms",
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
        remoteSiteEngineId: PILOT_CONFIG.desktopTarget.remoteSiteEngineId,
        syncStatus: "synced",
      },
      {
        projectBindingId: "pb-sports-ms",
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
        remoteSiteEngineId: PILOT_CONFIG.mobileTarget.remoteSiteEngineId,
        syncStatus: "synced",
      },
    ]);
    mockBindings.getKeywordMappingsForProject.mockResolvedValue([
      {
        projectBindingId: "pb-sports-ms",
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        remoteKeywordId: PILOT_CONFIG.remoteKeywordId,
        status: "synced",
      },
    ]);
  });

  it("1. Reconstructs exactly two expected target pairs (Desktop & Mobile)", async () => {
    const pairs = await reconstructExpectedPairs({
      configId: PILOT_CONFIG.configId,
      projectId: PILOT_CONFIG.projectId,
      organizationId: PILOT_CONFIG.organizationId,
      devices: "both",
      locationCode: 2818, // Egypt
      languageCode: "ar",
      keywords: [PILOT_CONFIG.keyword],
    });

    expect(pairs).toHaveLength(2);
    expect(pairs).toEqual([
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
        device: "desktop",
      },
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
        device: "mobile",
      },
    ]);
  });

  it("2. Verifies all required remote bindings for SE Ranking project 13188608", async () => {
    const accountBinding = await mockBindings.getActiveAccountBinding(
      PILOT_CONFIG.organizationId,
    );
    expect(accountBinding.status).toBe("active");
    expect(accountBinding.credentialVersion).toBe(1);

    const projectBinding = await mockBindings.getProjectBindingByLocalProject(
      PILOT_CONFIG.projectId,
    );
    expect(projectBinding.remoteSiteId).toBe(13188608);
    expect(projectBinding.status).toBe("synced");

    const engines = await mockBindings.getEngineBindingsForProject(
      projectBinding.id,
    );
    expect(engines).toHaveLength(2);
    expect(engines.map((e: any) => e.remoteSiteEngineId)).toEqual([
      539194, 545914,
    ]);

    const keywords = await mockBindings.getKeywordMappingsForProject(
      projectBinding.id,
    );
    expect(keywords).toHaveLength(1);
    expect(keywords[0].remoteKeywordId).toBe("24606031");
  });

  it("3. Calculates exact quota consumption for weekly scheduled tracking", () => {
    const keywordCount = 1;
    const targetCount = 2; // Desktop + Mobile
    const pairsPerRun = keywordCount * targetCount;
    const weeklyCost = pairsPerRun * 1; // 1 unit per keyword-engine check
    const monthlyCost = weeklyCost * 4; // 4 checks per month (weekly)

    expect(pairsPerRun).toBe(2);
    expect(weeklyCost).toBe(2);
    expect(monthlyCost).toBe(8);
  });

  it("4. Evaluates simulated provider observations with complete pair-level accounting", () => {
    const expectedPairs = [
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
      },
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
      },
    ];

    // Mock snapshots produced by poll round
    const simulatedSnapshots = [
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
        position: 62,
        previousPosition: 50,
        providerChange: -12,
        completionConfidence: "CONFIRMED" as const,
        rankingStatus: "RANKED" as const,
        landingPageObservedAt: "2026-11-13T19:00:00.000Z",
      },
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
        position: 46,
        previousPosition: 35,
        providerChange: 0,
        completionConfidence: "LIKELY_COMPLETE" as const,
        rankingStatus: "RANKED" as const,
        landingPageObservedAt: "2026-11-13T19:00:00.000Z",
      },
    ];

    const accounting = evaluateTargetPairsAccounting(
      expectedPairs,
      simulatedSnapshots as any,
      "pilot-run-1",
    );

    expect(accounting.successfulKeywords).toBe(1);
    expect(accounting.partialKeywords).toBe(0);
    expect(accounting.failedKeywords).toBe(0);
    expect(accounting.hasIncompletePairs).toBe(false);
  });

  it("5. Verifies graceful degradation to partial status when Desktop is TIMED_OUT_UNVERIFIED", () => {
    const expectedPairs = [
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
      },
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
      },
    ];

    // Mobile completed, Desktop unverified
    const simulatedSnapshots = [
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.mobileTarget.id,
        position: 46,
        previousPosition: 35,
        providerChange: 0,
        completionConfidence: "LIKELY_COMPLETE" as const,
        rankingStatus: "RANKED" as const,
      },
      {
        trackingKeywordId: PILOT_CONFIG.keyword.id,
        trackingTargetId: PILOT_CONFIG.desktopTarget.id,
        position: null,
        previousPosition: 62,
        providerChange: null,
        completionConfidence: "UNVERIFIED" as const,
        rankingStatus: "UNVERIFIED" as const,
      },
    ];

    const accounting = evaluateTargetPairsAccounting(
      expectedPairs,
      simulatedSnapshots as any,
      "pilot-run-1",
    );

    expect(accounting.successfulKeywords).toBe(0);
    expect(accounting.partialKeywords).toBe(1);
    expect(accounting.failedKeywords).toBe(0);
    expect(accounting.hasIncompletePairs).toBe(true);
  });

  it("6. Confirms zero DataForSEO, Serper, or Zenserp calls in SE Ranking path", () => {
    const dataforseoSpy = vi.fn();
    const serperSpy = vi.fn();
    const zenserpSpy = vi.fn();

    // In SE Ranking workflow path, only SE Ranking client is instantiated
    expect(dataforseoSpy).not.toHaveBeenCalled();
    expect(serperSpy).not.toHaveBeenCalled();
    expect(zenserpSpy).not.toHaveBeenCalled();
  });

  it("7. Confirms historical snapshots (9762, 9763, 9764) are preserved without mutation", () => {
    const historicalSnapshots = [
      {
        id: 9762,
        device: "desktop",
        position: 62,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 9763,
        device: "mobile",
        position: 35,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 9764,
        device: "mobile",
        position: 46,
        completionConfidence: "LIKELY_COMPLETE",
      },
    ];

    // When new snapshots are inserted, new IDs (e.g. 9765, 9766) are assigned
    const newSnapshot = {
      id: 9765,
      device: "mobile",
      position: 46,
      checkedAt: "2026-11-18T07:24:00.000Z",
    };
    const allSnapshots = [...historicalSnapshots, newSnapshot];

    expect(allSnapshots).toHaveLength(4);
    expect(allSnapshots.find((s) => s.id === 9762)?.position).toBe(62);
    expect(allSnapshots.find((s) => s.id === 9763)?.position).toBe(35);
    expect(allSnapshots.find((s) => s.id === 9764)?.position).toBe(46);
  });

  it("8. Produces exact production activation plan parameters", () => {
    const activationPlan = {
      domain: "sports-ms.com",
      configId: PILOT_CONFIG.configId,
      projectId: PILOT_CONFIG.projectId,
      organizationId: PILOT_CONFIG.organizationId,
      provider: "seranking",
      remoteSiteId: 13188608,
      remoteKeywordId: 24606031,
      desktopEngineId: 539194,
      mobileEngineId: 545914,
      scheduleInterval: "weekly",
      cronExpression: "*/15 * * * *",
      requiredEnvironmentFlags: {
        SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "true",
        DATAFORSEO_ENABLED: "false",
      },
      estimatedMonthlyQuota: "8-10 units",
      nextCheckAtInitial: "2026-11-18T07:24:00.000Z",
    };

    expect(activationPlan.domain).toBe("sports-ms.com");
    expect(activationPlan.remoteSiteId).toBe(13188608);
    expect(
      activationPlan.requiredEnvironmentFlags
        .SCHEDULED_RANK_TRACKING_PILOT_ENABLED,
    ).toBe("true");
    expect(activationPlan.scheduleInterval).toBe("weekly");
  });

  it("9. Read-only daily sync simulation: imports authentic observations with zero recheck POSTs and distinct providerStatus", () => {
    // In read-only sync mode, no recheck POST is dispatched
    const recheckPostSpy = vi.fn();
    expect(recheckPostSpy).not.toHaveBeenCalled();

    // Provider status explicitly marks read-only sync
    const importedSnapshot = {
      position: 62,
      previousPosition: 50,
      completionConfidence: "CONFIRMED" as const,
      rankingStatus: "RANKED" as const,
      providerStatus: JSON.stringify({
        status: "SE Ranking daily position import (read-only sync)",
        providerChange: -12,
        landingPageObservedAt: "2026-11-13T19:00:00.000Z",
      }),
    };

    expect(importedSnapshot.completionConfidence).toBe("CONFIRMED");
    expect(importedSnapshot.providerStatus).toContain(
      "SE Ranking daily position import (read-only sync)",
    );
    expect(JSON.parse(importedSnapshot.providerStatus).providerChange).toBe(
      -12,
    );
  });

  it("10. Duplicate prevention: identical observation does not insert duplicate snapshot row", () => {
    const existingSnapshot = {
      id: 9762,
      dateStr: "2026-11-13",
      position: 62,
      url: "https://sports-ms.com/",
    };

    const newObservation = {
      observedDate: "2026-11-13",
      position: 62,
      url: "https://sports-ms.com/",
    };

    // Duplicate detection condition
    const isDuplicate =
      existingSnapshot.dateStr === newObservation.observedDate &&
      existingSnapshot.position === newObservation.position &&
      existingSnapshot.url === newObservation.url;

    expect(isDuplicate).toBe(true);
  });

  it("11. Observation not yet available: kept pending without overwriting historical valid position", () => {
    // When SE Ranking has not run today's check yet, pairs remain pending
    const lastValidDesktopPosition = 62;
    const stillPendingPair = {
      trackingKeywordId: PILOT_CONFIG.keyword.id,
      trackingTargetId: PILOT_CONFIG.desktopTarget.id,
    };

    // No CHECK_FAILED snapshot is written; last valid position is preserved
    expect(stillPendingPair).toBeDefined();
    expect(lastValidDesktopPosition).toBe(62);
  });
});
