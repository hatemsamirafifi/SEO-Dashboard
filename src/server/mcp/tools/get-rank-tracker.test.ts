import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  withPgClient: <T>(fn: () => Promise<T>): Promise<T> => fn(),
}));

const repoMocks = vi.hoisted(() => ({
  getConfigsForProject: vi.fn(),
  getConfigById: vi.fn(),
}));

const targetRepoMocks = vi.hoisted(() => ({
  getTargetsForProject: vi.fn(),
}));

const resultsMocks = vi.hoisted(() => ({
  getLatestResults: vi.fn(),
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({ RankTrackingRepository: repoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
  () => ({ RankTrackingTargetRepository: targetRepoMocks }),
);
vi.mock(
  "@/server/features/rank-tracking/services/rankTrackingResults",
  () => resultsMocks,
);

vi.mock("@/server/mcp/project-auth", () => ({
  withMcpProjectAuth: (handler: any) => (args: any) =>
    handler(args, {
      auth: { organizationId: "org-1" },
      baseUrl: "https://open-seo.test",
      project: { id: args.projectId, name: "Test Project" },
      projectMeta: {},
    }),
}));

import { getRankTrackerTool } from "./get-rank-tracker";

describe("getRankTrackerTool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns configs and targets for project when trackerId is omitted", async () => {
    repoMocks.getConfigsForProject.mockResolvedValue([
      {
        id: "cfg-1",
        domain: "example.com",
        locationCode: 2840,
        scheduleInterval: "weekly",
      },
    ]);

    targetRepoMocks.getTargetsForProject.mockResolvedValue([
      {
        id: "target-1",
        searchEngine: "google",
        countryCode: "eg",
        cityName: "Cairo",
        languageCode: "ar",
        device: "mobile",
        enabled: true,
      },
      {
        id: "target-2",
        searchEngine: "google",
        countryCode: "sa",
        cityName: "Riyadh",
        languageCode: "ar",
        device: "desktop",
        enabled: true,
      },
    ]);

    const result = (await getRankTrackerTool.handler(
      { projectId: "proj-1" },
      {} as any,
    )) as any;

    expect(result.structuredContent.configs).toHaveLength(1);
    expect(result.structuredContent.targets).toHaveLength(2);
    expect(result.content[0].text).toContain("EG/Cairo (ar) mobile");
    expect(result.content[0].text).toContain("SA/Riyadh (ar) desktop");
  });

  it("returns tracker details, targets, and keyword results when trackerId is provided", async () => {
    targetRepoMocks.getTargetsForProject.mockResolvedValue([
      {
        id: "target-1",
        searchEngine: "google",
        countryCode: "us",
        cityName: null,
        languageCode: "en",
        device: "desktop",
        enabled: true,
      },
    ]);

    repoMocks.getConfigById.mockResolvedValue({
      id: "cfg-1",
      domain: "example.com",
      devices: "both",
      serpDepth: 100,
      scheduleInterval: "daily",
    });

    resultsMocks.getLatestResults.mockResolvedValue({
      run: { id: "run-1", lastCheckedAt: "2026-11-11T12:00:00Z" },
      rows: [
        {
          trackingKeywordId: "kw-1",
          keyword: "best seo tool",
          desktop: { position: 3, previousPosition: 4 },
          mobile: { position: 2, previousPosition: 5 },
        },
      ],
    });

    const result = (await getRankTrackerTool.handler(
      { projectId: "proj-1", trackerId: "cfg-1" },
      {} as any,
    )) as any;

    expect(result.structuredContent.config.id).toBe("cfg-1");
    expect(result.structuredContent.targets).toHaveLength(1);
    expect(result.structuredContent.results.rows).toHaveLength(1);
    expect(result.content[0].text).toContain("best seo tool");
    expect(result.content[0].text).toContain("US (desktop)");
  });

  it("forwards optional targetId to getLatestResults when filtering a specific market/device target", async () => {
    targetRepoMocks.getTargetsForProject.mockResolvedValue([]);
    repoMocks.getConfigById.mockResolvedValue({
      id: "cfg-1",
      domain: "example.com",
      devices: "both",
      serpDepth: 100,
      scheduleInterval: "weekly",
    });
    resultsMocks.getLatestResults.mockResolvedValue({
      run: { id: "run-2", lastCheckedAt: "2026-11-11T12:00:00Z" },
      rows: [],
    });

    const targetUuid = "11111111-1111-4111-8111-111111111111";
    await getRankTrackerTool.handler(
      { projectId: "proj-1", trackerId: "cfg-1", targetId: targetUuid },
      {} as any,
    );

    expect(resultsMocks.getLatestResults).toHaveBeenCalledWith(
      "cfg-1",
      "proj-1",
      "7d",
      targetUuid,
    );
  });
});
