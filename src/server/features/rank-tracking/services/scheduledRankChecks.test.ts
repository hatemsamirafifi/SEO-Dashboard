import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_IDS,
  APPROVED_PILOT_PROJECT_ID,
  runScheduledRankChecks,
} from "./scheduledRankChecks";

const mocks = vi.hoisted(() => ({
  getDueConfigsWithOrganization: vi.fn(),
  getKeywordCountForConfig: vi.fn(),
  updateConfig: vi.fn(),
  countRunsForOrgSince: vi.fn(),
  countRunsForProjectSince: vi.fn(),
  countPersistedPairsForOrgSince: vi.fn(),
  countPersistedPairsForProjectSince: vi.fn(),
  countInFlightReservedPairsForOrg: vi.fn(),
  countInFlightReservedPairsForProject: vi.fn(),
  getLatestScheduledRunForConfig: vi.fn(),
  getTargetsForConfig: vi.fn(),
  getActiveAccountBinding: vi.fn(),
  getProjectBindingByLocalProject: vi.fn(),
  customerHasPaidPlan: vi.fn(),
  isHostedServerAuthMode: vi.fn(),
  beginRankCheckRun: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getDueConfigsWithOrganization: mocks.getDueConfigsWithOrganization,
      getKeywordCountForConfig: mocks.getKeywordCountForConfig,
      updateConfig: mocks.updateConfig,
      countRunsForOrgSince: mocks.countRunsForOrgSince,
      countRunsForProjectSince: mocks.countRunsForProjectSince,
      countPersistedPairsForOrgSince: mocks.countPersistedPairsForOrgSince,
      countPersistedPairsForProjectSince:
        mocks.countPersistedPairsForProjectSince,
      countInFlightReservedPairsForOrg: mocks.countInFlightReservedPairsForOrg,
      countInFlightReservedPairsForProject:
        mocks.countInFlightReservedPairsForProject,
      getLatestScheduledRunForConfig: mocks.getLatestScheduledRunForConfig,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
  () => ({
    RankTrackingTargetRepository: {
      getTargetsForConfig: mocks.getTargetsForConfig,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/SeRankingBindingRepository",
  () => ({
    SeRankingBindingRepository: {
      getActiveAccountBinding: mocks.getActiveAccountBinding,
      getProjectBindingByLocalProject: mocks.getProjectBindingByLocalProject,
    },
  }),
);

vi.mock("@/server/features/rank-tracking/services/rankCheckRunGuards", () => ({
  beginRankCheckRun: mocks.beginRankCheckRun,
}));

vi.mock("@/server/billing/subscription", () => ({
  customerHasPaidPlan: mocks.customerHasPaidPlan,
}));

vi.mock("@/server/lib/runtime-env", () => ({
  isHostedServerAuthMode: mocks.isHostedServerAuthMode,
}));

describe("runScheduledRankChecks - Quota, Binding, Interval & Pilot Safety", () => {
  const baseConfig = {
    id: APPROVED_PILOT_CONFIG_ID,
    projectId: APPROVED_PILOT_PROJECT_ID,
    domain: "sports-ms.com",
    locationCode: 2818,
    languageCode: "ar",
    locationName: "Egypt",
    devices: "both" as const,
    serpDepth: 100,
    scheduleInterval: "weekly" as const,
    nextCheckAt: "2026-11-18T07:24:00.000Z",
    lastCheckedAt: null as string | null,
    organizationId: "org-1",
  };

  const dummyEnv = {
    RANK_CHECK_WORKFLOW: { create: vi.fn() },
  } as unknown as Env;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED;
    delete process.env.RANK_TRACKING_DAILY_CHECK_CAP;
    delete process.env.RANK_TRACKING_MONTHLY_CHECK_CAP;
    delete process.env.RANK_TRACKING_PROJECT_MONTHLY_CAP;
    delete process.env.RANK_TRACKING_DAILY_PAIR_CAP;
    delete process.env.RANK_TRACKING_MONTHLY_PAIR_CAP;
    delete process.env.RANK_TRACKING_PROJECT_MONTHLY_PAIR_CAP;

    mocks.isHostedServerAuthMode.mockResolvedValue(false);
    mocks.customerHasPaidPlan.mockResolvedValue(true);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([baseConfig]);
    mocks.getKeywordCountForConfig.mockResolvedValue(1);
    mocks.getTargetsForConfig.mockResolvedValue([
      {
        id: "e06e6d4a-59cb-4a5a-960e-d8910552f735",
        device: "desktop",
        enabled: true,
      },
      {
        id: "911aa14a-b8a7-4c06-8b5d-365ed93ae03b",
        device: "mobile",
        enabled: true,
      },
    ]);
    mocks.getActiveAccountBinding.mockResolvedValue({
      id: "acc-1",
      status: "active",
    });
    mocks.getProjectBindingByLocalProject.mockResolvedValue({
      id: "pb-1",
      status: "synced",
    });
    mocks.countRunsForOrgSince.mockResolvedValue(0);
    mocks.countRunsForProjectSince.mockResolvedValue(0);
    mocks.countPersistedPairsForOrgSince.mockResolvedValue(0);
    mocks.countPersistedPairsForProjectSince.mockResolvedValue(0);
    mocks.countInFlightReservedPairsForOrg.mockResolvedValue(0);
    mocks.countInFlightReservedPairsForProject.mockResolvedValue(0);
    mocks.getLatestScheduledRunForConfig.mockResolvedValue(null);
    mocks.beginRankCheckRun.mockResolvedValue({
      ok: true,
      runId: "run-pilot-1",
    });
  });

  it("1. Skips config with 0 keywords and advances schedule", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    mocks.getKeywordCountForConfig.mockResolvedValue(0);
    const nonPilotConfig = {
      ...baseConfig,
      id: "2971425d-d350-4ee3-89b2-c83567c87713",
    };
    // Temporarily test empty keywords logic for general config
    mocks.getDueConfigsWithOrganization.mockResolvedValue([
      { ...nonPilotConfig, id: "non-pilot-allowed" },
    ]);

    await runScheduledRankChecks({
      ...dummyEnv,
      SCHEDULED_PILOT_CONFIG_ALLOWLIST: "non-pilot-allowed",
    } as any);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      "non-pilot-allowed",
      baseConfig.projectId,
      expect.objectContaining({
        nextCheckAt: expect.any(String),
      }),
    );
  });

  it("2. Weekly interval guard: skips config if scheduled check occurred within last 6 days and advances past spacing floor", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    const now = Date.now();
    // Scheduled run occurred 1 day ago; Spacing boundary is now + 5 days.
    const recentlyChecked = new Date(now - 24 * 3600 * 1000)
      .toISOString()
      .slice(0, 19)
      .replace("T", " ");
    const dueAnchor = new Date(now - 60 * 1000).toISOString();
    mocks.getLatestScheduledRunForConfig.mockResolvedValue({
      id: "run-sched-prev",
      startedAt: recentlyChecked,
      status: "completed",
    });
    mocks.getDueConfigsWithOrganization.mockResolvedValue([
      { ...baseConfig, nextCheckAt: dueAnchor, lastCheckedAt: recentlyChecked },
    ]);

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      expect.objectContaining({
        nextCheckAt: expect.any(String),
      }),
    );
    const updatedNextMs = Date.parse(
      mocks.updateConfig.mock.calls[0][2].nextCheckAt,
    );
    expect(updatedNextMs).toBeGreaterThanOrEqual(
      now - 24 * 3600 * 1000 + 6 * 86_400_000,
    );
  });

  it("2c. Active run guard: when beginRankCheckRun returns already_running (e.g. in-flight manual run), does NOT postpone nextCheckAt", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    mocks.beginRankCheckRun.mockResolvedValue({
      ok: false,
      reason: "already_running",
      blockingRunId: "manual-run-active",
    });

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).toHaveBeenCalledTimes(1);
    const nextCheckUpdates = mocks.updateConfig.mock.calls.filter(
      (call) => "nextCheckAt" in call[2],
    );
    expect(nextCheckUpdates).toHaveLength(0);
  });

  it("2b. Scheduling Independence: manual check on Monday does NOT block scheduled read-only sync due on Wednesday", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    const mondayManualCheck = new Date(
      Date.now() - 2 * 24 * 3600 * 1000,
    ).toISOString();
    // Latest scheduled run was 7 days ago (or never)
    mocks.getLatestScheduledRunForConfig.mockResolvedValue(null);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([
      { ...baseConfig, lastCheckedAt: mondayManualCheck },
    ]);

    await runScheduledRankChecks(dummyEnv);

    // Wednesday scheduled sync MUST proceed despite Monday's manual check
    expect(mocks.beginRankCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ id: baseConfig.id }),
        trigger: "scheduled",
        readOnlySync: true,
      }),
    );
  });

  it("3. Account binding guard: pauses config if SE Ranking account binding requires migration", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    mocks.getActiveAccountBinding.mockResolvedValue({
      id: "acc-1",
      status: "migration_required",
    });

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        isActive: false,
        lastSkipReason: "SE Ranking account migration_required",
      },
    );
  });

  it("4. Project binding guard: pauses config if SE Ranking project binding is paused or failed", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    mocks.getProjectBindingByLocalProject.mockResolvedValue({
      id: "pb-1",
      status: "paused",
    });

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        isActive: false,
        lastSkipReason: "SE Ranking project binding is paused",
      },
    );
  });

  it("5. Quota cap: skips config when organization daily run cap is exceeded", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    process.env.RANK_TRACKING_DAILY_CHECK_CAP = "10";
    mocks.countRunsForOrgSince.mockResolvedValue(10);

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        lastSkipReason: "Organization daily check cap reached (10/10)",
      },
    );
  });

  it("6. Quota cap: skips config when project monthly budget is reached", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    process.env.RANK_TRACKING_PROJECT_MONTHLY_CAP = "25";
    mocks.countRunsForProjectSince.mockResolvedValue(25);

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        lastSkipReason: "Project monthly check budget reached (25/25)",
      },
    );
  });

  it("7. Pilot guard: when pilot flag is FALSE, skips live execution without advancing nextCheckAt", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "false";

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        lastSkipReason:
          "Pilot disabled: configuration awaiting operator activation",
      },
    );
    // Explicitly verify nextCheckAt was NOT updated
    const updateCall = mocks.updateConfig.mock.calls[0];
    expect(updateCall[2]).not.toHaveProperty("nextCheckAt");
  });

  it("8. Pilot guard: when pilot flag is TRUE, proceeds with read-only sync and scoped pilot keyword", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: expect.objectContaining({ id: baseConfig.id }),
        keywordsTotal: APPROVED_PILOT_KEYWORD_IDS.length,
        keywordIds: [...APPROVED_PILOT_KEYWORD_IDS],
        trigger: "scheduled",
        readOnlySync: true,
      }),
    );
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      expect.objectContaining({
        nextCheckAt: expect.any(String),
      }),
    );
  });

  it("9. Allowlist rejection: non-allowlisted config is rejected even when pilot flag is TRUE", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    const unauthorizedConfig = {
      ...baseConfig,
      id: "unauthorized-config-999",
      domain: "other-domain.com",
    };
    mocks.getDueConfigsWithOrganization.mockResolvedValue([unauthorizedConfig]);

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      unauthorizedConfig.id,
      unauthorizedConfig.projectId,
      {
        lastSkipReason: "Not in scheduled pilot allowlist",
      },
    );
    const updateCall = mocks.updateConfig.mock.calls[0];
    expect(updateCall[2]).not.toHaveProperty("nextCheckAt");
  });

  it("10. Pair-level quota cap: skips config when daily pair cap would be exceeded by in-flight/persisted pairs", async () => {
    process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED = "true";
    process.env.RANK_TRACKING_DAILY_PAIR_CAP = "100";
    mocks.countPersistedPairsForOrgSince.mockResolvedValue(90);
    mocks.countInFlightReservedPairsForOrg.mockResolvedValue(9);
    // 90 + 9 + 2 (estimated for desktop+mobile) = 101 > 100

    await runScheduledRankChecks(dummyEnv);

    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      baseConfig.id,
      baseConfig.projectId,
      {
        lastSkipReason: "Organization daily pair cap reached (99/100)",
      },
    );
  });
});
