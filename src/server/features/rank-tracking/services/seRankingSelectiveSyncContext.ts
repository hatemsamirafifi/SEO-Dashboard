import { AppError } from "@/server/lib/errors";
import { type ProjectApiAccessReport } from "@/server/lib/seranking/projectAccess";
import {
  createSeRankingClient,
  SeRankingProjectService,
  type SeRankingProjectKeyword,
  type SeRankingSiteEngine,
} from "@/server/lib/seranking";
import { resolveEffectiveSeRankingConfig } from "@/server/features/settings/services/SeRankingSettingsService";
import { RankTrackingRepository } from "../repositories/RankTrackingRepository";
import { RankTrackingTargetRepository } from "../repositories/RankTrackingTargetRepository";
import { SeRankingBindingRepository } from "../repositories/SeRankingBindingRepository";
import { computeAccountFingerprint } from "./SeRankingProjectSyncService";
import { getIsoCountryCode } from "@/shared/keyword-locations";
import type { SeRankingSelectiveSyncEngineBindings } from "@/shared/seranking-selective-sync";

export interface SelectiveSyncConfig {
  id: string;
  domain: string;
  devices: "desktop" | "mobile" | "both";
  locationCode?: number;
  locationName?: string | null;
  languageCode?: string;
}

export interface SelectiveSyncLocalKeyword {
  id: string;
  keyword: string;
  assignedTargetIds: string[];
  hasExplicitAssignments: boolean;
}

export interface SelectiveSyncMappingRow {
  id: string;
  trackingKeywordId: string;
  remoteKeywordId: string;
  status: string;
  createdAt: string | null;
}

export interface SelectiveSyncEngineBindingRow {
  trackingTargetId: string;
  remoteSiteEngineId: number | null;
}

export interface SelectiveSyncTargetRow {
  id: string;
  device: "desktop" | "mobile";
}

export interface SelectiveSyncProjectBinding {
  id: string;
  remoteSiteId: number;
  status: string;
  lastSuccessfulSync: string | null;
}

/**
 * Storage boundary. Production wiring uses the real repositories; tests and
 * the e2e fixtures inject isolated stores.
 */
export interface SelectiveSyncStore {
  getConfig(
    configId: string,
    projectId: string,
  ): Promise<SelectiveSyncConfig | null>;
  getLocalKeywords(
    configId: string,
  ): Promise<Array<{ id: string; keyword: string }>>;
  getTargets(
    projectId: string,
    config: SelectiveSyncConfig,
  ): Promise<SelectiveSyncTargetRow[]>;
  getKeywordTargetAssignments(
    projectId: string,
  ): Promise<Record<string, string[]>>;
  getProjectBinding(
    localProjectId: string,
    accountBindingId: string,
  ): Promise<SelectiveSyncProjectBinding | null>;
  getEngineBindings(
    projectBindingId: string,
  ): Promise<SelectiveSyncEngineBindingRow[]>;
  getKeywordMappings(
    projectBindingId: string,
  ): Promise<SelectiveSyncMappingRow[]>;
  upsertKeywordMappings(
    rows: Array<{
      id: string;
      projectBindingId: string;
      trackingKeywordId: string;
      remoteKeywordId: string;
      status: "synced" | "partial" | "failed" | "pending";
      createdAt: string;
      updatedAt: string;
    }>,
  ): Promise<void>;
}

/** Provider transport boundary (mockable per HTTP response in tests). */
export interface SelectiveSyncTransport {
  validateAccessAndQuota(siteId: number): Promise<ProjectApiAccessReport>;
  listKeywords(siteId: number): Promise<SeRankingProjectKeyword[]>;
  listKeywordsForEngine(
    siteId: number,
    siteEngineId: number,
  ): Promise<SeRankingProjectKeyword[]>;
  listSiteSearchEngines(siteId: number): Promise<SeRankingSiteEngine[]>;
  addKeywordsOnce(
    siteId: number,
    keywords: Array<{ keyword: string; siteEngineIds: number[] }>,
  ): Promise<{ ok: boolean; added: number | null; ids: string[] }>;
  updateKeyword(params: {
    siteId: number;
    keywordId: string;
    keyword: string;
    groupId?: number;
    targetUrl?: string;
    siteEngineIds: number[];
  }): Promise<void>;
}

export type SelectiveSyncAccountResolution =
  | { status: "unconfigured" }
  | { status: "account_inactive" }
  | {
      status: "linked";
      accountBindingId: string;
      apiKey: string;
      baseUrl?: string;
      maxRetries?: number;
    };

export interface SeRankingSelectiveSyncDeps {
  store: SelectiveSyncStore;
  resolveAccount: (
    organizationId: string,
    projectId: string,
  ) => Promise<SelectiveSyncAccountResolution>;
  makeTransport: (
    apiKey: string,
    settings?: { baseUrl?: string; maxRetries?: number },
  ) => SelectiveSyncTransport;
}

// Production wiring

function productionStore(): SelectiveSyncStore {
  return {
    async getConfig(configId, projectId) {
      const config = await RankTrackingRepository.getConfigById({
        configId,
        projectId,
      });
      if (!config) return null;
      return {
        id: config.id,
        domain: config.domain,
        devices: config.devices,
        locationCode: config.locationCode,
        locationName: config.locationName,
        languageCode: config.languageCode,
      };
    },
    getLocalKeywords: (configId) =>
      RankTrackingRepository.getKeywordsForConfig(configId),
    getTargets: async (projectId, config) => {
      const rows = await RankTrackingTargetRepository.getTargetsForProject(
        projectId,
        true,
      );
      const market = getIsoCountryCode(
        config.locationCode ?? 2840,
      ).toLowerCase();
      const legacy = rows.filter(
        (target) =>
          target.trackingConfigId === null &&
          target.searchEngine === "google" &&
          target.countryCode.toLowerCase() === market &&
          target.languageCode.toLowerCase() ===
            config.languageCode?.toLowerCase() &&
          target.cityName === (config.locationName ?? null),
      );
      const scoped = rows.filter(
        (target) => target.trackingConfigId === config.id,
      );
      return [
        ...scoped,
        ...legacy.filter(
          (target) => !scoped.some((row) => row.device === target.device),
        ),
      ];
    },
    getKeywordTargetAssignments: async (projectId) => {
      const targets = await RankTrackingTargetRepository.getTargetsForProject(
        projectId,
        false,
      );
      const enabled = new Set(
        targets.filter((target) => target.enabled).map((target) => target.id),
      );
      const rows =
        await RankTrackingTargetRepository.getKeywordTargetsForTargets(
          targets.map((target) => target.id),
          false,
        );
      const byKeyword: Record<string, string[]> = {};
      for (const row of rows) {
        const assigned = (byKeyword[row.trackingKeywordId] ??= []);
        if (row.enabled && enabled.has(row.trackingTargetId))
          assigned.push(row.trackingTargetId);
      }
      return byKeyword;
    },
    getProjectBinding: async (localProjectId, accountBindingId) => {
      const row = await SeRankingBindingRepository.getProjectBinding(
        localProjectId,
        accountBindingId,
      );
      if (!row || row.remoteSiteId == null) return null;
      return {
        id: row.id,
        remoteSiteId: row.remoteSiteId,
        status: row.status,
        lastSuccessfulSync: row.lastSuccessfulSync,
      };
    },
    getEngineBindings: (projectBindingId) =>
      SeRankingBindingRepository.getEngineBindingsForProject(projectBindingId),
    getKeywordMappings: (projectBindingId) =>
      SeRankingBindingRepository.getKeywordMappingsForProject(projectBindingId),
    upsertKeywordMappings: (rows) =>
      SeRankingBindingRepository.bulkUpsertKeywordMappings(rows),
  };
}

async function productionResolveAccount(
  organizationId: string,
  projectId: string,
): Promise<SelectiveSyncAccountResolution> {
  const config = await resolveEffectiveSeRankingConfig({
    organizationId,
    projectId,
  });
  if (!config.enabled || !config.apiKey) {
    return { status: "unconfigured" };
  }
  const fingerprint = computeAccountFingerprint(config.apiKey);
  const account = await SeRankingBindingRepository.getAccountBinding(
    organizationId,
    fingerprint,
  );
  if (!account || account.status !== "active") {
    return { status: "account_inactive" };
  }
  return {
    status: "linked",
    accountBindingId: account.id,
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    maxRetries: config.maxRetries,
  };
}

function productionMakeTransport(
  apiKey: string,
  settings?: { baseUrl?: string; maxRetries?: number },
): SelectiveSyncTransport {
  const client = createSeRankingClient({ apiKey, ...settings });
  return {
    validateAccessAndQuota: (siteId) =>
      SeRankingProjectService.validateAccessAndQuota(client, {
        siteIdForEngineCheck: siteId,
      }),
    listKeywords: (siteId) =>
      SeRankingProjectService.listKeywords(client, siteId, undefined, true),
    listKeywordsForEngine: (siteId, engineId) =>
      SeRankingProjectService.listKeywords(client, siteId, engineId, true),
    listSiteSearchEngines: (siteId) =>
      SeRankingProjectService.listSiteSearchEngines(client, siteId, true),
    addKeywordsOnce: (siteId, keywords) =>
      SeRankingProjectService.addKeywordsOnce(client, {
        siteId,
        keywords,
      }),
    updateKeyword: async (params) => {
      await SeRankingProjectService.updateKeyword(client, params);
    },
  };
}

export function defaultSelectiveSyncDeps(): SeRankingSelectiveSyncDeps {
  return {
    store: productionStore(),
    resolveAccount: productionResolveAccount,
    makeTransport: productionMakeTransport,
  };
}

// Context resolution

export interface SelectiveSyncContext {
  config: SelectiveSyncConfig;
  projectBinding: SelectiveSyncProjectBinding;
  accountFingerprint: string;
  engineBindings: SeRankingSelectiveSyncEngineBindings;
  mappings: Map<string, SelectiveSyncMappingRow>;
  transport: SelectiveSyncTransport;
}

export async function resolveContext(params: {
  organizationId: string;
  projectId: string;
  configId: string;
  deps: SeRankingSelectiveSyncDeps;
}): Promise<
  | {
      linked: false;
      config: SelectiveSyncConfig;
      reason: "unconfigured" | "account_inactive" | "not_linked";
    }
  | ({ linked: true } & SelectiveSyncContext)
> {
  const config = await params.deps.store.getConfig(
    params.configId,
    params.projectId,
  );
  if (!config) {
    throw new AppError("NOT_FOUND", "Rank tracking config not found");
  }

  const account = await params.deps.resolveAccount(
    params.organizationId,
    params.projectId,
  );
  if (account.status === "unconfigured") {
    return { linked: false, config, reason: "unconfigured" };
  }
  if (account.status === "account_inactive") {
    return { linked: false, config, reason: "account_inactive" };
  }

  const projectBinding = await params.deps.store.getProjectBinding(
    params.projectId,
    account.accountBindingId,
  );
  if (
    !projectBinding ||
    !["connected", "failed"].includes(projectBinding.status)
  ) {
    return { linked: false, config, reason: "not_linked" };
  }

  const [engineBindingRows, targets, mappingRows] = await Promise.all([
    params.deps.store.getEngineBindings(projectBinding.id),
    params.deps.store.getTargets(params.projectId, config),
    params.deps.store.getKeywordMappings(projectBinding.id),
  ]);

  const byTargetId: Record<string, number | null> = {};
  const scopedTargets = new Set(targets.map((target) => target.id));
  for (const binding of engineBindingRows) {
    if (scopedTargets.has(binding.trackingTargetId)) {
      byTargetId[binding.trackingTargetId] = binding.remoteSiteEngineId;
    }
  }
  const deviceEngine = (device: "desktop" | "mobile") => {
    const ids = new Set(
      targets
        .filter((target) => target.device === device)
        .map((target) => byTargetId[target.id] ?? null),
    );
    return ids.size === 1 ? (ids.values().next().value ?? null) : null;
  };

  const mappings = new Map<string, SelectiveSyncMappingRow>();
  for (const row of mappingRows) {
    mappings.set(row.trackingKeywordId, row);
  }

  return {
    linked: true,
    config,
    projectBinding,
    accountFingerprint: computeAccountFingerprint(account.apiKey),
    engineBindings: {
      desktop: deviceEngine("desktop"),
      mobile: deviceEngine("mobile"),
      byTargetId,
    },
    mappings,
    transport: params.deps.makeTransport(account.apiKey, {
      baseUrl: account.baseUrl,
      maxRetries: account.maxRetries,
    }),
  };
}

export function notLinkedMessage(reason: string): string {
  switch (reason) {
    case "unconfigured":
      return "SE Ranking is not configured for this project";
    case "account_inactive":
      return "The SE Ranking account for this project is not active";
    default:
      return "This project is not linked to a SE Ranking project yet. Run the initial project sync first.";
  }
}
