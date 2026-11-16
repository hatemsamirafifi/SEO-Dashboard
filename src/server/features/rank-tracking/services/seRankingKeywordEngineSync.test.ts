import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { SeRankingProjectSyncService } from "./SeRankingProjectSyncService";
import { SeRankingProjectService } from "@/server/lib/seranking/project";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";

describe("SE Ranking Keyword Engine Association & Sync Regression Tests", () => {
  const mockClient = {
    request: vi.fn(),
  } as any;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. Associates existing keyword with newly created Mobile engine while preserving Desktop association", async () => {
    const DESKTOP_ENGINE_ID = 539194;
    const MOBILE_ENGINE_ID = 545914;

    // Local configuration: 1 keyword
    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue([
      { id: "kw-local-1", keyword: "إنشاء ملاعب متعددة الأغراض" } as any,
    ]);

    // Engine bindings: Both Desktop and newly created Mobile engine
    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([
      {
        id: "eb-1",
        projectBindingId: "pb-1",
        trackingTargetId: "target-desk",
        remoteSiteEngineId: DESKTOP_ENGINE_ID,
      } as any,
      {
        id: "eb-2",
        projectBindingId: "pb-1",
        trackingTargetId: "target-mob",
        remoteSiteEngineId: MOBILE_ENGINE_ID,
      } as any,
    ]);

    // Existing keyword mappings in local DB
    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([
      {
        id: "map-1",
        projectBindingId: "pb-1",
        trackingKeywordId: "kw-local-1",
        remoteKeywordId: "24606031",
        status: "synced",
      } as any,
    ]);

    // Remote keyword exists with ONLY Desktop engine
    vi.spyOn(SeRankingProjectService, "listKeywords").mockResolvedValue([
      {
        id: "24606031",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        groupId: 535759,
        targetUrl: undefined,
        siteEngineIds: [DESKTOP_ENGINE_ID],
      },
    ]);

    const updateKeywordSpy = vi
      .spyOn(SeRankingProjectService, "updateKeyword")
      .mockResolvedValue({ ok: true });
    const addKeywordsSpy = vi
      .spyOn(SeRankingProjectService, "addKeywords")
      .mockResolvedValue([]);
    const bulkUpsertSpy = vi
      .spyOn(SeRankingBindingRepository, "bulkUpsertKeywordMappings")
      .mockResolvedValue(undefined);

    await SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: "proj-1",
      configId: "cfg-1",
      projectBindingId: "pb-1",
      remoteSiteId: 13188608,
      client: mockClient,
    });

    // Verify updateKeyword was called with safe union containing BOTH engines
    expect(updateKeywordSpy).toHaveBeenCalledTimes(1);
    expect(updateKeywordSpy).toHaveBeenCalledWith(mockClient, {
      siteId: 13188608,
      keywordId: "24606031",
      keyword: "إنشاء ملاعب متعددة الأغراض",
      groupId: 535759,
      targetUrl: undefined,
      siteEngineIds: [DESKTOP_ENGINE_ID, MOBILE_ENGINE_ID],
    });

    // Verify NO duplicate keyword was created
    expect(addKeywordsSpy).not.toHaveBeenCalled();
    // Existing mapping was already up to date, so no DB re-write
    expect(bulkUpsertSpy).not.toHaveBeenCalled();
  });

  it("2. Preserves unrelated engine associations when syncing newly required engines", async () => {
    const DESKTOP_ENGINE_ID = 539194;
    const MOBILE_ENGINE_ID = 545914;
    const UNRELATED_EXTERNAL_ENGINE_ID = 999888;

    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue([
      { id: "kw-local-1", keyword: "padel court construction" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([
      {
        id: "eb-1",
        projectBindingId: "pb-1",
        trackingTargetId: "target-desk",
        remoteSiteEngineId: DESKTOP_ENGINE_ID,
      } as any,
      {
        id: "eb-2",
        projectBindingId: "pb-1",
        trackingTargetId: "target-mob",
        remoteSiteEngineId: MOBILE_ENGINE_ID,
      } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([
      {
        id: "map-1",
        projectBindingId: "pb-1",
        trackingKeywordId: "kw-local-1",
        remoteKeywordId: "24606031",
        status: "synced",
      } as any,
    ]);

    // Remote keyword has Desktop AND an unrelated engine (e.g. Bing or foreign region)
    vi.spyOn(SeRankingProjectService, "listKeywords").mockResolvedValue([
      {
        id: "24606031",
        keyword: "padel court construction",
        groupId: 12345,
        targetUrl: "https://example.com/padel",
        siteEngineIds: [DESKTOP_ENGINE_ID, UNRELATED_EXTERNAL_ENGINE_ID],
      },
    ]);

    const updateKeywordSpy = vi
      .spyOn(SeRankingProjectService, "updateKeyword")
      .mockResolvedValue({ ok: true });

    await SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: "proj-1",
      configId: "cfg-1",
      projectBindingId: "pb-1",
      remoteSiteId: 13188608,
      client: mockClient,
    });

    expect(updateKeywordSpy).toHaveBeenCalledTimes(1);
    const updatedEngines = updateKeywordSpy.mock.calls[0][1].siteEngineIds;
    // Must contain Desktop, Mobile, AND the unrelated engine
    expect(updatedEngines).toContain(DESKTOP_ENGINE_ID);
    expect(updatedEngines).toContain(MOBILE_ENGINE_ID);
    expect(updatedEngines).toContain(UNRELATED_EXTERNAL_ENGINE_ID);
    expect(updatedEngines).toEqual([
      DESKTOP_ENGINE_ID,
      MOBILE_ENGINE_ID,
      UNRELATED_EXTERNAL_ENGINE_ID,
    ]);
  });

  it("3. Handles multiple countries and languages across multiple search engines", async () => {
    // 4 engines: Egypt Desktop (ar), Egypt Mobile (ar), Saudi Desktop (ar), Saudi Mobile (en)
    const EG_DESKTOP = 101;
    const EG_MOBILE = 102;
    const SA_DESKTOP = 201;
    const SA_MOBILE = 202;

    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue([
      { id: "kw-1", keyword: "sports court" } as any,
      { id: "kw-2", keyword: "tennis court" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([
      { remoteSiteEngineId: EG_DESKTOP, trackingTargetId: "t-eg-desk" } as any,
      { remoteSiteEngineId: EG_MOBILE, trackingTargetId: "t-eg-mob" } as any,
      { remoteSiteEngineId: SA_DESKTOP, trackingTargetId: "t-sa-desk" } as any,
      { remoteSiteEngineId: SA_MOBILE, trackingTargetId: "t-sa-mob" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([
      {
        id: "m-1",
        trackingKeywordId: "kw-1",
        remoteKeywordId: "9001",
        status: "synced",
      } as any,
    ]);

    // kw-1 exists remotely with only EG Desktop; kw-2 is missing remotely
    vi.spyOn(SeRankingProjectService, "listKeywords").mockResolvedValue([
      {
        id: "9001",
        keyword: "sports court",
        groupId: 10,
        siteEngineIds: [EG_DESKTOP],
      },
    ]);

    const updateKeywordSpy = vi
      .spyOn(SeRankingProjectService, "updateKeyword")
      .mockResolvedValue({ ok: true });
    const addKeywordsSpy = vi
      .spyOn(SeRankingProjectService, "addKeywords")
      .mockResolvedValue([
        {
          id: "9002",
          keyword: "tennis court",
          siteEngineIds: [EG_DESKTOP, EG_MOBILE, SA_DESKTOP, SA_MOBILE],
        },
      ]);
    const bulkUpsertSpy = vi
      .spyOn(SeRankingBindingRepository, "bulkUpsertKeywordMappings")
      .mockResolvedValue(undefined);

    await SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: "proj-1",
      configId: "cfg-1",
      projectBindingId: "pb-1",
      remoteSiteId: 13188608,
      client: mockClient,
    });

    // Existing keyword updated with all 4 country/language engines
    expect(updateKeywordSpy).toHaveBeenCalledTimes(1);
    expect(updateKeywordSpy).toHaveBeenCalledWith(mockClient, {
      siteId: 13188608,
      keywordId: "9001",
      keyword: "sports court",
      groupId: 10,
      targetUrl: undefined,
      siteEngineIds: [EG_DESKTOP, EG_MOBILE, SA_DESKTOP, SA_MOBILE],
    });

    // Missing keyword added with all 4 country/language engines
    expect(addKeywordsSpy).toHaveBeenCalledTimes(1);
    expect(addKeywordsSpy).toHaveBeenCalledWith(mockClient, {
      siteId: 13188608,
      keywords: [
        {
          keyword: "tennis court",
          siteEngineIds: [EG_DESKTOP, EG_MOBILE, SA_DESKTOP, SA_MOBILE],
        },
      ],
    });
    expect(bulkUpsertSpy).toHaveBeenCalledTimes(1);
  });

  it("4. Idempotent synchronization: does not issue updates or adds when engines already match", async () => {
    const DESKTOP_ENGINE = 539194;
    const MOBILE_ENGINE = 545914;

    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue([
      { id: "kw-1", keyword: "إنشاء ملاعب متعددة الأغراض" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([
      {
        remoteSiteEngineId: DESKTOP_ENGINE,
        trackingTargetId: "t-desk",
      } as any,
      { remoteSiteEngineId: MOBILE_ENGINE, trackingTargetId: "t-mob" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([
      {
        id: "m-1",
        projectBindingId: "pb-1",
        trackingKeywordId: "kw-1",
        remoteKeywordId: "24606031",
        status: "synced",
      } as any,
    ]);

    // Remote keyword ALREADY has both engines
    vi.spyOn(SeRankingProjectService, "listKeywords").mockResolvedValue([
      {
        id: "24606031",
        keyword: "إنشاء ملاعب متعددة الأغراض",
        groupId: 535759,
        siteEngineIds: [DESKTOP_ENGINE, MOBILE_ENGINE],
      },
    ]);

    const updateKeywordSpy = vi
      .spyOn(SeRankingProjectService, "updateKeyword")
      .mockResolvedValue({ ok: true });
    const addKeywordsSpy = vi
      .spyOn(SeRankingProjectService, "addKeywords")
      .mockResolvedValue([]);
    const bulkUpsertSpy = vi
      .spyOn(SeRankingBindingRepository, "bulkUpsertKeywordMappings")
      .mockResolvedValue(undefined);

    await SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: "proj-1",
      configId: "cfg-1",
      projectBindingId: "pb-1",
      remoteSiteId: 13188608,
      client: mockClient,
    });

    // Zero API mutations should be made
    expect(updateKeywordSpy).not.toHaveBeenCalled();
    expect(addKeywordsSpy).not.toHaveBeenCalled();
    expect(bulkUpsertSpy).not.toHaveBeenCalled();
  });

  it("5. Never creates duplicate remote keywords when casing or whitespace differs", async () => {
    const ENGINE_ID = 539194;

    // Local has leading space and uppercase
    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue([
      { id: "kw-1", keyword: "  Padel Court Construction  " } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([
      { remoteSiteEngineId: ENGINE_ID, trackingTargetId: "t-desk" } as any,
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([]);

    // Remote has lowercase without trailing spaces
    vi.spyOn(SeRankingProjectService, "listKeywords").mockResolvedValue([
      {
        id: "8888",
        keyword: "padel court construction",
        siteEngineIds: [ENGINE_ID],
      },
    ]);

    const addKeywordsSpy = vi
      .spyOn(SeRankingProjectService, "addKeywords")
      .mockResolvedValue([]);
    const updateKeywordSpy = vi
      .spyOn(SeRankingProjectService, "updateKeyword")
      .mockResolvedValue({ ok: true });
    const bulkUpsertSpy = vi
      .spyOn(SeRankingBindingRepository, "bulkUpsertKeywordMappings")
      .mockResolvedValue(undefined);

    await SeRankingProjectSyncService.syncTrackedKeywords({
      localProjectId: "proj-1",
      configId: "cfg-1",
      projectBindingId: "pb-1",
      remoteSiteId: 13188608,
      client: mockClient,
    });

    // Matched case-insensitively, so NO new remote keyword was created
    expect(addKeywordsSpy).not.toHaveBeenCalled();
    expect(updateKeywordSpy).not.toHaveBeenCalled();
    // Mapping was linked to existing remote keyword 8888
    expect(bulkUpsertSpy).toHaveBeenCalledTimes(1);
    expect(bulkUpsertSpy.mock.calls[0][0][0]).toMatchObject({
      trackingKeywordId: "kw-1",
      remoteKeywordId: "8888",
      status: "synced",
    });
  });
});
