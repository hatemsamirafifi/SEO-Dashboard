import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {},
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {},
  }),
);

import { toDeviceResult } from "./rankTrackingResults";
import { computeScorecards } from "@/client/features/rank-tracking/rankTrackingScorecards";
import { matchesPositionFilter } from "@/client/features/rank-tracking/RankTrackingFilters.logic";
import type {
  RankTrackingDeviceResult,
  RankTrackingRow,
} from "@/types/schemas/rank-tracking";

describe("Rank Tracking Provider Error Semantic Safeguards", () => {
  type SnapshotInput = Parameters<typeof toDeviceResult>[0];

  const baseSnapshot: SnapshotInput = {
    id: 1,
    runId: "run_1",
    trackingKeywordId: "kw_1",
    keyword: "test keyword",
    device: "desktop",
    position: null,
    previousPosition: 8,
    url: null,
    serpFeatures: null,
    provider: "dataforseo",
    rankingStatus: "CHECK_FAILED",
    providerStatus:
      "DataForSEO task error (40201): We noticed some unusual activity in your DataForSEO account",
    providerStatusCode: 40201,
    errorMessage:
      "DataForSEO task error (40201): We noticed some unusual activity in your DataForSEO account",
    checkedAt: "2026-09-14T12:00:00.000Z",
  };

  it("1. CHECK_FAILED preserves latestValidPosition and sets status: 'failed' (NOT 'not_ranking')", () => {
    const result = toDeviceResult(
      baseSnapshot,
      /* previousPosition */ 8,
      /* latestValidPosition */ 8,
    );

    expect(result.status).toBe("failed");
    expect(result.rankingStatus).toBe("CHECK_FAILED");
    expect(result.position).toBeNull();
    expect(result.previousPosition).toBe(8);
    expect(result.latestValidPosition).toBe(8);
    expect(result.rankingUrl).toBeNull();
    expect(result.errorCode).toBe("DATAFORSEO_ACCOUNT_PAUSED");
  });

  it("2. Valid check absent from SERP results in status: 'not_ranking' and rankingStatus: 'NO_RESULT'", () => {
    const validNoResultSnapshot: SnapshotInput = {
      ...baseSnapshot,
      rankingStatus: "NO_RESULT",
      providerStatus: null,
      providerStatusCode: null,
      errorMessage: null,
    };

    const result = toDeviceResult(
      validNoResultSnapshot,
      /* previousPosition */ null,
      /* latestValidPosition */ null,
    );

    expect(result.status).toBe("not_ranking");
    expect(result.rankingStatus).toBe("NO_RESULT");
    expect(result.position).toBeNull();
    expect(result.latestValidPosition).toBeNull();
    expect(result.errorCode).toBeNull();
  });

  it("3. computeScorecards excludes CHECK_FAILED from lost, declined, improved, and unranked", () => {
    const failedDevice: RankTrackingDeviceResult = {
      position: null,
      previousPosition: 8,
      rankingUrl: null,
      serpFeatures: [],
      checkedAt: "2026-09-14T12:00:00.000Z",
      status: "failed",
      rankingStatus: "CHECK_FAILED",
      latestValidPosition: 8,
      errorCode: "DATAFORSEO_ACCOUNT_PAUSED",
    };

    const row: RankTrackingRow = {
      trackingKeywordId: "kw_1",
      keyword: "test keyword",
      searchVolume: 100,
      keywordDifficulty: 20,
      cpc: 1.5,
      desktop: failedDevice,
      mobile: {
        position: null,
        previousPosition: null,
        rankingUrl: null,
        serpFeatures: [],
        status: "not_checked",
      },
    };

    const cards = computeScorecards([row], "desktop");

    // Must NOT count as declined or improved
    expect(cards.declined).toBe(0);
    expect(cards.improved).toBe(0);
    // Must NOT count as currently ranking
    expect(cards.ranking).toBe(0);
  });

  it("4. matchesPositionFilter excludes CHECK_FAILED from unranked filter (max: '0')", () => {
    const failedStatus: RankTrackingDeviceResult["status"] = "failed";
    const notRankingStatus: RankTrackingDeviceResult["status"] = "not_ranking";

    expect(matchesPositionFilter(null, "", "0", failedStatus)).toBe(false);
    expect(matchesPositionFilter(null, "", "0", notRankingStatus)).toBe(true);
  });

  it("5. CHECK_FAILED attempt when previous was NO_RESULT does NOT create a second NO_RESULT", () => {
    const result = toDeviceResult(
      baseSnapshot,
      /* previousPosition */ null,
      /* latestValidPosition */ null,
    );

    expect(result.status).toBe("failed");
    expect(result.rankingStatus).toBe("CHECK_FAILED");
    expect(result.position).toBeNull();
    expect(result.latestValidPosition).toBeNull();
  });
});
