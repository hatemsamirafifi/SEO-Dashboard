import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_IDS,
  APPROVED_PILOT_PROJECT_ID,
  APPROVED_PILOT_TARGET_IDS,
} from "@/shared/rank-tracking";
import { runScheduledRankChecks } from "./scheduledRankChecks";

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

describe("Production Defaults & Pilot Inactivity Verification", () => {
  const pilotConfig = {
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
    organizationId: "org-prod-1",
  };

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.SCHEDULED_RANK_TRACKING_PILOT_ENABLED;
    delete process.env.SCHEDULED_PILOT_CONFIG_ALLOWLIST;

    mocks.isHostedServerAuthMode.mockResolvedValue(true);
    mocks.customerHasPaidPlan.mockResolvedValue(true);
    mocks.getDueConfigsWithOrganization.mockResolvedValue([pilotConfig]);
    mocks.getKeywordCountForConfig.mockResolvedValue(1);
    mocks.getTargetsForConfig.mockResolvedValue([
      { id: APPROVED_PILOT_TARGET_IDS[0], enabled: true },
      { id: APPROVED_PILOT_TARGET_IDS[1], enabled: true },
    ]);
    mocks.getLatestScheduledRunForConfig.mockResolvedValue(null);
    mocks.getActiveAccountBinding.mockResolvedValue(null);
    mocks.getProjectBindingByLocalProject.mockResolvedValue(null);
    mocks.countPersistedPairsForOrgSince.mockResolvedValue(0);
    mocks.countPersistedPairsForProjectSince.mockResolvedValue(0);
    mocks.countInFlightReservedPairsForOrg.mockResolvedValue(0);
    mocks.countInFlightReservedPairsForProject.mockResolvedValue(0);
  });

  it("fails safe by default in production: skips cron execution when SCHEDULED_RANK_TRACKING_PILOT_ENABLED is undefined", async () => {
    // Production default: no pilot variable in env
    const prodEnv = {
      AUTH_MODE: "hosted",
      DATABASE_PROVIDER: "postgres",
      RANK_CHECK_WORKFLOW: { create: vi.fn() },
    } as unknown as Env;

    await runScheduledRankChecks(prodEnv);

    // 1. Workflow must NOT be created
    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();

    // 2. Schedule window must NOT be advanced
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      pilotConfig.id,
      pilotConfig.projectId,
      {
        lastSkipReason:
          "Pilot disabled: configuration awaiting operator activation",
      },
    );

    // Verify nextCheckAt was NOT touched in the updateConfig payload
    const updateCall = mocks.updateConfig.mock.calls[0];
    expect(updateCall[2]).not.toHaveProperty("nextCheckAt");
  });

  it("fails safe when SCHEDULED_RANK_TRACKING_PILOT_ENABLED is empty string or 'false'", async () => {
    const prodEnvWithEmpty = {
      AUTH_MODE: "hosted",
      DATABASE_PROVIDER: "postgres",
      SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "",
      RANK_CHECK_WORKFLOW: { create: vi.fn() },
    } as unknown as Env;

    await runScheduledRankChecks(prodEnvWithEmpty);
    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();

    const prodEnvWithFalse = {
      AUTH_MODE: "hosted",
      DATABASE_PROVIDER: "postgres",
      SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "false",
      RANK_CHECK_WORKFLOW: { create: vi.fn() },
    } as unknown as Env;

    await runScheduledRankChecks(prodEnvWithFalse);
    expect(mocks.beginRankCheckRun).not.toHaveBeenCalled();
  });

  it("executes read-only sync pilot ONLY when SCHEDULED_RANK_TRACKING_PILOT_ENABLED is explicitly 'true'", async () => {
    mocks.beginRankCheckRun.mockResolvedValueOnce({
      ok: true,
      runId: "run-scheduled-pilot-1",
      operationId: "op-scheduled-1",
    });

    const activePilotEnv = {
      AUTH_MODE: "hosted",
      DATABASE_PROVIDER: "postgres",
      SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "true",
      RANK_CHECK_WORKFLOW: { create: vi.fn() },
    } as unknown as Env;

    await runScheduledRankChecks(activePilotEnv);

    expect(mocks.beginRankCheckRun).toHaveBeenCalledTimes(1);
    expect(mocks.beginRankCheckRun).toHaveBeenCalledWith(
      expect.objectContaining({
        config: pilotConfig,
        projectId: APPROVED_PILOT_PROJECT_ID,
        keywordIds: [...APPROVED_PILOT_KEYWORD_IDS],
        trigger: "scheduled",
        readOnlySync: true,
      }),
    );

    // Schedule is advanced upon successful slot acquisition
    expect(mocks.updateConfig).toHaveBeenCalledWith(
      pilotConfig.id,
      pilotConfig.projectId,
      expect.objectContaining({
        nextCheckAt: expect.any(String),
      }),
    );
  });
});
