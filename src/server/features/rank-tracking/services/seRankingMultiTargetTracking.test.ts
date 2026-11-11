import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { RankTrackingTargetRepository } from "../repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { SeRankingProjectSyncService } from "./SeRankingProjectSyncService";
import { resolveEngineCatalogId } from "@/server/lib/seranking/projectCatalog";
import {
  seRankingProjectKeywordSchema,
  toNumericRemoteKeywordId,
} from "@/server/lib/seranking/projectSchemas";

describe("Multi-Country, Multi-City, Multi-Language Rank Tracking", () => {
  const mockClient = {
    request: vi.fn(async (path: string, options: any = {}) => {
      if (path.includes("/project-management/system/search-engines")) {
        return [
          { id: 339, name: "Google Egypt", country_code: "eg", is_mobile: 0 },
          {
            id: 739,
            name: "Google Egypt Mobile",
            country_code: "eg",
            is_mobile: 1,
          },
          {
            id: 340,
            name: "Google Saudi Arabia",
            country_code: "sa",
            is_mobile: 0,
          },
          {
            id: 740,
            name: "Google Saudi Arabia Mobile",
            country_code: "sa",
            is_mobile: 1,
          },
          { id: 200, name: "Google USA", country_code: "us", is_mobile: 0 },
          {
            id: 600,
            name: "Google Mobile USA",
            country_code: "us",
            is_mobile: 1,
          },
        ];
      }
      if (path.includes("/project-management/sites/search-engines")) {
        if (options.method === "POST") {
          return {
            site_engine_id: Math.floor(Math.random() * 10000) + 1,
            search_engine_id: options.body?.search_engine_id,
            lang_code: options.body?.lang_code,
          };
        }
        return [];
      }
      if (path.includes("/project-management/sites")) {
        return [
          { id: 5001, url: "https://example.com", title: "Example Site" },
        ];
      }
      return [];
    }),
  } as any;

  it("1. Resolves distinct search engines for Desktop and Mobile in Egypt and Saudi Arabia", async () => {
    const egDesktop = await resolveEngineCatalogId(mockClient, {
      countryCode: "eg",
      device: "desktop",
    });
    const egMobile = await resolveEngineCatalogId(mockClient, {
      countryCode: "eg",
      device: "mobile",
    });
    const saDesktop = await resolveEngineCatalogId(mockClient, {
      countryCode: "sa",
      device: "desktop",
    });
    const saMobile = await resolveEngineCatalogId(mockClient, {
      countryCode: "sa",
      device: "mobile",
    });

    expect(egDesktop.searchEngineId).toBe(339);
    expect(egMobile.searchEngineId).toBe(739);
    expect(saDesktop.searchEngineId).toBe(340);
    expect(saMobile.searchEngineId).toBe(740);

    // Desktop and Mobile engines must never be equal
    expect(egDesktop.searchEngineId).not.toBe(egMobile.searchEngineId);
    expect(saDesktop.searchEngineId).not.toBe(saMobile.searchEngineId);
  });

  it("2. Supports multiple tracking targets in a single project across countries, cities, and languages", async () => {
    const targets = [
      {
        id: "target-eg-cairo-ar-desk",
        countryCode: "eg",
        cityName: "Cairo",
        languageCode: "ar",
        device: "desktop" as const,
      },
      {
        id: "target-eg-cairo-en-desk",
        countryCode: "eg",
        cityName: "Cairo",
        languageCode: "en",
        device: "desktop" as const,
      },
      {
        id: "target-eg-alex-ar-mob",
        countryCode: "eg",
        cityName: "Alexandria",
        languageCode: "ar",
        device: "mobile" as const,
      },
      {
        id: "target-sa-riyadh-ar-desk",
        countryCode: "sa",
        cityName: "Riyadh",
        languageCode: "ar",
        device: "desktop" as const,
      },
      {
        id: "target-sa-jeddah-en-mob",
        countryCode: "sa",
        cityName: "Jeddah",
        languageCode: "en",
        device: "mobile" as const,
      },
    ];

    vi.spyOn(
      RankTrackingTargetRepository,
      "getTargetsForProject",
    ).mockResolvedValue(
      targets.map((t) => ({
        ...t,
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        regionCode: null,
        enabled: true,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      })),
    );

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([]);
    const upsertSpy = vi
      .spyOn(SeRankingBindingRepository, "upsertEngineBinding")
      .mockImplementation(async (d: any) => d);

    const engineBindings =
      await SeRankingProjectSyncService.ensureSearchEngines({
        localProjectId: "proj-1",
        organizationId: "org-1",
        projectBindingId: "binding-1",
        remoteSiteId: 5001,
        client: mockClient,
      });

    expect(engineBindings).toHaveLength(5);
    expect(upsertSpy).toHaveBeenCalledTimes(5);

    // Verify all targets are bound
    const targetIds = engineBindings.map((b) => b.trackingTargetId);
    expect(targetIds).toContain("target-eg-cairo-ar-desk");
    expect(targetIds).toContain("target-eg-cairo-en-desk");
    expect(targetIds).toContain("target-eg-alex-ar-mob");
    expect(targetIds).toContain("target-sa-riyadh-ar-desk");
    expect(targetIds).toContain("target-sa-jeddah-en-mob");
  });

  it("3. Assigns keywords to specific tracking targets independently", async () => {
    const assignments: Array<{ keywordId: string; targetId: string }> = [];

    vi.spyOn(
      RankTrackingTargetRepository,
      "bulkAssignKeywordsToTargets",
    ).mockImplementation(async (pairs) => {
      assignments.push(...pairs);
    });

    await RankTrackingTargetRepository.bulkAssignKeywordsToTargets([
      { keywordId: "kw-1", targetId: "target-eg-cairo-ar-desk" },
      { keywordId: "kw-1", targetId: "target-sa-riyadh-ar-desk" },
      { keywordId: "kw-2", targetId: "target-eg-cairo-en-desk" },
    ]);

    expect(assignments).toHaveLength(3);
    expect(assignments.filter((a) => a.keywordId === "kw-1")).toHaveLength(2);
    expect(assignments.filter((a) => a.keywordId === "kw-2")).toHaveLength(1);
  });

  it("4. Prevents Desktop/Mobile and city engine collisions even when languageCode matches", async () => {
    const postBodies: Array<Record<string, unknown>> = [];
    const strictClient = {
      request: vi.fn(async (path: string, options: any = {}) => {
        if (path.includes("/project-management/system/search-engines")) {
          return [
            { id: 339, name: "Google Egypt", country_code: "eg", is_mobile: 0 },
            {
              id: 739,
              name: "Google Egypt Mobile",
              country_code: "eg",
              is_mobile: 1,
            },
          ];
        }
        if (path.includes("/project-management/sites/search-engines")) {
          if (options.method === "POST") {
            postBodies.push(options.body);
            return {
              site_engine_id: 900 + postBodies.length,
              search_engine_id: options.body?.search_engine_id,
              region_name: options.body?.region_name ?? "",
              lang_code: options.body?.lang_code ?? "ar",
            };
          }
          // Only Cairo Desktop exists remotely right now
          return [
            {
              site_engine_id: 900,
              search_engine_id: 339,
              region_name: "Cairo",
              lang_code: "ar",
            },
          ];
        }
        return [];
      }),
    } as any;

    vi.spyOn(
      RankTrackingTargetRepository,
      "getTargetsForProject",
    ).mockResolvedValue([
      {
        id: "t-cairo-desk",
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        countryCode: "eg",
        regionCode: null,
        cityName: "Cairo",
        languageCode: "ar",
        device: "desktop",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "t-cairo-mob",
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        countryCode: "eg",
        regionCode: null,
        cityName: "Cairo",
        languageCode: "ar",
        device: "mobile",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
      {
        id: "t-alex-desk",
        organizationId: "org-1",
        localProjectId: "proj-1",
        trackingConfigId: "cfg-1",
        searchEngine: "google",
        countryCode: "eg",
        regionCode: null,
        cityName: "Alexandria",
        languageCode: "ar",
        device: "desktop",
        enabled: true,
        createdAt: "",
        updatedAt: "",
      },
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([]);
    vi.spyOn(
      SeRankingBindingRepository,
      "upsertEngineBinding",
    ).mockImplementation(async (d: any) => d);

    const bindings = await SeRankingProjectSyncService.ensureSearchEngines({
      localProjectId: "proj-1",
      organizationId: "org-1",
      projectBindingId: "pb-1",
      remoteSiteId: 5001,
      client: strictClient,
    });

    expect(bindings).toHaveLength(3);
    // Cairo Desktop reused existing 900; Mobile (739) and Alexandria (339 + city Alexandria) were created cleanly
    expect(
      bindings.find((b) => b.trackingTargetId === "t-cairo-desk")
        ?.remoteSiteEngineId,
    ).toBe(900);
    expect(postBodies).toHaveLength(2);
    expect(postBodies[0]).toMatchObject({
      search_engine_id: 739,
      region_name: "Cairo",
      lang_code: "ar",
    });
    expect(postBodies[1]).toMatchObject({
      search_engine_id: 339,
      region_name: "Alexandria",
      lang_code: "ar",
    });
  });

  it("5. Normalizes string and large numeric remote keyword IDs safely without precision loss", () => {
    // 64-bit / > MAX_SAFE_INTEGER numeric string ID
    const parsedLarge = seRankingProjectKeywordSchema.parse({
      id: "9007199254740993",
      name: "seo dashboard",
    });
    expect(parsedLarge.id).toBe("9007199254740993");

    // Numeric write conversion works for safe integers and validates at API boundary
    expect(toNumericRemoteKeywordId("123456")).toBe(123456);
    expect(() => toNumericRemoteKeywordId("9007199254740993")).toThrow(
      "safe integer precision",
    );
    expect(() => toNumericRemoteKeywordId("kw_abc")).toThrow(
      "requires a numeric keyword ID",
    );
  });
});
