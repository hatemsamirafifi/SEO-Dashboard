/* eslint-disable max-lines, max-lines-per-function */
import { describe, expect, it, vi } from "vitest";
import {
  extractCompetitorPosition,
  fetchCompetitorGapInput,
} from "./competitorGap";
import type { DetectorContext } from "./types";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const mockRepo = vi.hoisted(() => ({
  getLatestCompetitorSnapshotsForProject: vi.fn(),
  getProjectDomain: vi.fn(),
  getKeywordSearchVolumes: vi.fn(),
  getLatestFactDate: vi.fn(),
  getDailyGrainFacts: vi.fn(),
}));

vi.mock("@/server/lib/seo-data/competitor-snapshot-repository", () => ({
  getLatestCompetitorSnapshotsForProject:
    mockRepo.getLatestCompetitorSnapshotsForProject,
  getProjectDomain: mockRepo.getProjectDomain,
  getKeywordSearchVolumes: mockRepo.getKeywordSearchVolumes,
}));

vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    GscSearchPerformanceRepository: {
      getLatestFactDate: mockRepo.getLatestFactDate,
      getDailyGrainFacts: mockRepo.getDailyGrainFacts,
    },
  }),
);

const testThresholds = {
  minWindowDays: 28,
  minCoverageRatio: 0.8,
  minCompetitorRank: 10,
  maxFirstPartyPosition: 20,
  minVolume: 50,
};

const dummyCtx: DetectorContext = {
  projectId: "p1",
  organizationId: "org-1",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-28",
  thresholds: testThresholds,
  thresholdVersion: 3,
};

describe("per-keyword ranking correctness (Condition A)", () => {
  it("extracts exact rank from keywords_positions dictionary", () => {
    const item = {
      domain: "competitor.com",
      avg_position: 12.5,
      keywords_positions: {
        "seo dashboard": [3, 8],
        crm: [5],
      },
    };
    expect(extractCompetitorPosition(item, "seo dashboard")).toBe(3);
    expect(extractCompetitorPosition(item, "crm")).toBe(5);
  });

  it("extracts exact rank from direct position field on SERP item", () => {
    const item = {
      domain: "competitor.com",
      position: 4,
    };
    expect(extractCompetitorPosition(item, "any keyword")).toBe(4);
  });

  it("NEVER infers keyword-specific ranking solely from domain-level avg_position", () => {
    const item = {
      domain: "competitor.com",
      avg_position: 2.1,
    };
    // Must return null, not 2 or 2.1!
    expect(extractCompetitorPosition(item, "crm")).toBeNull();
  });

  it("skips finding when competitor has only domain avg_position and no per-keyword ranking", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [{ domain: "rival.com", avg_position: 2.0 }],
        fetchedAt: "2026-09-28T00:00:00Z",
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
    mockRepo.getProjectDomain.mockResolvedValueOnce("mysite.com");
    mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
      new Map([["crm", 500]]),
    );
    const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
      id: `fact-${i}`,
      date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      grain: "query",
      grainKey: "other keyword",
      impressions: 10,
      clicks: 1,
      position: 5,
    }));
    mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

    const input = await fetchCompetitorGapInput("p1", dummyCtx);
    expect(input.rows).toHaveLength(0);
  });

  it("does not infer first-party absence solely because GSC fact is missing if projectDomain is unknown", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [
          {
            domain: "rival.com",
            keywords_positions: { crm: [2] },
          },
        ],
        fetchedAt: "2026-09-28T00:00:00Z",
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
    mockRepo.getProjectDomain.mockResolvedValueOnce(null);
    mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
      new Map([["crm", 500]]),
    );
    const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
      id: `fact-${i}`,
      date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      grain: "query",
      grainKey: "other query",
      impressions: 10,
      clicks: 1,
      position: 5,
    }));
    mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

    const input = await fetchCompetitorGapInput("p1", dummyCtx);
    expect(input.rows).toHaveLength(0);
  });

  it("verifies first-party SERP presence from snapshot when projectDomain appears in SERP items", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [
          {
            domain: "rival.com",
            keywords_positions: { crm: [2] },
          },
          {
            domain: "mysite.com",
            keywords_positions: { crm: [6] },
          },
        ],
        fetchedAt: "2026-09-28T00:00:00Z",
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
    mockRepo.getProjectDomain.mockResolvedValueOnce("mysite.com");
    mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
      new Map([["crm", 500]]),
    );
    const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
      id: `fact-${i}`,
      date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      grain: "query",
      grainKey: "crm",
      impressions: 10,
      clicks: 1,
      position: 25,
    }));
    mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

    const input = await fetchCompetitorGapInput("p1", dummyCtx);
    expect(input.rows).toHaveLength(1);
    expect(input.rows[0]?.firstPartyPosition).toBe(6);
  });

  it("skips row when search volume is unavailable or below threshold (no volume fabrication)", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [
          {
            domain: "rival.com",
            keywords_positions: { crm: [2] },
          },
        ],
        fetchedAt: "2026-09-28T00:00:00Z",
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
    mockRepo.getProjectDomain.mockResolvedValueOnce("mysite.com");
    mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
      new Map([["crm", 10]]),
    );
    const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
      id: `fact-${i}`,
      date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
        .toISOString()
        .slice(0, 10),
      grain: "query",
      grainKey: "other",
      impressions: 10,
      clicks: 1,
      position: 5,
    }));
    mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

    const input = await fetchCompetitorGapInput("p1", dummyCtx);
    expect(input.rows).toHaveLength(0);
  });

  describe("real DataForSEO contract and snapshot completeness (Issue 2)", () => {
    it("handles official DataForSEO keywords_positions contract: arrays, multiple positions, empty, malformed", () => {
      // 1. Multiple positions e.g. [1, 3] -> selects best valid organic position (1)
      const officialItem = {
        domain: "emtyiaz.com",
        avg_position: 3.4,
        keywords_positions: {
          اسايمنت: [1, 3],
          "بحث تخرج": [7, 2, 9],
        },
      };
      expect(extractCompetitorPosition(officialItem, "اسايمنت")).toBe(1);
      expect(extractCompetitorPosition(officialItem, "بحث تخرج")).toBe(2);

      // 2. Empty array -> returns null
      const emptyArrItem = {
        domain: "comp.com",
        keywords_positions: {
          crm: [],
        },
      };
      expect(extractCompetitorPosition(emptyArrItem, "crm")).toBeNull();

      // 3. Malformed values in array -> filters to valid integers >= 1
      const malformedArrItem = {
        domain: "comp.com",
        keywords_positions: {
          crm: [null, undefined, "1", -2, 0, 4, 3.5],
        },
      };
      expect(extractCompetitorPosition(malformedArrItem, "crm")).toBe(4);

      // 4. Missing keyword entry -> returns null
      expect(extractCompetitorPosition(officialItem, "nonexistent")).toBeNull();

      // 5. Avg_position or median_position alone -> strictly returns null
      const avgOnlyItem = {
        domain: "comp.com",
        avg_position: 1.5,
        median_position: 2,
      };
      expect(extractCompetitorPosition(avgOnlyItem, "crm")).toBeNull();
    });

    it("skips finding when first-party domain is absent from a truncated competitor snapshot (total_count > items_count)", async () => {
      // DataForSEO SERP Competitors bounded response: total_count 85, items_count 50
      mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
        {
          id: 1,
          projectId: "p1",
          keywordKey: '["اسايمنت"]',
          keywords: ["اسايمنت"],
          locationCode: 2784,
          languageCode: "ar",
          totalCount: 85,
          itemsCount: 50,
          items: [
            {
              domain: "emtyiaz.com",
              avg_position: 2.5,
              keywords_positions: { اسايمنت: [1, 3] },
            },
          ],
          fetchedAt: "2026-09-28T00:00:00Z",
        },
      ]);
      mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
      mockRepo.getProjectDomain.mockResolvedValueOnce("powersiment.ae");
      mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
        new Map([["اسايمنت", 1669]]),
      );
      const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
        id: `fact-${i}`,
        date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
          .toISOString()
          .slice(0, 10),
        grain: "query",
        grainKey: "other",
        impressions: 10,
        clicks: 1,
        position: 5,
      }));
      mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

      // Because snapshot is truncated (85 > 50), powersiment.ae absence is unverified -> finding skipped
      const input = await fetchCompetitorGapInput("p1", dummyCtx);
      expect(input.rows).toHaveLength(0);
    });

    it("accepts finding when first-party domain is absent from a complete coverage-qualified snapshot (total_count <= items_count)", async () => {
      // DataForSEO SERP Competitors complete response: total_count 15, items_count 15
      mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
        {
          id: 1,
          projectId: "p1",
          keywordKey: '["اسايمنت"]',
          keywords: ["اسايمنت"],
          locationCode: 2784,
          languageCode: "ar",
          totalCount: 15,
          itemsCount: 15,
          items: [
            {
              domain: "emtyiaz.com",
              avg_position: 2.5,
              keywords_positions: { اسايمنت: [1, 3] },
            },
          ],
          fetchedAt: "2026-09-28T00:00:00Z",
        },
      ]);
      mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
      mockRepo.getProjectDomain.mockResolvedValueOnce("powersiment.ae");
      mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
        new Map([["اسايمنت", 1669]]),
      );
      const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
        id: `fact-${i}`,
        date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
          .toISOString()
          .slice(0, 10),
        grain: "query",
        grainKey: "other",
        impressions: 10,
        clicks: 1,
        position: 5,
      }));
      mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

      // Complete snapshot verifies true absence from SERP
      const input = await fetchCompetitorGapInput("p1", dummyCtx);
      expect(input.rows).toHaveLength(1);
      expect(input.rows[0]?.firstPartyPosition).toBeNull();
      expect(input.rows[0]?.competitors[0]?.domain).toBe("emtyiaz.com");
      expect(input.rows[0]?.competitors[0]?.position).toBe(1);
    });

    it("accepts finding when first-party rank is known (from GSC) even if competitor snapshot is truncated", async () => {
      mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
        {
          id: 1,
          projectId: "p1",
          keywordKey: '["اسايمنت"]',
          keywords: ["اسايمنت"],
          locationCode: 2784,
          languageCode: "ar",
          totalCount: 100,
          itemsCount: 50,
          items: [
            {
              domain: "emtyiaz.com",
              keywords_positions: { اسايمنت: [2] },
            },
          ],
          fetchedAt: "2026-09-28T00:00:00Z",
        },
      ]);
      mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
      mockRepo.getProjectDomain.mockResolvedValueOnce("powersiment.ae");
      mockRepo.getKeywordSearchVolumes.mockResolvedValueOnce(
        new Map([["اسايمنت", 1669]]),
      );
      // GSC fact shows first-party ranks at position 35 (position > maxFirstPartyPosition of 20)
      const dailyFacts = Array.from({ length: 56 }, (_, i) => ({
        id: `fact-${i}`,
        date: new Date(Date.parse("2026-09-28") - i * 86_400_000)
          .toISOString()
          .slice(0, 10),
        grain: "query",
        grainKey: "اسايمنت",
        impressions: 20,
        clicks: 1,
        position: 35,
      }));
      mockRepo.getDailyGrainFacts.mockResolvedValueOnce(dailyFacts);

      const input = await fetchCompetitorGapInput("p1", dummyCtx);
      expect(input.rows).toHaveLength(1);
      expect(input.rows[0]?.firstPartyPosition).toBe(35);
      expect(input.rows[0]?.competitors[0]?.domain).toBe("emtyiaz.com");
      expect(input.rows[0]?.competitors[0]?.position).toBe(2);
    });
  });
});
