/**
 * Focused validation tests for the SE Ranking same-day async polling flow.
 *
 * Pins the same-day attribution properties introduced by the pre-recheck
 * baseline (FIX 1). `captureSeRankingRecheckBaseline` records, per engine,
 * whether SE Ranking already reported a check date >= today before the paid
 * recheck POST, plus a fingerprint of any today-dated observation. The poll
 * loop and the straggler handler then use that baseline to attribute
 * same-day data with a graded `completionConfidence`:
 *
 *  1. PENDING-ON-AMBIGUITY  — when the provider reports no check date >= today
 *     for an engine, observations stay pending and NO snapshot rows are
 *     fabricated from stale or unrelated data.
 *  2. UNCHANGED-POSITION SAFETY — a keyword whose positions payload has no
 *     dated entry for the target date is never converted into a completed
 *     snapshot.
 *  3. UNVERIFIED-ON-IDENTICAL — when the engine was pre-checked today and the
 *     observation is identical to the baseline fingerprint, the pair stays
 *     pending during polling; the straggler handler records it as UNVERIFIED
 *     rather than claiming this run's recheck completed it.
 *  4. CONFIRMED-ON-FRESH — when the engine had no check date >= today at
 *     baseline, a today-dated observation appearing after the POST is safely
 *     attributable: CONFIRMED.
 *  5. LIKELY-COMPLETE-ON-DELTA — when the engine was pre-checked today but the
 *     observation differs from the baseline fingerprint (position, URL, or
 *     SERP features), completion is recorded but graded LIKELY_COMPLETE:
 *     evidence of a new check, not proof.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as SeRankingLib from "@/server/lib/seranking";

const repoMocks = vi.hoisted(() => ({
  insertSnapshots: vi.fn(),
  insertProviderCalls: vi.fn(),
  getSnapshotsForRun: vi.fn(),
  updateRun: vi.fn(),
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
  recordSeRankingUncollected,
  type SeRankingPendingPair,
  type SeRankingRecheckBaseline,
} from "./seRankingCheckHelpers";
import { toDeviceResult } from "@/server/features/rank-tracking/services/rankTrackingResults";
import {
  extractPositionObservation,
  parsePositionsPayload,
} from "@/server/lib/seranking";

const today = new Date().toISOString().slice(0, 10);

function pair(
  overrides: Partial<SeRankingPendingPair> = {},
): SeRankingPendingPair {
  return {
    targetId: "t-desktop",
    trackingKeywordId: "kw-1",
    keyword: "best seo tool",
    device: "desktop",
    countryCode: "eg",
    cityName: "Cairo",
    languageCode: "ar",
    searchEngine: "google",
    remoteSiteEngineId: 101,
    remoteKeywordId: "555001",
    ...overrides,
  };
}

function positionItem(
  fields: {
    keyword_id?: string;
    name?: string;
    positions?: Array<Record<string, unknown>>;
  } = {},
) {
  return {
    keyword_id: fields.keyword_id ?? "555001",
    site_engine_id: 101,
    name: fields.name ?? "best seo tool",
    positions: fields.positions,
    normalizedKeywordId: String(fields.keyword_id ?? "555001"),
    normalizedKeyword: (fields.name ?? "best seo tool").trim(),
    serpFeaturesList: [],
  } as unknown as Parameters<typeof extractPositionObservation>[0];
}

/** Baseline asserting the engine was already checked today with pos 7 observed. */
function preCheckedBaseline(
  fingerprint: { position: number | null; url: string | null } = {
    position: 7,
    url: null,
  },
): SeRankingRecheckBaseline {
  return {
    "101": {
      hadTodayCheckDate: true,
      latestCheckDate: today,
      observations: {
        "555001": { ...fingerprint, serpFeatures: [] },
      },
    },
  };
}

/** Baseline asserting the engine had NO check date >= today before the POST. */
function freshBaseline(): SeRankingRecheckBaseline {
  return {
    "101": {
      hadTodayCheckDate: false,
      latestCheckDate: null,
      observations: {},
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repoMocks.insertSnapshots.mockResolvedValue(undefined);
  repoMocks.insertProviderCalls.mockResolvedValue(undefined);
  repoMocks.getSnapshotsForRun.mockResolvedValue([]);
  repoMocks.updateRun.mockResolvedValue(undefined);
});

describe("collectSeRankingPollRound — same-day async polling safety", () => {
  it("PENDING-ON-AMBIGUITY: engine with no check date >= today stays pending and records no snapshots", async () => {
    projectServiceMocks.getCheckDates.mockResolvedValue(["2026-01-01"]);
    projectServiceMocks.getPositions.mockResolvedValue([]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-1",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [pair()],
      previousPositions: new Map(),
    });

    expect(projectServiceMocks.getPositions).not.toHaveBeenCalled();
    expect(repoMocks.insertSnapshots).not.toHaveBeenCalled();
    expect(result.collectedCount).toBe(0);
    expect(result.stillPending).toHaveLength(1);
    expect(result.stillPending[0]?.targetId).toBe("t-desktop");
  });

  it("UNCHANGED-POSITION SAFETY: an entry with no dated observation for today is never recorded as completed", async () => {
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    // Positions payload exists, but the keyword carries only a stale date
    // entry (yesterday) — no observation for today.
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: "2026-01-01", pos: 7 }],
      }),
    ]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-1",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [pair()],
      previousPositions: new Map([["t-desktop:kw-1:desktop", 7]]),
    });

    expect(repoMocks.insertSnapshots).not.toHaveBeenCalled();
    expect(result.collectedCount).toBe(0);
    expect(result.stillPending).toHaveLength(1);
  });

  it("UNVERIFIED-ON-IDENTICAL: pre-checked engine whose today observation is identical to the baseline stays pending with no snapshot", async () => {
    // The engine already had a check today BEFORE this run's recheck, and the
    // provider returns the exact same observation (pos 7) — this cannot be
    // distinguished from the earlier run's stale data, so the pair must not
    // be confirmed as this run's completion.
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: today, pos: 7 }],
      }),
    ]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-2",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [pair()],
      previousPositions: new Map([["t-desktop:kw-1:desktop", 7]]),
      recheckBaseline: preCheckedBaseline(),
    });

    expect(result.collectedCount).toBe(0);
    expect(result.stillPending).toHaveLength(1);
    expect(repoMocks.insertSnapshots).not.toHaveBeenCalled();
  });

  it("CONFIRMED-ON-FRESH: baseline had no check today, so a today-dated observation after the POST is safely attributed", async () => {
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: today, pos: 5 }],
      }),
    ]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-2",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [pair()],
      previousPositions: new Map([["t-desktop:kw-1:desktop", 7]]),
      recheckBaseline: freshBaseline(),
    });

    expect(result.collectedCount).toBe(1);
    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.runId).toBe("run-2");
    expect(rows[0]?.position).toBe(5);
    expect(rows[0]?.previousPosition).toBe(7);
    expect(rows[0]?.checkedDate).toBe(today);
    expect(rows[0]?.completionConfidence).toBe("CONFIRMED");
  });

  it("LIKELY-COMPLETE-ON-DELTA: pre-checked engine whose today observation differs from the baseline is recorded as LIKELY_COMPLETE", async () => {
    // Baseline observed pos 7 before the POST; the provider now returns pos 5
    // — evidence of a NEW check, but not proof (another actor could have
    // produced the same delta), so confidence is graded accordingly.
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: today, pos: 5 }],
      }),
    ]);

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-2",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [pair()],
      previousPositions: new Map([["t-desktop:kw-1:desktop", 7]]),
      recheckBaseline: preCheckedBaseline(),
    });

    expect(result.collectedCount).toBe(1);
    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.position).toBe(5);
    expect(rows[0]?.previousPosition).toBe(7);
    expect(rows[0]?.checkedDate).toBe(today);
    expect(rows[0]?.completionConfidence).toBe("LIKELY_COMPLETE");
  });

  it("TARGET ISOLATION: observations persist per target+keyword+device with correct attribution", async () => {
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        name: "best seo tool",
        positions: [{ date: today, pos: 3 }],
      }),
    ]);

    await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      runId: "run-1",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs: [
        pair(),
        pair({
          targetId: "t-mobile",
          device: "mobile",
          remoteSiteEngineId: 102,
          remoteKeywordId: "555002",
        }),
      ],
      previousPositions: new Map(),
    });

    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);
    const targets = new Set(rows.map((r) => r.trackingTargetId));
    expect(targets).toEqual(new Set(["t-desktop", "t-mobile"]));
    expect(rows.every((r) => r.runId === "run-1")).toBe(true);
  });

  it("LIVE SCENARIO: pre-checked desktop and mobile engines with changed observations grade as LIKELY_COMPLETE, never CONFIRMED", async () => {
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockImplementation(
      async (_client: any, params: { siteEngineId: number }) => {
        if (params.siteEngineId === 539194) {
          return [
            positionItem({
              keyword_id: "24606031",
              name: "إنشاء ملاعب متعددة الأغراض",
              positions: [{ date: today, pos: 62 }],
            }),
          ];
        }
        if (params.siteEngineId === 545914) {
          return [
            positionItem({
              keyword_id: "24606031",
              name: "إنشاء ملاعب متعددة الأغراض",
              positions: [{ date: today, pos: 35 }],
            }),
          ];
        }
        return [];
      },
    );

    const recheckBaseline: SeRankingRecheckBaseline = {
      "539194": {
        hadTodayCheckDate: true,
        latestCheckDate: today,
        observations: {
          "24606031": { position: 50, url: null, serpFeatures: [] },
        },
      },
      "545914": {
        hadTodayCheckDate: true,
        latestCheckDate: today,
        observations: {
          "24606031": null,
        },
      },
    };

    const pendingPairs: SeRankingPendingPair[] = [
      pair({
        targetId: "t-desktop",
        trackingKeywordId: "kw-sports",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "desktop",
        remoteSiteEngineId: 539194,
        remoteKeywordId: "24606031",
      }),
      pair({
        targetId: "t-mobile",
        trackingKeywordId: "kw-sports",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        device: "mobile",
        remoteSiteEngineId: 545914,
        remoteKeywordId: "24606031",
      }),
    ];

    const result = await collectSeRankingPollRound({
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 13188608,
      runId: "run-live-1",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      pendingPairs,
      previousPositions: new Map([["t-desktop:kw-sports:desktop", 37]]),
      recheckBaseline,
    });

    expect(result.collectedCount).toBe(2);
    expect(result.stillPending).toHaveLength(0);

    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(2);

    const desktopRow = rows.find((r) => r.device === "desktop");
    const mobileRow = rows.find((r) => r.device === "mobile");

    expect(desktopRow).toBeDefined();
    expect(desktopRow?.position).toBe(62);
    expect(desktopRow?.previousPosition).toBe(37);
    expect(desktopRow?.rankingStatus).toBe("RANKED");
    expect(desktopRow?.completionConfidence).toBe("LIKELY_COMPLETE");

    expect(mobileRow).toBeDefined();
    expect(mobileRow?.position).toBe(35);
    expect(mobileRow?.previousPosition).toBeNull();
    expect(mobileRow?.rankingStatus).toBe("RANKED");
    expect(mobileRow?.completionConfidence).toBe("LIKELY_COMPLETE");

    // Must NEVER be labeled CONFIRMED when pre-checked same-day
    expect(rows.some((r) => r.completionConfidence === "CONFIRMED")).toBe(
      false,
    );
  });

  it("LIVE PAYLOAD PARSING: parsePositionsPayload and extractPositionObservation accurately extract nested array positions and landing pages", () => {
    const rawDesktopResponse = [
      {
        site_engine_id: 539194,
        keywords: [
          {
            id: "24606031",
            name: "إنشاء ملاعب متعددة الأغراض",
            positions: [
              { date: "2026-11-11", pos: 50 },
              { date: "2026-11-12", pos: 50 },
              { date: "2026-11-13", pos: 62, depth: 100, change: -12 },
            ],
            landing_pages: [
              {
                url: "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
                date: "2026-11-11",
              },
            ],
          },
        ],
      },
    ];

    const desktopItems = parsePositionsPayload(rawDesktopResponse);
    expect(desktopItems).toHaveLength(1);
    const desktopItem = desktopItems[0];
    expect(desktopItem.site_engine_id).toBe(539194);
    expect(desktopItem.normalizedKeywordId).toBe("24606031");

    const desktopObs = extractPositionObservation(desktopItem, "2026-11-13");
    expect(desktopObs.observed).toBe(true);
    expect(desktopObs.position).toBe(62);
    expect(desktopObs.url).toBe(
      "https://sports-ms.com/الخدمات/ملاعب-متعددة-الأغراض/",
    );

    const rawMobileResponse = [
      {
        site_engine_id: 545914,
        keywords: [
          {
            id: "24606031",
            name: "إنشاء ملاعب متعددة الأغراض",
            positions: [{ date: "2026-11-13", pos: 35, depth: 100, change: 0 }],
            landing_pages: [
              {
                url: "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
                date: "2026-11-13",
              },
            ],
          },
        ],
      },
    ];

    const mobileItems = parsePositionsPayload(rawMobileResponse);
    expect(mobileItems).toHaveLength(1);
    const mobileItem = mobileItems[0];
    expect(mobileItem.site_engine_id).toBe(545914);
    expect(mobileItem.normalizedKeywordId).toBe("24606031");

    const mobileObs = extractPositionObservation(mobileItem, "2026-11-13");
    expect(mobileObs.observed).toBe(true);
    expect(mobileObs.position).toBe(35);
    expect(mobileObs.url).toBe(
      "https://sports-ms.com/إنشاء-ملاعب-متعددة-الأغراض/",
    );
  });
});

describe("recordSeRankingUncollected — straggler attribution", () => {
  it("UNVERIFIED straggler: a pre-checked engine whose unchanged today observation is never promoted to CONFIRMED", async () => {
    // The polling window closed with the pair still pending (identical to the
    // baseline during every round). The straggler handler fetches one last
    // observation: identical fingerprint -> raw observation is stored with
    // completionConfidence = 'UNVERIFIED' (so the raw snapshot records what
    // the provider returned while read-side services/detectors mask UNVERIFIED
    // from appearing as a fresh ranking position or affecting position changes,
    // history trends, or SAM recommendations).
    projectServiceMocks.getCheckDates.mockResolvedValue([today]);
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: today, pos: 7 }],
      }),
    ]);

    await recordSeRankingUncollected({
      runId: "run-3",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      message:
        "SE Ranking queued recheck did not produce a completed observation within the polling window",
      rankingStatus: "CHECK_FAILED",
      pendingPairs: [pair()],
      previousPositions: new Map([["t-desktop:kw-1:desktop", 7]]),
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      recheckBaseline: preCheckedBaseline(),
    });

    expect(repoMocks.insertSnapshots).toHaveBeenCalledTimes(1);
    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows).toHaveLength(1);
    expect(rows[0]?.completionConfidence).toBe("UNVERIFIED");
    expect(rows[0]?.position).toBe(7);
    expect(rows[0]?.rankingStatus).toBe("RANKED");
    expect(rows[0]?.previousPosition).toBe(7);
    expect(String(rows[0]?.providerStatus)).toContain("Unverified");
    expect(rows[0]?.errorMessage).toBeNull();

    // Verify read-side masking: toDeviceResult never exposes an UNVERIFIED
    // observation as a fresh ranking position or position change.
    const deviceResult = toDeviceResult(
      {
        id: 1,
        trackingKeywordId: "kw-1",
        trackingTargetId: null,
        keyword: "best seo tool",
        position: 7,
        previousPosition: 7,
        url: "https://sports-ms.com/page",
        serpFeatures: '["sitelinks"]',
        device: "desktop",
        checkedAt: "2026-11-12 01:00:00",
        runId: "run-3",
        rankingStatus: "RANKED",
        errorMessage: null,
        providerStatus: String(rows[0]?.providerStatus),
        providerStatusCode: 200,
        provider: "seranking",
        completionConfidence: "UNVERIFIED",
      },
      12,
      10,
    );
    expect(deviceResult.position).toBeNull();
    expect(deviceResult.rankingUrl).toBeNull();
    expect(deviceResult.serpFeatures).toEqual([]);
    expect(deviceResult.status).toBe("failed");
    expect(deviceResult.rankingStatus).toBe("CHECK_FAILED");
    expect(deviceResult.latestValidPosition).toBe(10);
    expect(deviceResult.previousPosition).toBe(12);
  });

  it("NOT_CHECKED rows for a cancelled run keep no attribution claim even with a pre-checked baseline", async () => {
    // A cancelled run is an operator decision: rows stay NOT_CHECKED without
    // confidence, regardless of baseline state.
    projectServiceMocks.getPositions.mockResolvedValue([
      positionItem({
        positions: [{ date: today, pos: 7 }],
      }),
    ]);

    await recordSeRankingUncollected({
      runId: "run-4",
      projectId: "proj-1",
      configId: "cfg-1",
      today,
      message: "SE Ranking check was cancelled before completion",
      rankingStatus: "NOT_CHECKED",
      pendingPairs: [pair()],
      previousPositions: new Map(),
      // oxlint-disable-next-line typescript/no-explicit-any
      client: {} as any,
      remoteSiteId: 5001,
      recheckBaseline: preCheckedBaseline(),
    });

    const rows = repoMocks.insertSnapshots.mock.calls[0]?.[0] as Array<
      Record<string, unknown>
    >;
    expect(rows[0]?.rankingStatus).toBe("NOT_CHECKED");
    expect(rows[0]?.completionConfidence).toBeNull();
    expect(rows[0]?.position).toBeNull();
  });
});
