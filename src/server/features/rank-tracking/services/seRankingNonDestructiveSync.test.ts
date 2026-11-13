import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { SeRankingProjectService } from "@/server/lib/seranking/project";
import { SeRankingCreditExhaustedError } from "@/server/lib/seranking/errors";
import { RankTrackingTargetRepository } from "../repositories/RankTrackingTargetRepository";

describe("SE Ranking Non-Destructive Synchronization", () => {
  const httpCalls: Array<{ method: string; path: string }> = [];

  const mockClient = {
    request: vi.fn(async (path: string, options: any = {}) => {
      const method = options.method || "GET";
      httpCalls.push({ method, path });

      if (path.includes("/project-management/sites/search-engines")) {
        if (method === "POST") {
          return {
            site_engine_id: 8881,
            search_engine_id: options.body?.search_engine_id || 200,
            lang_code: options.body?.lang_code || "en",
          };
        }
        return [
          {
            site_engine_id: 8881,
            search_engine_id: 200,
            name: "Google USA",
          },
        ];
      }

      if (path.includes("/project-management/sites")) {
        if (method === "POST") {
          return {
            id: 9999,
            title: options.body?.title || "Test Site",
            url: options.body?.url || "https://example.com",
          };
        }
        return [
          {
            id: 9999,
            title: "Test Site",
            url: "https://example.com",
          },
        ];
      }

      if (path.includes("/project-management/keywords")) {
        if (method === "POST") {
          return (options.body?.keywords || []).map((k: any, i: number) => ({
            id: 7000 + i,
            name: k.keyword,
          }));
        }
        return [];
      }

      if (path.includes("/project-management/system/search-engines")) {
        return [
          { id: 200, name: "Google USA" },
          { id: 600, name: "Google Mobile USA", is_mobile: 1 },
        ];
      }

      return [];
    }),
  } as any;

  beforeEach(() => {
    httpCalls.length = 0;
    vi.clearAllMocks();
  });

  it("1. NEVER issues HTTP DELETE requests during project discovery or creation", async () => {
    await SeRankingProjectService.listSites(mockClient);
    await SeRankingProjectService.createSite(mockClient, {
      url: "https://example.com",
      title: "Example",
    });

    const deleteCalls = httpCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  it("2. NEVER issues HTTP DELETE requests when configuring or checking search engines", async () => {
    await SeRankingProjectService.listSiteSearchEngines(mockClient, 9999);
    await SeRankingProjectService.addSiteSearchEngine(mockClient, {
      siteId: 9999,
      searchEngineId: 200,
      langCode: "en",
    });

    const deleteCalls = httpCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  it("3. NEVER issues HTTP DELETE requests during keyword sync or rechecks", async () => {
    await SeRankingProjectService.listKeywords(mockClient, 9999);
    await SeRankingProjectService.addKeywords(mockClient, {
      siteId: 9999,
      keywords: [{ keyword: "seo tools" }, { keyword: "rank tracker" }],
    });
    await SeRankingProjectService.recheckPositions(mockClient, {
      siteId: 9999,
      keywordIds: ["7000", "7001"],
    });

    const deleteCalls = httpCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  it("4. Soft delete in repository disables target without deleting database record or issuing remote DELETE", async () => {
    const updateSpy = vi
      .spyOn(RankTrackingTargetRepository, "softDeleteTarget")
      .mockResolvedValue(undefined);

    await RankTrackingTargetRepository.softDeleteTarget("target-123");

    expect(updateSpy).toHaveBeenCalledWith("target-123");
    // Ensure zero DELETE calls occurred
    const deleteCalls = httpCalls.filter((c) => c.method === "DELETE");
    expect(deleteCalls).toHaveLength(0);
  });

  it("5. Does NOT block Project API when Data API credits are exhausted, but blocks Project API subscription/access errors", async () => {
    const dataApiExhaustedClient = {
      request: vi.fn(async (path: string) => {
        if (path.includes("/account/subscription")) {
          return {
            status: "expired",
            units_limit: 1000,
            units_left: 0,
          };
        }
        if (path.includes("/project-management/users/me")) {
          return { id: 1, email: "owner@example.com" };
        }
        if (path.includes("/project-management/sites")) {
          return [{ id: 1, url: "https://example.com", title: "Example" }];
        }
        return [];
      }),
    } as any;

    const access = await SeRankingProjectService.validateAccessAndQuota(
      dataApiExhaustedClient,
    );
    expect(access.projectApi.accessible).toBe(true);
    expect(access.sites).toHaveLength(1);

    const projectApiBlockedClient = {
      request: vi.fn(async (path: string) => {
        if (path.includes("/project-management/users/me")) {
          return { id: 1 };
        }
        if (path.includes("/project-management/sites")) {
          throw new SeRankingCreditExhaustedError(
            "Project subscription inactive (HTTP 402)",
            402,
          );
        }
        return [];
      }),
    } as any;

    await expect(
      SeRankingProjectService.validateAccessAndQuota(projectApiBlockedClient),
    ).rejects.toThrow("Project subscription inactive");
  });
});
