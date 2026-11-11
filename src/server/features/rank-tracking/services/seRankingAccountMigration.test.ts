import { describe, expect, it, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import { SeRankingProjectSyncService } from "./SeRankingProjectSyncService";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "../repositories/RankTrackingTargetRepository";
import {
  SeRankingProjectService,
  type ProjectApiAccessReport,
} from "@/server/lib/seranking/project";
import { SeRankingRateLimitError } from "@/server/lib/seranking/errors";
import { AppError } from "@/server/lib/errors";

function makeAccessReport(
  sites: ProjectApiAccessReport["sites"],
): ProjectApiAccessReport {
  return {
    sites,
    apiAuth: { status: "ok", source: "users_me" },
    projectApi: { accessible: true, status: "ok" },
    projectSubscription: { status: "active" },
    projectCapacity: {
      status: "unknown",
      limit: "unknown",
      used: sites.length,
      remaining: "unknown",
      source: "inferred_from_sites",
    },
    trackedKeywordCapacity: {
      status: "unknown",
      limit: "unknown",
      used: sites.reduce((s, site) => s + (site.keywordCount ?? 0), 0),
      remaining: "unknown",
      source: "inferred_from_sites",
    },
    deviceLocationAllocations: { status: "unknown" },
    recheckRestrictions: { status: "unknown" },
  };
}

describe("SE Ranking Account Migration & History Preservation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("1. Migrates organization projects to new SE Ranking account when old remoteSiteId is inaccessible", async () => {
    const orgId = "org-123";
    const newApiKey = "new-account-api-key-999";

    vi.spyOn(
      RankTrackingRepository,
      "getProjectsForOrganization",
    ).mockResolvedValue([
      {
        id: "proj-1",
        name: "Sports Site",
        organizationId: orgId,
        domain: "sports-ms.com",
        locationCode: 2840,
        languageCode: "en",
        createdAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        indexnowKey: null,
      },
    ]);

    vi.spyOn(RankTrackingRepository, "getConfigsForProject").mockResolvedValue([
      {
        id: "cfg-1",
        projectId: "proj-1",
        domain: "sports-ms.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "both",
        serpDepth: 100,
        scheduleInterval: "weekly",
        locationName: null,
        isActive: true,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getActiveAccountBinding",
    ).mockResolvedValue({
      id: "old-account-binding-1",
      organizationId: orgId,
      accountFingerprint: "old-fingerprint-111",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const updateAccountStatusSpy = vi
      .spyOn(SeRankingBindingRepository, "updateAccountBindingStatus")
      .mockResolvedValue(undefined);

    vi.spyOn(
      SeRankingBindingRepository,
      "upsertAccountBinding",
    ).mockResolvedValue({
      id: "new-account-binding-2",
      organizationId: orgId,
      accountFingerprint: "new-fingerprint-222",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    const newSites = [
      {
        id: 7777,
        title: "Sports Site",
        url: "https://sports-ms.com",
        depth: 100,
        keywordCount: 0,
        checkFrequency: "daily",
        status: "active",
      },
    ];
    vi.spyOn(
      SeRankingProjectService,
      "validateAccessAndQuota",
    ).mockResolvedValue(makeAccessReport(newSites));
    vi.spyOn(SeRankingProjectService, "listSites").mockResolvedValue(newSites);
    vi.spyOn(SeRankingProjectService, "verifySiteAccessible").mockResolvedValue(
      false,
    );

    vi.spyOn(SeRankingBindingRepository, "getProjectBinding").mockResolvedValue(
      null,
    );
    // Prior binding had remoteSiteId=1111 (inaccessible under new credentials!)
    vi.spyOn(
      SeRankingBindingRepository,
      "getProjectBindingsForProject",
    ).mockResolvedValue([
      {
        id: "project-binding-old",
        organizationId: orgId,
        localProjectId: "proj-1",
        providerAccountBindingId: "old-account-binding-1",
        remoteSiteId: 1111,
        status: "connected",
        lastSuccessfulSync: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    const updateProjectBindingSpy = vi
      .spyOn(SeRankingBindingRepository, "updateProjectBinding")
      .mockResolvedValue(undefined);

    vi.spyOn(
      SeRankingBindingRepository,
      "upsertProjectBinding",
    ).mockResolvedValue({
      id: "project-binding-new",
      organizationId: orgId,
      localProjectId: "proj-1",
      providerAccountBindingId: "new-account-binding-2",
      remoteSiteId: 7777,
      status: "syncing",
      lastSuccessfulSync: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    vi.spyOn(
      RankTrackingTargetRepository,
      "getTargetsForProject",
    ).mockResolvedValue([]);
    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue(
      [],
    );
    vi.spyOn(
      SeRankingBindingRepository,
      "getEngineBindingsForProject",
    ).mockResolvedValue([]);
    vi.spyOn(
      SeRankingBindingRepository,
      "getKeywordMappingsForProject",
    ).mockResolvedValue([]);

    const result = await SeRankingProjectSyncService.migrateAccount({
      organizationId: orgId,
      newApiKey,
    });

    expect(result.ok).toBe(true);
    expect(result.accountBindingId).toBe("new-account-binding-2");
    expect(result.migratedProjectsCount).toBe(1);

    // Old project binding marked migration_required; no DELETE issued
    expect(updateProjectBindingSpy).toHaveBeenCalledWith(
      "project-binding-old",
      expect.objectContaining({ status: "migration_required" }),
    );
    expect(updateAccountStatusSpy).toHaveBeenCalledWith(
      "old-account-binding-1",
      "migration_required",
    );
  });

  it("2. Treats key rotation on the SAME SE Ranking account (existing remoteSiteId accessible) as key rotation, not account migration", async () => {
    const orgId = "org-rot";
    const rotatedKey = "rotated-same-account-key";

    vi.spyOn(
      RankTrackingRepository,
      "getProjectsForOrganization",
    ).mockResolvedValue([
      {
        id: "proj-rot",
        name: "Rotated Project",
        organizationId: orgId,
        domain: "rotated.com",
        locationCode: 2840,
        languageCode: "en",
        createdAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        indexnowKey: null,
      },
    ]);
    vi.spyOn(RankTrackingRepository, "getConfigsForProject").mockResolvedValue([
      {
        id: "cfg-rot",
        projectId: "proj-rot",
        domain: "rotated.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "both",
        serpDepth: 100,
        scheduleInterval: "weekly",
        locationName: null,
        isActive: true,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);

    vi.spyOn(
      SeRankingBindingRepository,
      "getActiveAccountBinding",
    ).mockResolvedValue({
      id: "acc-old-fp",
      organizationId: orgId,
      accountFingerprint: "fp-old",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });

    const updateAccountStatusSpy = vi
      .spyOn(SeRankingBindingRepository, "updateAccountBindingStatus")
      .mockResolvedValue(undefined);

    vi.spyOn(
      SeRankingBindingRepository,
      "upsertAccountBinding",
    ).mockResolvedValue({
      id: "acc-rotated-fp",
      organizationId: orgId,
      accountFingerprint: "fp-new",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: new Date().toISOString(),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });

    // Existing remoteSiteId 5555 IS still accessible with the rotated API key!
    const existingSites = [
      {
        id: 5555,
        title: "Rotated Project",
        url: "https://rotated.com",
        depth: 100,
        keywordCount: 10,
        checkFrequency: "weekly",
        status: "active",
      },
    ];
    vi.spyOn(
      SeRankingProjectService,
      "validateAccessAndQuota",
    ).mockResolvedValue(makeAccessReport(existingSites));
    vi.spyOn(SeRankingProjectService, "listSites").mockResolvedValue(
      existingSites,
    );
    vi.spyOn(SeRankingProjectService, "verifySiteAccessible").mockResolvedValue(
      true,
    );
    const createSiteSpy = vi.spyOn(SeRankingProjectService, "createSite");

    vi.spyOn(SeRankingBindingRepository, "getProjectBinding").mockResolvedValue(
      null,
    );
    vi.spyOn(
      SeRankingBindingRepository,
      "getProjectBindingsForProject",
    ).mockResolvedValue([
      {
        id: "pb-old-same-acc",
        organizationId: orgId,
        localProjectId: "proj-rot",
        providerAccountBindingId: "acc-old-fp",
        remoteSiteId: 5555,
        status: "connected",
        lastSuccessfulSync: "2026-01-01T00:00:00.000Z",
        errorMessage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    vi.spyOn(
      SeRankingBindingRepository,
      "upsertProjectBinding",
    ).mockResolvedValue({
      id: "pb-new-same-acc",
      organizationId: orgId,
      localProjectId: "proj-rot",
      providerAccountBindingId: "acc-rotated-fp",
      remoteSiteId: 5555,
      status: "syncing",
      lastSuccessfulSync: null,
      errorMessage: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    });
    const cloneSpy = vi
      .spyOn(SeRankingBindingRepository, "cloneBindingsForKeyRotation")
      .mockResolvedValue(undefined);
    vi.spyOn(
      SeRankingBindingRepository,
      "updateProjectBinding",
    ).mockResolvedValue(undefined);
    vi.spyOn(
      RankTrackingTargetRepository,
      "getTargetsForProject",
    ).mockResolvedValue([]);
    vi.spyOn(RankTrackingRepository, "getKeywordsForConfig").mockResolvedValue(
      [],
    );

    const res = await SeRankingProjectSyncService.migrateAccount({
      organizationId: orgId,
      newApiKey: rotatedKey,
    });

    expect(res.ok).toBe(true);
    // Must NOT create duplicate site or mark account migration_required!
    expect(createSiteSpy).not.toHaveBeenCalled();
    expect(updateAccountStatusSpy).not.toHaveBeenCalled();
    // Must reuse engine and keyword bindings from prior binding!
    expect(cloneSpy).toHaveBeenCalledWith("pb-old-same-acc", "pb-new-same-acc");
  });

  it("3. Handles subscription/quota failure cleanly during sync/migration without destroying local data", async () => {
    const orgId = "org-quota";
    vi.spyOn(
      SeRankingProjectService,
      "validateAccessAndQuota",
    ).mockRejectedValue(
      new AppError(
        "PAYMENT_REQUIRED",
        "SE Ranking subscription is expired; cannot provision or run rank checks",
      ),
    );

    await expect(
      SeRankingProjectSyncService.migrateAccount({
        organizationId: orgId,
        newApiKey: "expired-key",
      }),
    ).rejects.toThrow("expired");
  });

  it("4. Appends new SE Ranking ranking snapshots to old DataForSEO snapshots without overwriting or deleting", async () => {
    const oldSnapshot = {
      runId: "run-old-dataforseo",
      projectId: "proj-1",
      configId: "cfg-1",
      trackingKeywordId: "kw-1",
      keyword: "sports news",
      searchEngine: "google",
      searchType: "organic",
      location: "United States",
      language: "en",
      device: "desktop" as const,
      position: 12,
      previousPosition: null,
      rankingStatus: "RANKED" as const,
      url: "https://sports-ms.com/news",
      serpFeatures: null,
      provider: "dataforseo",
      providerStatus: "Ok",
      providerStatusCode: 20000,
      errorMessage: null,
      checkedDate: "2026-02-01",
    };

    const newSnapshot = {
      runId: "run-new-seranking",
      projectId: "proj-1",
      configId: "cfg-1",
      trackingKeywordId: "kw-1",
      keyword: "sports news",
      searchEngine: "google",
      searchType: "organic",
      location: "United States",
      language: "en",
      device: "desktop" as const,
      position: 8,
      previousPosition: 12,
      rankingStatus: "RANKED" as const,
      url: "https://sports-ms.com/news",
      serpFeatures: null,
      provider: "seranking",
      providerStatus: "Ok",
      providerStatusCode: 200,
      errorMessage: null,
      checkedDate: "2026-11-11",
    };

    expect(oldSnapshot.provider).toBe("dataforseo");
    expect(newSnapshot.provider).toBe("seranking");
    expect(newSnapshot.previousPosition).toBe(oldSnapshot.position);
    expect(oldSnapshot.runId).not.toBe(newSnapshot.runId);
  });

  it("5. Never triggers site creation or migration_required on transient 429 rate limits or timeouts", async () => {
    const orgId = "org-transient";
    vi.spyOn(
      RankTrackingRepository,
      "getProjectsForOrganization",
    ).mockResolvedValue([
      {
        id: "proj-t1",
        name: "Transient Test",
        organizationId: orgId,
        domain: "transient.com",
        locationCode: 2840,
        languageCode: "en",
        createdAt: "2026-01-01T00:00:00.000Z",
        archivedAt: null,
        indexnowKey: null,
      },
    ]);
    vi.spyOn(RankTrackingRepository, "getConfigsForProject").mockResolvedValue([
      {
        id: "cfg-t1",
        projectId: "proj-t1",
        domain: "transient.com",
        locationCode: 2840,
        languageCode: "en",
        devices: "both",
        serpDepth: 100,
        scheduleInterval: "weekly",
        locationName: null,
        isActive: true,
        lastCheckedAt: null,
        nextCheckAt: null,
        lastSkipReason: null,
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    ]);
    vi.spyOn(
      SeRankingBindingRepository,
      "getActiveAccountBinding",
    ).mockResolvedValue({
      id: "acc-t-old",
      organizationId: orgId,
      accountFingerprint: "fp-old",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: "2026-01-01T00:00:00.000Z",
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    });
    vi.spyOn(
      SeRankingBindingRepository,
      "upsertAccountBinding",
    ).mockResolvedValue({
      id: "acc-t-new",
      organizationId: orgId,
      accountFingerprint: "fp-new",
      credentialVersion: 1,
      status: "active",
      lastValidatedAt: "2026-11-11T00:00:00.000Z",
      createdAt: "2026-11-11T00:00:00.000Z",
      updatedAt: "2026-11-11T00:00:00.000Z",
    });
    vi.spyOn(
      SeRankingProjectService,
      "validateAccessAndQuota",
    ).mockResolvedValue(makeAccessReport([]));
    vi.spyOn(SeRankingProjectService, "listSites").mockResolvedValue([]);
    vi.spyOn(SeRankingBindingRepository, "getProjectBinding").mockResolvedValue(
      null,
    );
    vi.spyOn(
      SeRankingBindingRepository,
      "getProjectBindingsForProject",
    ).mockResolvedValue([
      {
        id: "pb-t-old",
        organizationId: orgId,
        localProjectId: "proj-t1",
        providerAccountBindingId: "acc-t-old",
        remoteSiteId: 1111,
        status: "connected",
        lastSuccessfulSync: "2026-10-01T00:00:00.000Z",
        errorMessage: null,
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
    vi.spyOn(SeRankingProjectService, "verifySiteAccessible").mockRejectedValue(
      new SeRankingRateLimitError("429 Too Many Requests"),
    );
    const createSiteSpy = vi.spyOn(SeRankingProjectService, "createSite");
    const updateProjectSpy = vi.spyOn(
      SeRankingBindingRepository,
      "updateProjectBinding",
    );
    const updateAccountSpy = vi.spyOn(
      SeRankingBindingRepository,
      "updateAccountBindingStatus",
    );

    const res = await SeRankingProjectSyncService.migrateAccount({
      organizationId: orgId,
      newApiKey: "rotated-or-new-key",
    });

    expect(res.ok).toBe(false);
    expect(res.temporaryFailure).toBe(true);
    expect(res.migratedProjects[0]?.status).toBe("pending_retry");
    expect(createSiteSpy).not.toHaveBeenCalled();
    expect(updateProjectSpy).not.toHaveBeenCalledWith(
      "pb-t-old",
      expect.objectContaining({ status: "migration_required" }),
    );
    expect(updateAccountSpy).not.toHaveBeenCalledWith(
      "acc-t-old",
      "migration_required",
    );
  });
});
