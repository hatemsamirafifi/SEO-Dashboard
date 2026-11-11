import { createHash } from "node:crypto";
import { AppError } from "@/server/lib/errors";
import {
  createSeRankingClient,
  resolveEngineCatalogId,
  SeRankingProjectService,
  type SeRankingSite,
} from "@/server/lib/seranking";
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { RankTrackingTargetRepository } from "../repositories/RankTrackingTargetRepository";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { runAccountMigration } from "./seRankingAccountMigrationService";

export function computeAccountFingerprint(apiKey: string): string {
  return createHash("sha256").update(apiKey.trim()).digest("hex");
}

function normalizeDomainForMatch(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/.*$/, "");
}

function matchSiteDomain(site: SeRankingSite, domain: string): boolean {
  const normTarget = normalizeDomainForMatch(domain);
  const normUrl = normalizeDomainForMatch(site.url);
  const normTitle = site.title.trim().toLowerCase();
  return (
    normUrl === normTarget ||
    normUrl.endsWith(`.${normTarget}`) ||
    normTitle === normTarget
  );
}

async function ensureAccountBinding(params: {
  organizationId: string;
  apiKey: string;
}) {
  const fingerprint = computeAccountFingerprint(params.apiKey);
  const client = createSeRankingClient({ apiKey: params.apiKey });

  // Validate both Project API access AND subscription/quota health
  const accessInfo =
    await SeRankingProjectService.validateAccessAndQuota(client);

  const nowIso = new Date().toISOString();
  const binding = await SeRankingBindingRepository.upsertAccountBinding({
    id: crypto.randomUUID(),
    organizationId: params.organizationId,
    accountFingerprint: fingerprint,
    credentialVersion: 1,
    status: "active",
    lastValidatedAt: nowIso,
    createdAt: nowIso,
    updatedAt: nowIso,
  });

  return { binding, client, accessInfo };
}

async function ensureProject(params: {
  localProjectId: string;
  organizationId: string;
  domain: string;
  projectName?: string;
  apiKey?: string;
  client?: ReturnType<typeof createSeRankingClient>;
}) {
  let apiKey = params.apiKey;
  if (!apiKey) {
    const config = await resolveEffectiveSeRankingConfig({
      organizationId: params.organizationId,
      projectId: params.localProjectId,
    });
    if (!config.enabled || !config.apiKey) {
      throw new AppError(
        "VALIDATION_ERROR",
        "SE Ranking is not configured or enabled for this project",
      );
    }
    apiKey = config.apiKey;
  }

  const ensured = params.client
    ? {
        binding: (
          await SeRankingProjectSyncService.ensureAccountBinding({
            organizationId: params.organizationId,
            apiKey,
          })
        ).binding,
        client: params.client,
        sites: await SeRankingProjectService.listSites(params.client),
      }
    : await SeRankingProjectSyncService.ensureAccountBinding({
        organizationId: params.organizationId,
        apiKey,
      }).then((res) => ({
        binding: res.binding,
        client: res.client,
        sites: res.accessInfo.sites,
      }));

  const { binding: accountBinding, client, sites } = ensured;

  const [directBinding, priorBindings] = await Promise.all([
    SeRankingBindingRepository.getProjectBinding(
      params.localProjectId,
      accountBinding.id,
    ),
    SeRankingBindingRepository.getProjectBindingsForProject(
      params.localProjectId,
    ),
  ]);

  let remoteSiteId: number | null = null;
  let reusableBindingId: string | null = null;
  let migrationDetected = false;
  let confirmedInaccessiblePrior = false;

  // 1. Verify direct binding's remoteSiteId (direct probe rejects transient uncertainty)
  if (
    directBinding?.remoteSiteId &&
    (await SeRankingProjectService.verifySiteAccessible(
      client,
      directBinding.remoteSiteId,
      sites,
    ))
  ) {
    remoteSiteId = directBinding.remoteSiteId;
  }

  // 2. Credential verification: check if any prior binding's remoteSiteId
  // remains accessible with the current API key (API key rotation on SAME account).
  if (remoteSiteId === null) {
    for (const prior of priorBindings) {
      if (!prior.remoteSiteId || prior.id === directBinding?.id) continue;
      const accessible = await SeRankingProjectService.verifySiteAccessible(
        client,
        prior.remoteSiteId,
        sites,
      );
      if (accessible) {
        remoteSiteId = prior.remoteSiteId;
        reusableBindingId = prior.id;
        break;
      }
      confirmedInaccessiblePrior = true;
    }
  }

  // 3. Discover existing matching site in the current account, or create one
  // (only after non-transient verification above succeeded without ambiguity).
  if (remoteSiteId === null) {
    const matchedSite = sites.find((s) => matchSiteDomain(s, params.domain));
    if (matchedSite) {
      remoteSiteId = matchedSite.id;
    } else {
      const createdSite = await SeRankingProjectService.createSite(client, {
        url: `https://${params.domain}`,
        title: params.projectName || params.domain,
        depth: 100,
        subdomainMatch: true,
        checkFreq: "manual",
        autoReports: 0,
        disableAudit: 1,
      });
      remoteSiteId = createdSite.id;
    }
  }

  // 4. Only after reconciliation + replacement site discovery/creation succeeded,
  // mark confirmed inaccessible prior bindings as migration_required (never DELETE!).
  if (confirmedInaccessiblePrior && reusableBindingId === null) {
    migrationDetected = true;
    for (const prior of priorBindings) {
      if (prior.id !== directBinding?.id && prior.status === "connected") {
        await SeRankingBindingRepository.updateProjectBinding(prior.id, {
          status: "migration_required",
        });
      }
    }
  }

  const nowIso = new Date().toISOString();
  const projectBinding = await SeRankingBindingRepository.upsertProjectBinding({
    id: directBinding?.id || crypto.randomUUID(),
    organizationId: params.organizationId,
    localProjectId: params.localProjectId,
    providerAccountBindingId: accountBinding.id,
    remoteSiteId,
    status: "syncing",
    lastSuccessfulSync: directBinding?.lastSuccessfulSync ?? null,
    errorMessage: null,
    createdAt: directBinding?.createdAt || nowIso,
    updatedAt: nowIso,
  });

  if (reusableBindingId && reusableBindingId !== projectBinding.id) {
    await SeRankingBindingRepository.cloneBindingsForKeyRotation(
      reusableBindingId,
      projectBinding.id,
    );
  }

  return {
    projectBinding,
    client,
    remoteSiteId,
    migrationDetected,
  };
}

async function ensureSearchEngines(params: {
  localProjectId: string;
  organizationId: string;
  projectBindingId: string;
  remoteSiteId: number;
  client: ReturnType<typeof createSeRankingClient>;
  targetIds?: string[];
}) {
  let targets = await RankTrackingTargetRepository.getTargetsForProject(
    params.localProjectId,
    true,
  );
  if (params.targetIds && params.targetIds.length > 0) {
    const allowed = new Set(params.targetIds);
    targets = targets.filter((t) => allowed.has(t.id));
  }

  if (targets.length === 0) return [];

  const [existingEngineBindings, remoteEngines] = await Promise.all([
    SeRankingBindingRepository.getEngineBindingsForProject(
      params.projectBindingId,
    ),
    SeRankingProjectService.listSiteSearchEngines(
      params.client,
      params.remoteSiteId,
    ),
  ]);

  const results = [];

  for (const target of targets) {
    const existingBinding = existingEngineBindings.find(
      (b) => b.trackingTargetId === target.id,
    );

    const catalog = await resolveEngineCatalogId(params.client, {
      countryCode: target.countryCode,
      device: target.device,
    });

    let siteEngineId: number | null = null;
    if (
      existingBinding?.remoteSiteEngineId &&
      remoteEngines.some(
        (re) => re.siteEngineId === existingBinding.remoteSiteEngineId,
      )
    ) {
      siteEngineId = existingBinding.remoteSiteEngineId;
    }

    if (!siteEngineId) {
      const targetLang = target.languageCode.toLowerCase();
      const targetCity = target.cityName?.trim().toLowerCase() ?? "";

      const matchedRemote = remoteEngines.find((re) => {
        if (re.searchEngineId !== catalog.searchEngineId) return false;
        const remoteLang = re.langCode.trim().toLowerCase();
        if (remoteLang && remoteLang !== targetLang) return false;
        const remoteRegion = re.regionName.trim().toLowerCase();
        if (targetCity) {
          return remoteRegion === targetCity;
        }
        return !remoteRegion && (re.regionId ?? 0) === 0;
      });

      if (matchedRemote) {
        siteEngineId = matchedRemote.siteEngineId;
      }
    }

    if (!siteEngineId) {
      const added = await SeRankingProjectService.addSiteSearchEngine(
        params.client,
        {
          siteId: params.remoteSiteId,
          searchEngineId: catalog.searchEngineId,
          langCode: target.languageCode,
          regionName: target.cityName || undefined,
        },
      );
      siteEngineId = added.siteEngineId;
      remoteEngines.push(added);
    }

    const nowIso = new Date().toISOString();
    const binding = await SeRankingBindingRepository.upsertEngineBinding({
      id: existingBinding?.id || crypto.randomUUID(),
      projectBindingId: params.projectBindingId,
      trackingTargetId: target.id,
      remoteSiteEngineId: siteEngineId,
      remoteSearchEngineId: catalog.searchEngineId,
      remoteRegionId: existingBinding?.remoteRegionId ?? null,
      remoteRegionName: target.cityName || null,
      remoteLanguageCode: target.languageCode,
      syncStatus: "connected",
      lastSuccessfulSync: nowIso,
      createdAt: existingBinding?.createdAt || nowIso,
      updatedAt: nowIso,
    });

    results.push(binding);
  }

  return results;
}

async function syncTrackedKeywords(params: {
  localProjectId: string;
  configId: string;
  projectBindingId: string;
  remoteSiteId: number;
  client: ReturnType<typeof createSeRankingClient>;
}) {
  const localKeywords = await RankTrackingRepository.getKeywordsForConfig(
    params.configId,
  );
  if (localKeywords.length === 0) return [];

  const [existingMappings, remoteKeywords] = await Promise.all([
    SeRankingBindingRepository.getKeywordMappingsForProject(
      params.projectBindingId,
    ),
    SeRankingProjectService.listKeywords(params.client, params.remoteSiteId),
  ]);

  const remoteMap = new Map<string, string>();
  for (const rk of remoteKeywords) {
    remoteMap.set(rk.keyword.trim().toLowerCase(), rk.id);
  }

  const missingKeywords: Array<{ id: string; keyword: string }> = [];
  const mappingsToUpsert = [];
  const nowIso = new Date().toISOString();

  for (const kw of localKeywords) {
    const normalized = kw.keyword.trim().toLowerCase();
    const existingMapping = existingMappings.find(
      (m) => m.trackingKeywordId === kw.id,
    );
    const remoteId = remoteMap.get(normalized);

    if (remoteId !== undefined) {
      if (
        !existingMapping ||
        existingMapping.remoteKeywordId !== remoteId ||
        existingMapping.status !== "synced"
      ) {
        mappingsToUpsert.push({
          id: existingMapping?.id || crypto.randomUUID(),
          projectBindingId: params.projectBindingId,
          trackingKeywordId: kw.id,
          remoteKeywordId: remoteId,
          status: "synced" as const,
          createdAt: existingMapping?.createdAt || nowIso,
          updatedAt: nowIso,
        });
      }
      continue;
    }

    missingKeywords.push(kw);
  }

  if (missingKeywords.length > 0) {
    const added = await SeRankingProjectService.addKeywords(params.client, {
      siteId: params.remoteSiteId,
      keywords: missingKeywords.map((k) => ({ keyword: k.keyword })),
    });

    for (const addedKw of added) {
      const normalizedAdded = addedKw.keyword.trim().toLowerCase();
      const local = missingKeywords.find(
        (k) => k.keyword.trim().toLowerCase() === normalizedAdded,
      );
      if (local) {
        mappingsToUpsert.push({
          id: crypto.randomUUID(),
          projectBindingId: params.projectBindingId,
          trackingKeywordId: local.id,
          remoteKeywordId: addedKw.id,
          status: "synced" as const,
          createdAt: nowIso,
          updatedAt: nowIso,
        });
      }
    }
  }

  if (mappingsToUpsert.length > 0) {
    await SeRankingBindingRepository.bulkUpsertKeywordMappings(
      mappingsToUpsert,
    );
  }

  return mappingsToUpsert;
}

async function migrateAccount(params: {
  organizationId: string;
  newApiKey: string;
}) {
  return runAccountMigration(params, SeRankingProjectSyncService);
}

export const SeRankingProjectSyncService = {
  ensureAccountBinding,
  ensureProject,
  ensureSearchEngines,
  syncTrackedKeywords,
  migrateAccount,
};
