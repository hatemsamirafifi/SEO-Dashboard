import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
  NonRetryableError: class NonRetryableError extends Error {},
  WorkflowEntrypoint: class WorkflowEntrypoint {
    run() {}
  },
}));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));

import { finalizeRankCheckRun } from "./RankCheckWorkflow";
import { toDeviceResult } from "@/server/features/rank-tracking/services/rankTrackingResults";

const repoMocks = vi.hoisted(() => ({
  getRunById: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  updateRun: vi.fn(),
  updateConfig: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: repoMocks,
  }),
);

const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

describe("Multi-Target Rank Tracking Accounting", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    repoMocks.getRunById.mockResolvedValue({
      id: "run_test",
      status: "running",
      keywordsTotal: 1,
    });
    repoMocks.updateRun.mockResolvedValue(undefined);
    repoMocks.updateConfig.mockResolvedValue(undefined);
  });

  it("1. Egypt Desktop completed + Egypt Mobile completed -> status 'completed', keywordsChecked = 1", async () => {
    const kwId = "kw_multipurpose";
    const targetEgyptDesktop = "target_eg_desktop";
    const targetEgyptMobile = "target_eg_mobile";

    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: targetEgyptDesktop },
      { trackingKeywordId: kwId, trackingTargetId: targetEgyptMobile },
    ];

    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 101,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: targetEgyptDesktop,
        device: "desktop",
        rankingStatus: "RANKED",
        position: 62,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 102,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: targetEgyptMobile,
        device: "mobile",
        rankingStatus: "RANKED",
        position: 46,
        completionConfidence: "LIKELY_COMPLETE",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "completed",
        keywordsChecked: 1,
      }),
    );
  });

  it("2. Egypt Desktop/Mobile completed + Saudi Desktop/Mobile pending -> status 'partial', keywordsChecked = 0", async () => {
    const kwId = "kw_multipurpose";
    const egDesktop = "target_eg_desktop";
    const egMobile = "target_eg_mobile";
    const saDesktop = "target_sa_desktop";
    const saMobile = "target_sa_mobile";

    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: egDesktop },
      { trackingKeywordId: kwId, trackingTargetId: egMobile },
      { trackingKeywordId: kwId, trackingTargetId: saDesktop },
      { trackingKeywordId: kwId, trackingTargetId: saMobile },
    ];

    // Only Egypt pairs completed; Saudi pairs never recorded snapshots
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 201,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: egDesktop,
        device: "desktop",
        rankingStatus: "RANKED",
        position: 62,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 202,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: egMobile,
        device: "mobile",
        rankingStatus: "RANKED",
        position: 46,
        completionConfidence: "LIKELY_COMPLETE",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "partial",
        keywordsChecked: 0,
      }),
    );
  });

  it("3. Keyword assigned to only selected market (Egypt) completes independently of unassigned markets", async () => {
    const kw1 = "kw_local_egypt";
    const kw2 = "kw_all_markets";
    const egTarget = "target_eg";
    const saTarget = "target_sa";

    // kw1 is assigned ONLY to Egypt; kw2 is assigned to Egypt and Saudi
    const expectedPairs = [
      { trackingKeywordId: kw1, trackingTargetId: egTarget },
      { trackingKeywordId: kw2, trackingTargetId: egTarget },
      { trackingKeywordId: kw2, trackingTargetId: saTarget },
    ];

    repoMocks.getRunById.mockResolvedValue({
      id: "run_test",
      status: "running",
      keywordsTotal: 2,
    });

    // Egypt completes for both kw1 and kw2; Saudi fails for kw2
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 301,
        runId: "run_test",
        trackingKeywordId: kw1,
        trackingTargetId: egTarget,
        device: "desktop",
        rankingStatus: "RANKED",
        position: 10,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 302,
        runId: "run_test",
        trackingKeywordId: kw2,
        trackingTargetId: egTarget,
        device: "desktop",
        rankingStatus: "RANKED",
        position: 15,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 303,
        runId: "run_test",
        trackingKeywordId: kw2,
        trackingTargetId: saTarget,
        device: "desktop",
        rankingStatus: "CHECK_FAILED",
        errorMessage: "Provider 500 error",
        position: null,
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    // kw1 was 100% completed on all expected targets -> fully successful
    // kw2 had 1 of 2 targets completed -> partial
    // Overall run is partial with keywordsChecked = 1 (kw1 only)
    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "partial",
        keywordsChecked: 1,
      }),
    );
  });

  it("4. Multiple cities on the same device (Cairo Desktop vs Alexandria Desktop)", async () => {
    const kwId = "kw_city_sports";
    const cairoDesktop = "target_cairo_desktop";
    const alexDesktop = "target_alex_desktop";

    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: cairoDesktop },
      { trackingKeywordId: kwId, trackingTargetId: alexDesktop },
    ];

    // Cairo Desktop completes, but Alexandria Desktop timed out unverified
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 401,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: cairoDesktop,
        device: "desktop",
        cityName: "Cairo",
        rankingStatus: "RANKED",
        position: 5,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 402,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: alexDesktop,
        device: "desktop",
        cityName: "Alexandria",
        rankingStatus: "CHECK_FAILED",
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        completionConfidence: "UNVERIFIED",
        position: null,
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    // Under device-only accounting this would erroneously be marked complete because "desktop" is ranked!
    // Under target accounting, Alexandria Desktop is unverified, so run MUST be partial and keywordsChecked = 0.
    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "partial",
        keywordsChecked: 0,
      }),
    );
  });

  it("5. Language-specific target isolation (Arabic vs English)", async () => {
    const kwId = "kw_bilingual";
    const arTarget = "target_eg_ar";
    const enTarget = "target_eg_en";

    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: arTarget },
      { trackingKeywordId: kwId, trackingTargetId: enTarget },
    ];

    // Arabic completes, English completes
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 501,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: arTarget,
        device: "desktop",
        language: "ar",
        rankingStatus: "RANKED",
        position: 3,
        completionConfidence: "LIKELY_COMPLETE",
      },
      {
        id: 502,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: enTarget,
        device: "desktop",
        language: "en",
        rankingStatus: "RANKED",
        position: 12,
        completionConfidence: "LIKELY_COMPLETE",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "completed",
        keywordsChecked: 1,
      }),
    );
  });

  it("6. Same-day unchanged observation marked TIMED_OUT_UNVERIFIED preserves latestValidPosition and prevents false completion", async () => {
    const kwId = "kw_multipurpose";
    const desktopTarget = "target_eg_desktop";
    const mobileTarget = "target_eg_mobile";

    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: desktopTarget },
      { trackingKeywordId: kwId, trackingTargetId: mobileTarget },
    ];

    // Desktop: timed out unverified, pre-recheck baseline was position 62
    // Mobile: confirmed fresh observation position 46
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 601,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: desktopTarget,
        device: "desktop",
        rankingStatus: "CHECK_FAILED",
        position: null,
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatus: "identical to pre-recheck baseline",
        completionConfidence: "UNVERIFIED",
      },
      {
        id: 602,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: mobileTarget,
        device: "mobile",
        rankingStatus: "RANKED",
        position: 46,
        completionConfidence: "LIKELY_COMPLETE",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "partial",
        keywordsChecked: 0,
      }),
    );

    // Verify toDeviceResult maps the unverified Desktop snapshot correctly
    const desktopDeviceResult = toDeviceResult(
      {
        id: 1,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: desktopTarget,
        keyword: "sample keyword",
        device: "desktop",
        rankingStatus: "CHECK_FAILED",
        position: null,
        previousPosition: null,
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatus: "identical to pre-recheck baseline",
        providerStatusCode: null,
        provider: "seranking",
        completionConfidence: "UNVERIFIED",
        checkedAt: "2026-11-13 21:50:04",
        url: null,
        serpFeatures: null,
      },
      50, // previousPosition
      62, // latestValidPosition
    );

    expect(desktopDeviceResult.attemptStatus).toBe("TIMED_OUT_UNVERIFIED");
    expect(desktopDeviceResult.latestValidPosition).toBe(62);
    expect(desktopDeviceResult.position).toBeNull();
  });

  it("7. Latest valid position preservation (#62) across multiple check cycles", () => {
    // When a check fails or times out, the historical position is preserved
    const result = toDeviceResult(
      {
        id: 2,
        runId: "run_current",
        trackingKeywordId: "kw_1",
        trackingTargetId: "target_1",
        keyword: "sample keyword",
        device: "desktop",
        rankingStatus: "CHECK_FAILED",
        position: null,
        previousPosition: null,
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatus:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatusCode: null,
        provider: "seranking",
        completionConfidence: "UNVERIFIED",
        checkedAt: "2026-11-13 21:50:04",
        url: null,
        serpFeatures: null,
      },
      50, // previous
      62, // latest valid
    );

    expect(result.latestValidPosition).toBe(62);
    expect(result.attemptStatus).toBe("TIMED_OUT_UNVERIFIED");
  });

  it("8. Scheduled workflow idempotency: cancelled or already completed run is not overwritten", async () => {
    repoMocks.getRunById.mockResolvedValue({
      id: "run_already_done",
      status: "completed",
      keywordsTotal: 1,
    });

    await finalizeRankCheckRun({
      runId: "run_already_done",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "scheduled",
      batchError: null,
      queueStats: null,
      expectedPairs: [{ trackingKeywordId: "kw_1", trackingTargetId: "t_1" }],
    });

    expect(repoMocks.updateRun).not.toHaveBeenCalled();
  });

  it("9. All pairs TIMED_OUT_UNVERIFIED -> status 'failed', keywordsChecked = 0", async () => {
    const kwId = "kw_timedout";
    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: "t_desktop" },
      { trackingKeywordId: kwId, trackingTargetId: "t_mobile" },
    ];

    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 901,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: "t_desktop",
        rankingStatus: "CHECK_FAILED",
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatus: "identical to pre-recheck baseline",
        completionConfidence: "UNVERIFIED",
      },
      {
        id: 902,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: "t_mobile",
        rankingStatus: "CHECK_FAILED",
        errorMessage:
          "SE Ranking queued recheck did not produce a completed observation within the polling window",
        providerStatus: "identical to pre-recheck baseline",
        completionConfidence: "UNVERIFIED",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "scheduled",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "failed",
        keywordsChecked: 0,
      }),
    );
  });

  it("10. All pairs PROVIDER_FAILED -> status 'failed', keywordsChecked = 0", async () => {
    const kwId = "kw_provider_down";
    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: "t_desktop" },
      { trackingKeywordId: kwId, trackingTargetId: "t_mobile" },
    ];

    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 1001,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: "t_desktop",
        rankingStatus: "CHECK_FAILED",
        errorMessage: "Upstream 502 Bad Gateway from provider",
      },
      {
        id: 1002,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: "t_mobile",
        rankingStatus: "CHECK_FAILED",
        errorMessage: "Upstream 502 Bad Gateway from provider",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "failed",
        keywordsChecked: 0,
      }),
    );
  });

  it("11. All pairs PENDING at workflow timeout (no snapshots recorded) -> status 'failed', keywordsChecked = 0", async () => {
    const kwId = "kw_pending_timeout";
    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: "t_desktop" },
      { trackingKeywordId: kwId, trackingTargetId: "t_mobile" },
    ];

    // Zero snapshots recorded because workflow was aborted/timed out before collection
    repoMocks.getSnapshotsForRun.mockResolvedValue([]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "scheduled",
      batchError: "Workflow execution timeout reached",
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "failed",
        keywordsChecked: 0,
      }),
    );
  });

  it("12. Explicit accepted completion confidence required (rejection of null/unknown confidence on SE Ranking)", async () => {
    const kwId = "kw_unconfirmed";
    const expectedPairs = [
      { trackingKeywordId: kwId, trackingTargetId: "t_desktop" },
    ];

    // SE Ranking snapshot with RANKED status but completionConfidence: null
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 1201,
        runId: "run_test",
        trackingKeywordId: kwId,
        trackingTargetId: "t_desktop",
        provider: "seranking",
        rankingStatus: "RANKED",
        position: 10,
        completionConfidence: null, // NOT accepted
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    // Because completionConfidence is null on SE Ranking, it cannot be accepted as completed
    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "failed",
        keywordsChecked: 0,
      }),
    );
  });

  it("13. Cancelled run: preserves 'cancelled' status and truthful keywordsChecked", async () => {
    repoMocks.getRunById.mockResolvedValue({
      id: "run_test",
      status: "cancelled",
      keywordsTotal: 2,
    });

    const expectedPairs = [
      { trackingKeywordId: "kw_1", trackingTargetId: "t_1" },
      { trackingKeywordId: "kw_2", trackingTargetId: "t_1" },
    ];

    // kw_1 completed before cancel was requested; kw_2 cancelled
    repoMocks.getSnapshotsForRun.mockResolvedValue([
      {
        id: 1301,
        runId: "run_test",
        trackingKeywordId: "kw_1",
        trackingTargetId: "t_1",
        provider: "seranking",
        rankingStatus: "RANKED",
        position: 15,
        completionConfidence: "CONFIRMED",
      },
      {
        id: 1302,
        runId: "run_test",
        trackingKeywordId: "kw_2",
        trackingTargetId: "t_1",
        rankingStatus: "NOT_CHECKED",
        errorMessage: "Cancelled by user",
      },
    ]);

    await finalizeRankCheckRun({
      runId: "run_test",
      configId: "cfg_1",
      projectId: "project_1",
      billingCustomer,
      trigger: "manual",
      batchError: null,
      queueStats: null,
      expectedPairs,
    });

    expect(repoMocks.updateRun).toHaveBeenCalledWith(
      "run_test",
      expect.objectContaining({
        status: "cancelled",
        keywordsChecked: 1,
      }),
    );
  });
});
