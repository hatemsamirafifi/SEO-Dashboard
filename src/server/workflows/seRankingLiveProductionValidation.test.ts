/**
 * End-to-end production validation tests for the SE Ranking rank check pipeline
 * using sanitized real provider response fixtures from the live forensic audit.
 *
 * Validates:
 *  1. Nested site-engine / keyword / position response parsing (no flat-array dependencies)
 *  2. Desktop position 62 with provider 24h change -12 vs OpenSEO historical baseline 37
 *  3. Mobile position 35 with newly added engine
 *  4. Landing page observation date preservation (2026-11-11 vs 2026-11-13)
 *  5. Same-day attribution grading as LIKELY_COMPLETE (never falsely CONFIRMED)
 *  6. UNVERIFIED masking preservation
 *  7. Read-side compatibility for Frontend table, SAM, and MCP tools
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeRankingLib from "@/server/lib/seranking";

const repoMocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  insertProviderCalls: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  updateRun: vi.fn(),
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getLatestSnapshotsForKeywords: vi.fn(),
  getLatestValidSnapshotsForKeywords: vi.fn(),
  getValidDailySnapshotsForConfig: vi.fn(),
  getSnapshotsBeforeDate: vi.fn(),
  getEarliestSnapshotsForKeywords: vi.fn(),
}));

const projectServiceMocks = vi.hoisted(() => ({
  getCheckDates: vi.fn(),
  getPositions: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);

vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<typeof SeRankingLib>();
  return {
    ...actual,
    SeRankingProjectService: projectServiceMocks,
  };
});

import {
  collectSeRankingPollRound,
  type SeRankingPendingPair,
  type SeRankingRecheckBaseline,
} from "./seRankingCheckHelpers";
import {
  toDeviceResult,
  parseProviderStatusMetadata,
  getLatestResults,
} from "@/server/features/rank-tracking/services/rankTrackingResults";
import {
  extractPositionObservation,
  parsePositionsPayload,
} from "@/server/lib/seranking";

// Real sanitized response fixtures from SE Ranking forensic audit
const REAL_DESKTOP_FIXTURE = [
  {
    site_engine_id: 539194,
    keywords: [
      {
        id: "24606031",
        name: "إنشاء ملاعب متعددة الأغراض",
        group_id: 535759,
        volume: 0,
        competition: 0,
        suggested_bid: 0,
        cpc: 0,
        results: 129,
        positions: [
          {
            date: "2026-11-11",
            pos: 50,
            depth: 100,
            change: 0,
          },
          {
            date: "2026-11-12",
            pos: 50,
            depth: 100,
            change: 0,
          },
          {
            date: "2026-11-13",
            pos: 62,
            depth: 100,
            change: -12,
            price: 0,
            is_map: 0,
            map_position: 0,
            paid_position: 0,
          },
        ],
        landing_pages: [
          {
            url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
            ascii_url:
              "https://sports-ms.com/%D8%A7%D9%84%D8%AE%D8%AF%D9%85%D8%A7%D8%AA/%D9%85%D9%84%D8%A7%D8%B9%D8%A8-%D9%85%D8%AA%D8%B9%D8%AF%D8%AF%D8%A9-%D8%A7%D9%84%D8%A3%D8%BA%D8%B1%D8%A7%D8%B6/",
            date: "2026-11-11",
          },
        ],
        features: {
          video: false,
          people_also_ask: false,
          images: false,
          sge: false,
        },
        total_sum: 0,
      },
    ],
  },
];

const REAL_MOBILE_FIXTURE = [
  {
    site_engine_id: 545914,
    keywords: [
      {
        id: "24606031",
        name: "إنشاء ملاعب متعددة الأغراض",
        group_id: 535759,
        volume: 0,
        competition: 0,
        suggested_bid: 0,
        cpc: 0,
        results: 129,
        positions: [
          {
            date: "2026-11-13",
            pos: 35,
            depth: 100,
            change: 0,
            price: 0,
            is_map: 0,
            map_position: 0,
            paid_position: 0,
          },
        ],
        landing_pages: [
          {
            url: "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
            ascii_url:
              "https://sports-ms.com/%D8%A5%D9%86%D8%B4%D8%A7%D8%A1-%D9%85%D9%84%D8%A7%D8%B9%D8%A8-%D9%85%D8%AA%D8%B9%D8%AF%D8%AF%D8%A9-%D8%A7%D9%84%D8%A3%D8%BA%D8%B1%D8%A7%D8%B6/",
            date: "2026-11-13",
          },
        ],
        features: {
          video: false,
          images: false,
        },
        total_sum: 0,
      },
    ],
  },
];

beforeEach(() => {
  vi.clearAllMocks();
  repoMocks.insertSnapshots.mockResolvedValue(undefined);
  repoMocks.insertProviderCalls.mockResolvedValue(undefined);
  repoMocks.getSnapshotsForRun.mockResolvedValue([]);
  repoMocks.updateRun.mockResolvedValue(undefined);
});

describe("Task 1 & 3: Production Parser & Landing Page Date Attribution", () => {
  it("accurately parses nested engine/keyword/positions structure without flat-array dependencies", () => {
    const desktopItems = parsePositionsPayload(REAL_DESKTOP_FIXTURE);
    expect(desktopItems).toHaveLength(1);
    expect(desktopItems[0]?.site_engine_id).toBe(539194);
    expect(desktopItems[0]?.normalizedKeywordId).toBe("24606031");

    const mobileItems = parsePositionsPayload(REAL_MOBILE_FIXTURE);
    expect(mobileItems).toHaveLength(1);
    expect(mobileItems[0]?.site_engine_id).toBe(545914);
    expect(mobileItems[0]?.normalizedKeywordId).toBe("24606031");
  });

  it("extracts Desktop rank 62 with provider change -12 and preserves historical landing page date 2026-11-11", () => {
    const desktopItem = parsePositionsPayload(REAL_DESKTOP_FIXTURE)[0];
    const obs = extractPositionObservation(desktopItem, "2026-11-13");

    expect(obs.observed).toBe(true);
    expect(obs.position).toBe(62);
    expect(obs.providerChange).toBe(-12);
    expect(obs.observedDate).toBe("2026-11-13");
    expect(obs.url).toBe("https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/");
    // Landing page date was 2026-11-11, NOT freshly observed on 2026-11-13
    expect(obs.landingPageDate).toBe("2026-11-11");
  });

  it("extracts Mobile rank 35 with same-day landing page date 2026-11-13", () => {
    const mobileItem = parsePositionsPayload(REAL_MOBILE_FIXTURE)[0];
    const obs = extractPositionObservation(mobileItem, "2026-11-13");

    expect(obs.observed).toBe(true);
    expect(obs.position).toBe(35);
    expect(obs.providerChange).toBe(0);
    expect(obs.observedDate).toBe("2026-11-13");
    expect(obs.url).toBe("https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/");
    expect(obs.landingPageDate).toBe("2026-11-13");
  });
});

describe("Task 2, 4 & 5: Polling, Attribution, and Comparison Semantics", () => {
  it("records Desktop (pos 62, prev 37) and Mobile (pos 35, prev null) as LIKELY_COMPLETE with accurate metadata", async () => {
    projectServiceMocks.getCheckDates.mockImplementation(
      async (_client: any, _siteId: number, siteEngineId?: number) => {
        if (siteEngineId === 539194) {
          return ["2026-11-11", "2026-11-12", "2026-11-13"];
        }
        if (siteEngineId === 545914) {
          return ["2026-11-13"];
        }
        return ["2026-11-13"];
      },
    );

    projectServiceMocks.getPositions.mockImplementation(
      async (_client: any, params: { siteEngineId?: number }) => {
        if (params.siteEngineId === 539194) {
          return parsePositionsPayload(REAL_DESKTOP_FIXTURE);
        }
        if (params.siteEngineId === 545914) {
          return parsePositionsPayload(REAL_MOBILE_FIXTURE);
        }
        return [];
      },
    );

    // Pre-recheck baseline: Desktop had 2026-11-13 check date with baseline pos 50.
    // Mobile had 2026-11-13 check date with newly associated keyword (no baseline observation).
    const recheckBaseline: SeRankingRecheckBaseline = {
      "539194": {
        hadTodayCheckDate: true,
        latestCheckDate: "2026-11-13",
        observations: {
          "24606031": { position: 50, url: null, serpFeatures: [] },
        },
      },
      "545914": {
        hadTodayCheckDate: true,
        latestCheckDate: "2026-11-13",
        observations: {
          "24606031": null,
        },
      },
    };

    const pendingPairs: SeRankingPendingPair[] = [
      {
        targetId: "e06e6d4a-59cb-4a5a-960e-d8910552f735",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "desktop",
        countryCode: "eg",
        cityName: null,
        languageCode: "ar",
        searchEngine: "google",
        remoteSiteEngineId: 539194,
        remoteKeywordId: "24606031",
      },
      {
        targetId: "911aa14a-b8a7-4c06-8b5d-365ed93ae03b",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "mobile",
        countryCode: "eg",
        cityName: null,
        languageCode: "ar",
        searchEngine: "google",
        remoteSiteEngineId: 545914,
        remoteKeywordId: "24606031",
      },
    ];

    // OpenSEO authoritative historical comparison: last valid Desktop rank was 37 (from DataForSEO snapshot 5521)
    const previousPositions = new Map<string, number | null>([
      [
        "e06e6d4a-59cb-4a5a-960e-d8910552f735:28131aad-fe42-43b6-bfdb-5fe0d7e046a3:desktop",
        37,
      ],
      ["28131aad-fe42-43b6-bfdb-5fe0d7e046a3:desktop", 37],
    ]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 13188608,
      runId: "88697363-30a6-4c38-902d-abcb1c819382",
      projectId: "367587e1-0c77-4d58-a2f8-7d7a171adfcb",
      configId: "2971425d-d350-4ee3-89b2-c83567c87713",
      today: "2026-11-13",
      pendingPairs,
      previousPositions,
      recheckBaseline,
    });

    expect(result.collectedCount).toBe(2);
    expect(result.stillPending).toHaveLength(0);

    const insertedRows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(insertedRows).toHaveLength(2);

    const desktopRow = insertedRows.find((r) => r.device === "desktop");
    expect(desktopRow).toBeDefined();
    expect(desktopRow?.position).toBe(62);
    expect(desktopRow?.previousPosition).toBe(37); // OpenSEO historical comparison preserved!
    expect(desktopRow?.rankingStatus).toBe("RANKED");
    expect(desktopRow?.completionConfidence).toBe("LIKELY_COMPLETE"); // Never falsely CONFIRMED
    expect(desktopRow?.providerStatus).toBe(
      JSON.stringify({
        status: "Ok",
        providerChange: -12,
        landingPageObservedAt: "2026-11-11",
      }),
    );

    const mobileRow = insertedRows.find((r) => r.device === "mobile");
    expect(mobileRow).toBeDefined();
    expect(mobileRow?.position).toBe(35);
    expect(mobileRow?.previousPosition).toBeNull(); // First mobile observation
    expect(mobileRow?.rankingStatus).toBe("RANKED");
    expect(mobileRow?.completionConfidence).toBe("LIKELY_COMPLETE");
    expect(mobileRow?.providerStatus).toBe(
      JSON.stringify({
        status: "Ok",
        providerChange: 0,
        landingPageObservedAt: "2026-11-13",
      }),
    );
  });
});

describe("Read-side Delivery: toDeviceResult, Frontend, SAM & MCP Compatibility", () => {
  it("formats Desktop snapshot into DeviceResult preserving distinct historical baseline and provider 24h change", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const snapshot: any = {
      id: 9762,
      runId: "88697363-30a6-4c38-902d-abcb1c819382",
      device: "desktop",
      position: 62,
      previousPosition: 37,
      rankingStatus: "RANKED",
      url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
      completionConfidence: "LIKELY_COMPLETE",
      provider: "seranking",
      providerStatus:
        "Ok (provider_change:-12, landing_page_observed:2026-11-11)",
      providerStatusCode: 200,
      checkedAt: "2026-11-13T17:38:38.960Z",
      checkedDate: "2026-11-13",
      serpFeatures: null,
    };

    const parsedMeta = parseProviderStatusMetadata(snapshot.providerStatus);
    expect(parsedMeta.providerChange).toBe(-12);
    expect(parsedMeta.landingPageDate).toBe("2026-11-11");

    const deviceResult = toDeviceResult(snapshot, 37, 37);

    expect(deviceResult.status).toBe("ranked");
    expect(deviceResult.position).toBe(62);
    expect(deviceResult.previousPosition).toBe(37); // OpenSEO historical comparison
    expect(deviceResult.providerChange).toBe(-12); // Provider-reported 24h delta
    expect(deviceResult.landingPageDate).toBe("2026-11-11"); // Historical landing page date
    expect(deviceResult.completionConfidence).toBe("LIKELY_COMPLETE"); // LIKELY_COMPLETE preserved
    expect(deviceResult.rankingUrl).toBe(
      "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
    );
  });

  it("formats Mobile snapshot into DeviceResult correctly", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const snapshot: any = {
      id: 9763,
      runId: "88697363-30a6-4c38-902d-abcb1c819382",
      device: "mobile",
      position: 35,
      previousPosition: null,
      rankingStatus: "RANKED",
      url: "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
      completionConfidence: "LIKELY_COMPLETE",
      provider: "seranking",
      providerStatus:
        "Ok (provider_change:0, landing_page_observed:2026-11-13)",
      providerStatusCode: 200,
      checkedAt: "2026-11-13T17:38:38.960Z",
      checkedDate: "2026-11-13",
      serpFeatures: null,
    };

    const deviceResult = toDeviceResult(snapshot, null, null);

    expect(deviceResult.status).toBe("ranked");
    expect(deviceResult.position).toBe(35);
    expect(deviceResult.previousPosition).toBeNull();
    expect(deviceResult.providerChange).toBe(0);
    expect(deviceResult.landingPageDate).toBe("2026-11-13");
    expect(deviceResult.completionConfidence).toBe("LIKELY_COMPLETE");
    expect(deviceResult.rankingUrl).toBe(
      "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
    );
  });

  it("masks UNVERIFIED snapshot from being exposed as a fresh rank in MCP or SAM", () => {
    // oxlint-disable-next-line typescript/no-explicit-any
    const unverifiedSnap: any = {
      id: 9764,
      runId: "run-unverified",
      device: "desktop",
      position: 62,
      previousPosition: 37,
      rankingStatus: "RANKED",
      url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
      completionConfidence: "UNVERIFIED",
      provider: "seranking",
      providerStatus:
        "Unverified same-day observation: identical to pre-recheck baseline",
      providerStatusCode: 200,
      checkedAt: "2026-11-13T17:38:38.960Z",
      checkedDate: "2026-11-13",
      serpFeatures: null,
    };

    const result = toDeviceResult(unverifiedSnap, 37, 37);

    // UNVERIFIED must be masked to failed/null position to prevent stale attribution
    expect(result.status).toBe("failed");
    expect(result.rankingStatus).toBe("CHECK_FAILED");
    expect(result.position).toBeNull();
    expect(result.rankingUrl).toBeNull();
    expect(result.latestValidPosition).toBe(37);
  });

  describe("Task 3: Ranking Status Consistency Invariants", () => {
    it("classifies pos > 0 as RANKED", () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const snap: any = {
        position: 15,
        rankingStatus: "RANKED",
        completionConfidence: "CONFIRMED",
        url: "https://sports-ms.com/padel",
      };
      const res = toDeviceResult(snap, 20);
      expect(res.status).toBe("ranked");
      expect(res.rankingStatus).toBe("RANKED");
      expect(res.position).toBe(15);
    });

    it("classifies completed null / pos = 0 as not_ranking and NO_RESULT, NEVER as RANKED", () => {
      // Even if raw snapshot had rankingStatus: 'RANKED' erroneously, null position must never be RANKED
      // oxlint-disable-next-line typescript/no-explicit-any
      const snap: any = {
        position: null,
        rankingStatus: "RANKED", // erroneous DB value
        completionConfidence: "CONFIRMED",
      };
      const res = toDeviceResult(snap, 20);
      expect(res.status).toBe("not_ranking");
      expect(res.rankingStatus).toBe("NO_RESULT");
      expect(res.position).toBeNull();
      expect(res.rankingStatus).not.toBe("RANKED");
    });

    it("classifies provider failure as CHECK_FAILED and failed", () => {
      // oxlint-disable-next-line typescript/no-explicit-any
      const snap: any = {
        position: null,
        rankingStatus: "CHECK_FAILED",
        errorMessage: "UPSTREAM_UNAVAILABLE",
      };
      const res = toDeviceResult(snap, 20);
      expect(res.status).toBe("failed");
      expect(res.rankingStatus).toBe("CHECK_FAILED");
      expect(res.errorCode).toBe("UPSTREAM_UNAVAILABLE");
    });

    it("parses structured JSON providerStatus metadata as well as legacy text format", () => {
      const jsonMeta = parseProviderStatusMetadata(
        JSON.stringify({
          status: "Ok",
          providerChange: -12,
          landingPageObservedAt: "2026-11-11",
        }),
      );
      expect(jsonMeta.status).toBe("Ok");
      expect(jsonMeta.providerChange).toBe(-12);
      expect(jsonMeta.landingPageDate).toBe("2026-11-11");

      const legacyMeta = parseProviderStatusMetadata(
        "Ok (provider_change:-12, landing_page_observed:2026-11-11)",
      );
      expect(legacyMeta.status).toBe("Ok");
      expect(legacyMeta.providerChange).toBe(-12);
      expect(legacyMeta.landingPageDate).toBe("2026-11-11");
    });

    it("ensures a newly added Mobile engine with a single snapshot never fabricates previousPosition", () => {
      // Regression test for Section 1: Mobile has single snapshot (pos 35, previous_position null, providerChange 0)
      // oxlint-disable-next-line typescript/no-explicit-any
      const mobileSnap: any = {
        id: 9763,
        runId: "88697363-30a6-4c38-902d-abcb1c819382",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        device: "mobile",
        position: 35,
        previousPosition: null,
        rankingStatus: "RANKED",
        url: "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
        completionConfidence: "LIKELY_COMPLETE",
        provider: "seranking",
        providerStatus: JSON.stringify({
          status: "Ok",
          providerChange: 0,
          landingPageObservedAt: "2026-11-13",
        }),
        providerStatusCode: 200,
        checkedAt: "2026-11-13T17:38:42.000Z",
      };

      // When toDeviceResult is called for this first check, previousPosition must be null
      const result = toDeviceResult(mobileSnap, null, null);
      expect(result.position).toBe(35);
      expect(result.previousPosition).toBeNull();
      // providerChange is 0, which must NOT be treated as proof of a previous #35
      expect(result.providerChange).toBe(0);
      expect(result.status).toBe("ranked");
    });

    it("verifies Desktop displays both OpenSEO historical and SE Ranking daily comparison contexts", () => {
      // Regression test for Section 2:
      // Desktop current pos: 62
      // OpenSEO historical baseline (previousPosition): 37
      // SE Ranking daily delta (providerChange): -12 => daily previous was 62 - (-12) = 50
      // oxlint-disable-next-line typescript/no-explicit-any
      const desktopSnap: any = {
        id: 9762,
        runId: "88697363-30a6-4c38-902d-abcb1c819382",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        device: "desktop",
        position: 62,
        previousPosition: 37,
        rankingStatus: "RANKED",
        url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        completionConfidence: "LIKELY_COMPLETE",
        provider: "seranking",
        providerStatus: JSON.stringify({
          status: "Ok",
          providerChange: -12,
          landingPageObservedAt: "2026-11-11",
        }),
        providerStatusCode: 200,
        checkedAt: "2026-11-13T17:38:41.000Z",
      };

      const result = toDeviceResult(desktopSnap, 37, 37);
      expect(result.position).toBe(62);
      expect(result.previousPosition).toBe(37);
      expect(result.providerChange).toBe(-12);

      // Verify derived provider daily previous calculation:
      // Since change = previous - current, previous = current + change
      // 62 + (-12) = 50
      const seRankingDailyPrevious = result.position! + result.providerChange!;
      expect(seRankingDailyPrevious).toBe(50);
      expect(result.previousPosition).toBe(37);
    });

    it("verifies getLatestResults does not compare single mobile snapshot to itself as a baseline", async () => {
      // Mock repository methods for getLatestResults
      repoMocks.getConfigById.mockResolvedValue({
        id: "2971425d-d350-4ee3-89b2-c83567c87713",
        projectId: "367587e1-0c77-4d58-a2f8-7d7a171adfcb",
      });
      repoMocks.getKeywordsForConfig.mockResolvedValue([
        {
          id: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
          keyword: "إنشاء ملاعب متعددة الأغراض",
          searchVolume: 100,
          keywordDifficulty: 20,
          cpc: 0.5,
        },
      ]);

      const desktopSnap = {
        id: 9762,
        runId: "88697363-30a6-4c38-902d-abcb1c819382",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "desktop" as const,
        position: 62,
        previousPosition: 37,
        rankingStatus: "RANKED",
        url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        serpFeatures: null,
        provider: "seranking",
        providerStatus: JSON.stringify({
          status: "Ok",
          providerChange: -12,
          landingPageObservedAt: "2026-11-11",
        }),
        providerStatusCode: 200,
        errorMessage: null,
        completionConfidence: "LIKELY_COMPLETE",
        checkedAt: "2026-11-13 19:35:55",
      };

      const mobileSnap = {
        id: 9763,
        runId: "88697363-30a6-4c38-902d-abcb1c819382",
        trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "mobile" as const,
        position: 35,
        previousPosition: null,
        rankingStatus: "RANKED",
        url: "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
        serpFeatures: null,
        provider: "seranking",
        providerStatus: JSON.stringify({
          status: "Ok",
          providerChange: 0,
          landingPageObservedAt: "2026-11-13",
        }),
        providerStatusCode: 200,
        errorMessage: null,
        completionConfidence: "LIKELY_COMPLETE",
        checkedAt: "2026-11-13 18:21:26",
      };

      repoMocks.getLatestSnapshotsForKeywords.mockResolvedValue([
        desktopSnap,
        mobileSnap,
      ]);
      repoMocks.getLatestValidSnapshotsForKeywords.mockResolvedValue([
        desktopSnap,
        mobileSnap,
      ]);
      repoMocks.getValidDailySnapshotsForConfig.mockResolvedValue([
        {
          id: 5521,
          runId: "run-old",
          trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
          device: "desktop",
          position: 37,
          rankingStatus: "RANKED",
          checkedDate: "2026-10-04",
          checkedAt: "2026-10-04 10:00:00",
          completionConfidence: "CONFIRMED",
          provider: "seranking",
        },
        desktopSnap,
        mobileSnap,
      ]);
      // Comparison snapshots before 7 days ago:
      // Only desktop had an earlier snapshot (snapshot 5521 with pos 37)
      repoMocks.getSnapshotsBeforeDate.mockResolvedValue([
        {
          id: 5521,
          runId: "run-old",
          trackingKeywordId: "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
          device: "desktop",
          position: 37,
        },
      ]);
      // Earliest snapshots query (called for mobile since it had no snapshot before 7 days ago)
      // returns mobileSnap (id 9763) because it's the only snapshot that exists
      repoMocks.getEarliestSnapshotsForKeywords.mockResolvedValue([mobileSnap]);

      const results = await getLatestResults(
        "2971425d-d350-4ee3-89b2-c83567c87713",
        "367587e1-0c77-4d58-a2f8-7d7a171adfcb",
        "7d",
      );

      expect(results.rows).toHaveLength(1);
      const row = results.rows[0];

      // Desktop preserves historical comparison to #37
      expect(row.desktop.position).toBe(62);
      expect(row.desktop.previousPosition).toBe(37);
      expect(row.desktop.providerChange).toBe(-12);

      // Mobile displays #35 with previousPosition = null (NOT fabricated #35!)
      expect(row.mobile.position).toBe(35);
      expect(row.mobile.previousPosition).toBeNull();
      expect(row.mobile.providerChange).toBe(0);
    });
  });
});
