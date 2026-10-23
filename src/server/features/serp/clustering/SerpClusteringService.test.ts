import { describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getKeywordCountForConfig: vi.fn(),
  getOrganicSnapshots: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordCountForConfig: mocks.getKeywordCountForConfig,
    },
  }),
);

vi.mock("./SerpOrganicSnapshotRepository", () => ({
  SerpOrganicSnapshotRepository: {
    getOrganicSnapshots: mocks.getOrganicSnapshots,
  },
}));

import { SerpClusteringService } from "./SerpClusteringService";

const CONFIG = {
  id: "cfg-1",
  projectId: "project-1",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
  locationName: null,
};

function row(input: {
  keyword: string;
  url: string;
  position: number;
  observedAt?: string;
}) {
  return {
    trackingKeywordId: `kw-${input.keyword}`,
    keyword: input.keyword,
    position: input.position,
    url: input.url,
    normalizedUrl: input.url,
    title: null,
    domain: new URL(input.url).hostname,
    provider: "dataforseo",
    coverageStatus: "full" as const,
    observedAt: input.observedAt ?? "2026-01-28T10:00:00.000Z",
    searchEngine: "google",
    locationCode: 2840,
    languageCode: "en",
    device: "desktop" as const,
  };
}

describe("SerpClusteringService.getClusters (spec 019)", () => {
  it("rejects a config outside the project", async () => {
    mocks.getConfigById.mockResolvedValue(null);

    await expect(
      SerpClusteringService.getClusters({
        projectId: "other-project",
        configId: "cfg-1",
        device: "desktop",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("clusters the stored pages and reports the coverage", async () => {
    mocks.getConfigById.mockResolvedValue(CONFIG);
    mocks.getKeywordCountForConfig.mockResolvedValue(4);
    mocks.getOrganicSnapshots.mockResolvedValue([
      row({ keyword: "k1", url: "https://example.com/1", position: 1 }),
      row({ keyword: "k1", url: "https://b.com/1", position: 2 }),
      row({ keyword: "k2", url: "https://example.com/1", position: 1 }),
      row({ keyword: "k2", url: "https://b.com/1", position: 2 }),
      row({ keyword: "k3", url: "https://example.com/1", position: 1 }),
      row({ keyword: "k3", url: "https://b.com/1", position: 2 }),
    ]);

    const report = await SerpClusteringService.getClusters({
      projectId: "project-1",
      configId: "cfg-1",
      device: "desktop",
    });

    expect(report.clusters).toHaveLength(1);
    expect(report.clusters[0]?.keywordCount).toBe(3);
    expect(report.clusters[0]?.newPageUrls).toEqual(["https://b.com/1"]);
    expect(report.coverage).toMatchObject({
      status: "insufficient_data",
      trackedKeywords: 4,
      coveredKeywords: 3,
      percent: 75,
    });
    expect(report.caveat).toContain("Forward-looking");
  });

  it("reports awaiting data when nothing was stored", async () => {
    mocks.getConfigById.mockResolvedValue(CONFIG);
    mocks.getKeywordCountForConfig.mockResolvedValue(4);
    mocks.getOrganicSnapshots.mockResolvedValue([]);

    const report = await SerpClusteringService.getClusters({
      projectId: "project-1",
      configId: "cfg-1",
      device: "desktop",
    });

    expect(report.clusters).toEqual([]);
    expect(report.coverage.status).toBe("awaiting_data");
    expect(report.coverage.percent).toBe(0);
  });

  it("reads only the requested market and device", async () => {
    mocks.getConfigById.mockResolvedValue(CONFIG);
    mocks.getKeywordCountForConfig.mockResolvedValue(1);
    mocks.getOrganicSnapshots.mockResolvedValue([]);

    await SerpClusteringService.getClusters({
      projectId: "project-1",
      configId: "cfg-1",
      device: "mobile",
    });

    expect(mocks.getOrganicSnapshots).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        configId: "cfg-1",
        device: "mobile",
        locationCode: 2840,
        languageCode: "en",
      }),
    );
  });
});
