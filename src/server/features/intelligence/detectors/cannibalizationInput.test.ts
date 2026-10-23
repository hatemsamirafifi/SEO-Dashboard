import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getLatestFactDate: vi.fn(),
  getDailyGrainFacts: vi.fn(),
  hasCoverage: vi.fn(),
  getConfigsForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    GscSearchPerformanceRepository: {
      getLatestFactDate: mocks.getLatestFactDate,
      getDailyGrainFacts: mocks.getDailyGrainFacts,
      hasCoverage: mocks.hasCoverage,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigsForProject: mocks.getConfigsForProject,
    },
  }),
);

import { fetchCannibalizationInput } from "./cannibalizationInput";
import { InsufficientCoverageError, type DetectorContext } from "./types";

const LATEST = "2026-01-28";

function ctx(): DetectorContext {
  return {
    projectId: "p1",
    organizationId: "o1",
    periodFrom: "",
    periodTo: "",
    thresholds: {
      minWindowDays: 28,
      minCoverageRatio: 0.8,
      minUrls: 2,
      minImpressions: 50,
      dominantShare: 0.8,
      intentOverlapMax: 0.2,
      maxEvidenceRows: 200,
    },
    thresholdVersion: 5,
  };
}

function fact(date: string, query: string, page: string, impressions: number) {
  return {
    id: `${date}-${query}-${page}`,
    date,
    grainKey: `${query}::${page}`,
    query,
    page,
    clicks: 0,
    impressions,
    ctr: 0,
    position: 5,
  };
}

describe("fetchCannibalizationInput coverage integrity (spec 018)", () => {
  it("refuses to analyze when no query_page facts exist", async () => {
    mocks.getLatestFactDate.mockResolvedValue(null);

    await expect(fetchCannibalizationInput("p1", ctx())).rejects.toBeInstanceOf(
      InsufficientCoverageError,
    );
  });

  it("skips an unsynced window whose fact days are below the ratio", async () => {
    mocks.getLatestFactDate.mockResolvedValue(LATEST);
    mocks.getDailyGrainFacts.mockResolvedValue([
      fact("2026-01-28", "espresso", "https://example.com/a", 100),
    ]);
    mocks.hasCoverage.mockResolvedValue(false);

    await expect(fetchCannibalizationInput("p1", ctx())).rejects.toBeInstanceOf(
      InsufficientCoverageError,
    );
  });

  it("analyzes a synced window even when some days have no rows", async () => {
    mocks.getLatestFactDate.mockResolvedValue(LATEST);
    mocks.getDailyGrainFacts.mockImplementation(
      async (_projectId: string, _grain: string, from: string) => {
        if (from === "2025-12-04") return [];
        return [fact("2026-01-28", "espresso", "https://example.com/a", 100)];
      },
    );
    mocks.hasCoverage.mockResolvedValue(true);
    mocks.getConfigsForProject.mockResolvedValue([]);

    const input = await fetchCannibalizationInput("p1", ctx());

    expect(input.periodFrom).toBe("2026-01-01");
    expect(input.periodTo).toBe(LATEST);
    expect(input.periodFromPrior).toBe("2025-12-04");
    expect(input.periodToPrior).toBe("2025-12-31");
    expect(input.candidates).toHaveLength(1);
    expect(input.candidates[0]?.priorCovered).toBe(true);
  });

  it("marks the prior window as uncovered when its sync never ran", async () => {
    mocks.getLatestFactDate.mockResolvedValue(LATEST);
    mocks.getDailyGrainFacts.mockImplementation(
      async (_projectId: string, _grain: string, from: string) => {
        if (from === "2025-12-04") return [];
        return [fact("2026-01-28", "espresso", "https://example.com/a", 100)];
      },
    );
    mocks.hasCoverage.mockImplementation(
      async (_projectId: string, from: string) => from !== "2025-12-04",
    );
    mocks.getConfigsForProject.mockResolvedValue([]);

    const input = await fetchCannibalizationInput("p1", ctx());

    expect(input.candidates[0]?.priorCovered).toBe(false);
  });

  it("records which URLs started serving the query in the current window", async () => {
    mocks.getLatestFactDate.mockResolvedValue(LATEST);
    mocks.getDailyGrainFacts.mockImplementation(
      async (_projectId: string, _grain: string, from: string) => {
        if (from === "2025-12-04") {
          return [fact("2025-12-10", "espresso", "https://example.com/a", 100)];
        }
        return [
          fact("2026-01-28", "espresso", "https://example.com/a", 100),
          fact("2026-01-28", "espresso", "https://example.com/b", 100),
        ];
      },
    );
    mocks.hasCoverage.mockResolvedValue(true);
    mocks.getConfigsForProject.mockResolvedValue([]);

    const input = await fetchCannibalizationInput("p1", ctx());
    const candidate = input.candidates[0];

    expect(candidate?.priorUrls).toEqual(["https://example.com/a"]);
    expect(candidate?.shiftedIn).toEqual(["https://example.com/b"]);
    expect(candidate?.shiftedOut).toEqual([]);
  });

  it("caps evidence rows with the injected threshold", async () => {
    mocks.getLatestFactDate.mockResolvedValue(LATEST);
    mocks.getDailyGrainFacts.mockImplementation(
      async (_projectId: string, _grain: string, from: string) => {
        if (from === "2025-12-04") return [];
        return Array.from({ length: 40 }, (_, index) =>
          fact("2026-01-28", "espresso", `https://example.com/p${index}`, 100),
        );
      },
    );
    mocks.hasCoverage.mockResolvedValue(true);
    mocks.getConfigsForProject.mockResolvedValue([]);

    const input = await fetchCannibalizationInput("p1", ctx());

    expect(input.thresholds.maxEvidenceRows).toBe(200);
    expect(input.candidates[0]?.factIds.length).toBeLessThanOrEqual(200);
  });
});
