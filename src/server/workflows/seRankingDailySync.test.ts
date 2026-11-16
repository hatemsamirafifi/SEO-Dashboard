import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("cloudflare:workflows", () => ({
  NonRetryableError: class NonRetryableError extends Error {},
}));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>): Promise<T> => fn(),
  db: {
    select: vi.fn(),
  },
}));

import { synchronizeSeRankingDailyObservations } from "./seRankingDailySync";
import { dispatchSeRankingRecheck } from "./seRankingCheckDispatch";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import { SeRankingProjectService } from "@/server/lib/seranking";

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getLatestSnapshotDateForKeywordTarget: vi.fn(),
      findExistingSnapshotForObservation: vi.fn(),
      insertSnapshots: vi.fn(),
      insertProviderCalls: vi.fn(),
      getSnapshotsForRun: vi.fn(),
      updateRun: vi.fn(),
      getRunById: vi.fn(),
    },
  }),
);

vi.mock("@/server/lib/seranking", () => ({
  SeRankingProjectService: {
    getCheckDates: vi.fn(),
    getPositions: vi.fn(),
    recheckPositions: vi.fn(),
  },
  extractPositionObservation: vi.fn(),
}));

describe("SE Ranking Daily Synchronization & Read-Only Hardening", () => {
  const mockClient = {} as any;
  const mockPendingPairs = [
    {
      targetId: "target-desktop-1",
      trackingKeywordId: "kw-pilot-1",
      keyword: "إنشاء ملاعب متعددة الأغراض",
      device: "desktop" as const,
      countryCode: "EG",
      cityName: null,
      languageCode: "ar",
      searchEngine: "google",
      remoteKeywordId: "24606031",
      remoteSiteEngineId: 539194,
    },
    {
      targetId: "target-mobile-1",
      trackingKeywordId: "kw-pilot-1",
      keyword: "إنشاء ملاعب متعددة الأغراض",
      device: "mobile" as const,
      countryCode: "EG",
      cityName: null,
      languageCode: "ar",
      searchEngine: "google",
      remoteKeywordId: "24606031",
      remoteSiteEngineId: 545914,
    },
  ];

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(RankTrackingRepository.getSnapshotsForRun).mockResolvedValue(
      [] as any,
    );
  });

  it("1. Multi-Date Backfill: imports genuine dated observations from dateFrom to dateTo without duplicate re-insert", async () => {
    // Engine 539194 check dates has 2 dates: 2026-11-12 and 2026-11-13
    vi.mocked(SeRankingProjectService.getCheckDates).mockResolvedValue([
      "2026-11-12",
      "2026-11-13",
    ]);
    vi.mocked(
      RankTrackingRepository.getLatestSnapshotDateForKeywordTarget,
    ).mockResolvedValue("2026-11-12");

    // Existing snapshot exists for 2026-11-12 (identical: pos 50, url https://example.com/court) -> deduplicated!
    vi.mocked(
      RankTrackingRepository.findExistingSnapshotForObservation,
    ).mockImplementation(async (params: any) => {
      if (params.dateStr === "2026-11-12") {
        return {
          id: 9001,
          position: 50,
          url: "https://example.com/court",
          previousPosition: 37,
        } as any;
      }
      return null;
    });

    // Mock positions returned for the date range
    vi.mocked(SeRankingProjectService.getPositions).mockResolvedValue([
      {
        id: "24606031",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        normalizedKeywordId: "24606031",
        normalizedKeyword: "إنشاء ملاعب متعددة الأغراض",
        serpFeaturesList: ["snippets"],
        positions: [
          {
            date: "2026-11-12",
            pos: 50,
            landing_pages: [{ url: "https://example.com/court" }],
          },
          {
            date: "2026-11-13",
            pos: 62,
            change: -12,
            landing_pages: [
              { url: "https://example.com/court", date: "2026-11-11" },
            ],
          },
        ],
      } as any,
    ]);

    const { extractPositionObservation } =
      await import("@/server/lib/seranking");
    vi.mocked(extractPositionObservation).mockImplementation(
      (item: any, date?: string) => {
        if (date === "2026-11-12") {
          return {
            observed: true,
            position: 50,
            url: "https://example.com/court",
            serpFeatures: ["snippets"],
            observedDate: "2026-11-12",
            landingPageDate: null,
            providerChange: 0,
          };
        }
        if (date === "2026-11-13") {
          return {
            observed: true,
            position: 62,
            url: "https://example.com/court",
            serpFeatures: ["snippets"],
            observedDate: "2026-11-13",
            landingPageDate: "2026-11-11",
            providerChange: -12,
          };
        }
        return {
          observed: false,
          position: null,
          url: null,
          serpFeatures: [],
          observedDate: null,
        };
      },
    );

    const result = await synchronizeSeRankingDailyObservations({
      client: mockClient,
      remoteSiteId: 13188608,
      runId: "run-sync-1",
      projectId: "project-1",
      configId: "config-1",
      pendingPairs: [mockPendingPairs[0]], // desktop engine only for this test
      previousPositions: new Map(),
    });

    expect(result.collectedCount).toBe(1);
    expect(result.stillPending).toHaveLength(0);
    expect(result.deduplicatedCount).toBe(1); // 2026-11-12 was deduplicated!
    expect(result.importedCount).toBe(1); // 2026-11-13 was imported!

    // Verify insertSnapshots was called with 2026-11-13 snapshot
    expect(RankTrackingRepository.insertSnapshots).toHaveBeenCalledTimes(1);
    const inserted = vi.mocked(RankTrackingRepository.insertSnapshots).mock
      .calls[0][0];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.checkedDate).toBe("2026-11-13");
    expect(inserted[0]?.observationSource).toBe("daily_sync");
    expect(inserted[0]?.importedAt).toMatch(
      /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/,
    );
    expect(inserted[0]?.checkedAt).toBe(inserted[0]?.importedAt);
    expect(inserted[0]?.checkedAt).not.toBe("2026-11-13 12:00:00");
    expect(inserted[0]?.position).toBe(62);
    expect(inserted[0]?.completionConfidence).toBe("CONFIRMED");
    expect(JSON.parse(inserted[0]?.providerStatus ?? "{}")).toEqual({
      status: "SE Ranking daily position import (read-only sync)",
      providerChange: -12,
      landingPageObservedAt: "2026-11-11",
    });

    // Zero paid rechecks dispatched:
    expect(SeRankingProjectService.recheckPositions).not.toHaveBeenCalled();
  });

  it("2. Target Isolation: Desktop and Mobile targets are queried by siteEngineId and stored with respective targetId", async () => {
    vi.mocked(SeRankingProjectService.getCheckDates).mockResolvedValue([
      "2026-11-13",
    ]);
    vi.mocked(
      RankTrackingRepository.getLatestSnapshotDateForKeywordTarget,
    ).mockResolvedValue(null);
    vi.mocked(
      RankTrackingRepository.findExistingSnapshotForObservation,
    ).mockResolvedValue(null);

    vi.mocked(SeRankingProjectService.getPositions).mockImplementation(
      async (_client, params) => {
        if (params.siteEngineId === 539194) {
          return [
            {
              id: "24606031",
              keyword: "إنشاء ملاعب متعددة الأغراض",
              normalizedKeywordId: "24606031",
              normalizedKeyword: "إنشاء ملاعب متعددة الأغراض",
              serpFeaturesList: [],
              positions: [{ date: "2026-11-13", pos: 62 }],
            } as any,
          ];
        }
        if (params.siteEngineId === 545914) {
          return [
            {
              id: "24606031",
              keyword: "إنشاء ملاعب متعددة الأغراض",
              normalizedKeywordId: "24606031",
              normalizedKeyword: "إنشاء ملاعب متعددة الأغراض",
              serpFeaturesList: [],
              positions: [{ date: "2026-11-13", pos: 35 }],
            } as any,
          ];
        }
        return [];
      },
    );

    const { extractPositionObservation } =
      await import("@/server/lib/seranking");
    vi.mocked(extractPositionObservation).mockImplementation((item: any) => {
      const pos = item.positions?.[0]?.pos ?? 0;
      return {
        observed: true,
        position: pos,
        url: `https://example.com/target-${item.site_engine_id || "url"}`,
        serpFeatures: [],
        observedDate: "2026-11-13",
        landingPageDate: "2026-11-13",
        providerChange: 0,
      };
    });

    const result = await synchronizeSeRankingDailyObservations({
      client: mockClient,
      remoteSiteId: 13188608,
      runId: "run-sync-2",
      projectId: "project-1",
      configId: "config-1",
      pendingPairs: mockPendingPairs,
      previousPositions: new Map(),
    });

    expect(result.collectedCount).toBe(2);
    expect(result.stillPending).toHaveLength(0);
    expect(result.importedCount).toBe(2);

    const inserted = vi.mocked(RankTrackingRepository.insertSnapshots).mock
      .calls[0][0];
    expect(inserted).toHaveLength(2);

    const desktopSnap = inserted.find((s) => s.device === "desktop");
    const mobileSnap = inserted.find((s) => s.device === "mobile");

    expect(desktopSnap?.trackingTargetId).toBe("target-desktop-1");
    expect(desktopSnap?.position).toBe(62);

    expect(mobileSnap?.trackingTargetId).toBe("target-mobile-1");
    expect(mobileSnap?.position).toBe(35);
  });

  it("3. Strict Keyword Scoping: ignores unrelated remote keywords present in GET /sites/positions payload", async () => {
    vi.mocked(SeRankingProjectService.getCheckDates).mockResolvedValue([
      "2026-11-13",
    ]);
    vi.mocked(
      RankTrackingRepository.getLatestSnapshotDateForKeywordTarget,
    ).mockResolvedValue(null);
    vi.mocked(
      RankTrackingRepository.findExistingSnapshotForObservation,
    ).mockResolvedValue(null);

    // Payload returns approved keyword AND an unrelated keyword
    vi.mocked(SeRankingProjectService.getPositions).mockResolvedValue([
      {
        id: "99999999", // Unrelated keyword
        keyword: "unauthorized competitor term",
        normalizedKeywordId: "99999999",
        normalizedKeyword: "unauthorized competitor term",
        serpFeaturesList: [],
        positions: [{ date: "2026-11-13", pos: 1 }],
      } as any,
      {
        id: "24606031", // Approved keyword
        keyword: "إنشاء ملاعب متعددة الأغراض",
        normalizedKeywordId: "24606031",
        normalizedKeyword: "إنشاء ملاعب متعددة الأغراض",
        serpFeaturesList: [],
        positions: [{ date: "2026-11-13", pos: 62 }],
      } as any,
    ]);

    const { extractPositionObservation } =
      await import("@/server/lib/seranking");
    vi.mocked(extractPositionObservation).mockReturnValue({
      observed: true,
      position: 62,
      url: "https://example.com",
      serpFeatures: [],
      observedDate: "2026-11-13",
      landingPageDate: null,
      providerChange: null,
    });

    const result = await synchronizeSeRankingDailyObservations({
      client: mockClient,
      remoteSiteId: 13188608,
      runId: "run-sync-3",
      projectId: "project-1",
      configId: "config-1",
      pendingPairs: [mockPendingPairs[0]],
      previousPositions: new Map(),
    });

    expect(result.collectedCount).toBe(1);
    const inserted =
      vi.mocked(RankTrackingRepository.insertSnapshots).mock.calls[0]?.[0] ??
      [];
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.trackingKeywordId).toBe("kw-pilot-1");
    expect(inserted[0]?.keyword).toBe("إنشاء ملاعب متعددة الأغراض");
  });

  it("4. Hard Recheck Barrier: dispatchSeRankingRecheck strictly throws NonRetryableError when readOnlySync is true", async () => {
    await expect(
      dispatchSeRankingRecheck({
        client: mockClient,
        remoteSiteId: 13188608,
        runId: "run-guard-1",
        configId: "config-guard-1",
        dispatchScope: JSON.stringify([
          { siteEngineId: 539194, remoteKeywordId: "24606031" },
        ]),
        recheckParams: { siteId: 13188608 },
        readOnlySync: true,
      }),
    ).rejects.toThrowError(/strictly forbidden in read-only sync mode/);
  });

  it("5. Multi-Day Backfill with Missing Dates & Idempotency: imports available Nov 15, 17, 18, skips missing Nov 16 without fabricating, and ensures repeated calls are idempotent", async () => {
    // Check dates on SE Ranking: 2026-11-14 (already imported), 2026-11-15, 2026-11-17, 2026-11-18 (2026-11-16 was not checked by provider)
    vi.mocked(SeRankingProjectService.getCheckDates).mockResolvedValue([
      "2026-11-14",
      "2026-11-15",
      "2026-11-17",
      "2026-11-18",
    ]);
    vi.mocked(
      RankTrackingRepository.getLatestSnapshotDateForKeywordTarget,
    ).mockResolvedValue("2026-11-14");

    // Existing snapshot for 2026-11-14 exists
    vi.mocked(
      RankTrackingRepository.findExistingSnapshotForObservation,
    ).mockImplementation(async (params: any) => {
      if (params.dateStr === "2026-11-14") {
        return {
          id: 9770,
          position: 86,
          url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        } as any;
      }
      return null;
    });

    vi.mocked(SeRankingProjectService.getPositions).mockResolvedValue([
      {
        id: "24606031",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        normalizedKeywordId: "24606031",
        normalizedKeyword: "إنشاء ملاعب متعددة الأغراض",
        serpFeaturesList: [],
        positions: [
          {
            date: "2026-11-14",
            pos: 86,
            landing_pages: [
              {
                url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
                date: "2026-11-11",
              },
            ],
          },
          {
            date: "2026-11-15",
            pos: 84,
            change: 2,
            landing_pages: [
              {
                url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
                date: "2026-11-11",
              },
            ],
          },
          {
            date: "2026-11-17",
            pos: 82,
            change: 2,
            landing_pages: [
              {
                url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
                date: "2026-11-17",
              },
            ],
          },
          {
            date: "2026-11-18",
            pos: 80,
            change: 2,
            landing_pages: [
              {
                url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
                date: "2026-11-17",
              },
            ],
          },
        ],
      } as any,
    ]);

    const { extractPositionObservation } =
      await import("@/server/lib/seranking");
    vi.mocked(extractPositionObservation).mockImplementation(
      (item: any, date?: string) => {
        if (date === "2026-11-14") {
          return {
            observed: true,
            position: 86,
            url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
            serpFeatures: [],
            observedDate: "2026-11-14",
            landingPageDate: "2026-11-11",
            providerChange: -1,
          };
        }
        if (date === "2026-11-15") {
          return {
            observed: true,
            position: 84,
            url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
            serpFeatures: [],
            observedDate: "2026-11-15",
            landingPageDate: "2026-11-11",
            providerChange: 2,
          };
        }
        if (date === "2026-11-17") {
          return {
            observed: true,
            position: 82,
            url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
            serpFeatures: [],
            observedDate: "2026-11-17",
            landingPageDate: "2026-11-17",
            providerChange: 2,
          };
        }
        if (date === "2026-11-18") {
          return {
            observed: true,
            position: 80,
            url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
            serpFeatures: [],
            observedDate: "2026-11-18",
            landingPageDate: "2026-11-17",
            providerChange: 2,
          };
        }
        // Missing date (e.g. 2026-11-16)
        return {
          observed: false,
          position: null,
          url: null,
          serpFeatures: [],
          observedDate: null,
        };
      },
    );

    const result = await synchronizeSeRankingDailyObservations({
      client: mockClient,
      remoteSiteId: 13188608,
      runId: "run-backfill-test",
      projectId: "project-1",
      configId: "config-1",
      pendingPairs: [mockPendingPairs[0]], // desktop engine
      previousPositions: new Map(),
    });

    expect(result.collectedCount).toBe(1);
    expect(result.deduplicatedCount).toBe(1); // 2026-11-14 was deduplicated
    expect(result.importedCount).toBe(3); // 2026-11-15, 2026-11-17, 2026-11-18

    const inserted =
      vi.mocked(RankTrackingRepository.insertSnapshots).mock.calls[0]?.[0] ??
      [];
    expect(inserted).toHaveLength(3);

    // Verify dates imported
    const importedDates = inserted.map((s) => s.checkedDate);
    expect(importedDates).toEqual(["2026-11-15", "2026-11-17", "2026-11-18"]);
    expect(importedDates).not.toContain("2026-11-16"); // Missing date was NOT fabricated

    // Verify landing page dates
    const landing15 = JSON.parse(inserted[0]?.providerStatus ?? "{}");
    const landing17 = JSON.parse(inserted[1]?.providerStatus ?? "{}");
    expect(landing15.landingPageObservedAt).toBe("2026-11-11");
    expect(landing17.landingPageObservedAt).toBe("2026-11-17");

    // Replay idempotency test: when all these snapshots now exist in the DB, running sync again imports 0 rows
    vi.mocked(RankTrackingRepository.insertSnapshots).mockClear();
    vi.mocked(
      RankTrackingRepository.findExistingSnapshotForObservation,
    ).mockImplementation(async (params: any) => {
      if (params.dateStr === "2026-11-14")
        return {
          position: 86,
          url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        } as any;
      if (params.dateStr === "2026-11-15")
        return {
          position: 84,
          url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        } as any;
      if (params.dateStr === "2026-11-17")
        return {
          position: 82,
          url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        } as any;
      if (params.dateStr === "2026-11-18")
        return {
          position: 80,
          url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
        } as any;
      return null;
    });

    const replayResult = await synchronizeSeRankingDailyObservations({
      client: mockClient,
      remoteSiteId: 13188608,
      runId: "run-backfill-replay",
      projectId: "project-1",
      configId: "config-1",
      pendingPairs: [mockPendingPairs[0]],
      previousPositions: new Map(),
    });

    expect(replayResult.importedCount).toBe(0);
    expect(replayResult.deduplicatedCount).toBe(4);
    expect(RankTrackingRepository.insertSnapshots).not.toHaveBeenCalled();
  });
});
