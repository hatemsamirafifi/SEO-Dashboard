import { AppError } from "@/server/lib/errors";
import {
  classifyProjectApiError,
  type ProjectApiAccessReport,
  type ProjectQuotaDimension,
} from "@/server/lib/seranking/projectAccess";
import {
  normalizeKeywordIdentity,
  selectKeywordsWithWork,
  type SeRankingSelectiveSyncEngineBindings,
  type SeRankingSelectiveSyncPlan,
} from "@/shared/seranking-selective-sync";
import {
  defaultSelectiveSyncDeps,
  notLinkedMessage,
  resolveContext,
  type SeRankingSelectiveSyncDeps,
} from "./seRankingSelectiveSyncContext";
import {
  buildPlan,
  readRemoteInventory,
  resolveScopedKeywords,
  computeUnverifiableEngineIds,
} from "./seRankingSelectiveSyncInventory";

export { confirmSelectiveSeRankingSync } from "./seRankingSelectiveSyncConfirmation";
export type {
  SelectiveSyncStore,
  SelectiveSyncTransport,
  SeRankingSelectiveSyncDeps,
} from "./seRankingSelectiveSyncContext";

export interface SeRankingSelectiveSyncPreviewKeyword {
  trackingKeywordId: string;
  keyword: string;
  assignedTargetIds: string[];
  hasExplicitAssignments: boolean;
  remoteKeywordId: string | null;
  /** Verified engine membership per remote site engine id. */
  engineMembership: Record<string, boolean>;
  mappedLocally: boolean;
  mappingStatus: string | null;
}

export interface SeRankingSelectiveSyncPreviewResponse {
  linked: boolean;
  reason: string | null;
  selectedCount: number;
  remoteProject: { siteId: number; title: string } | null;
  engineBindings: SeRankingSelectiveSyncEngineBindings | null;
  configDevices: "desktop" | "mobile" | "both";
  inventory: {
    status: "ok" | "unknown";
    /** Engines whose membership could not be verified. */
    enginesWithUnknownMembership: number[];
  } | null;
  keywords: SeRankingSelectiveSyncPreviewKeyword[];
  /** Default-mode ("assignments") counts. */
  counts: SeRankingSelectiveSyncPlan["counts"] | null;
  /** The displayed/approvable keyword set (ids with pending work). */
  approvedKeywordIds: string[];
  quota: {
    trackedKeywordCapacity: ProjectQuotaDimension | null;
    projectSubscription: ProjectApiAccessReport["projectSubscription"] | null;
    warnings: string[];
  } | null;
}

export async function previewSelectiveSeRankingSync(
  params: {
    organizationId: string;
    projectId: string;
    configId: string;
    keywordIds?: string[];
    syncAllMissing?: boolean;
  },
  deps: SeRankingSelectiveSyncDeps = defaultSelectiveSyncDeps(),
): Promise<SeRankingSelectiveSyncPreviewResponse> {
  if (
    (!params.keywordIds || params.keywordIds.length === 0) &&
    !params.syncAllMissing
  ) {
    throw new AppError(
      "VALIDATION_ERROR",
      "A keyword selection or syncAllMissing scope is required",
    );
  }

  const resolved = await resolveContext({
    organizationId: params.organizationId,
    projectId: params.projectId,
    configId: params.configId,
    deps,
  });

  const scopedKeywords = await resolveScopedKeywords({
    store: deps.store,
    configId: params.configId,
    projectId: params.projectId,
    keywordIds: params.keywordIds,
  });

  const baseResponse: SeRankingSelectiveSyncPreviewResponse = {
    linked: false,
    reason: null,
    selectedCount: scopedKeywords.length,
    remoteProject: null,
    engineBindings: null,
    configDevices: resolved.config.devices,
    inventory: null,
    keywords: [],
    approvedKeywordIds: [],
    counts: null,
    quota: null,
  };

  if (!resolved.linked) {
    return {
      ...baseResponse,
      reason: notLinkedMessage(resolved.reason),
    };
  }

  const { transport, projectBinding, engineBindings, mappings, config } =
    resolved;

  // Quota/subscription reporting (verifiable data only, best-effort).
  let quotaWarnings: string[] = [];
  let trackedKeywordCapacity: ProjectQuotaDimension | null = null;
  let projectSubscription:
    | ProjectApiAccessReport["projectSubscription"]
    | null = null;
  let remoteTitle = config.domain;
  try {
    const access = await transport.validateAccessAndQuota(
      projectBinding.remoteSiteId,
    );
    trackedKeywordCapacity = access.trackedKeywordCapacity;
    projectSubscription = access.projectSubscription;
    const site = access.sites.find((s) => s.id === projectBinding.remoteSiteId);
    if (site && site.title) remoteTitle = site.title;
    if (access.projectSubscription.status === "blocked") {
      quotaWarnings.push(
        "SE Ranking subscription is blocked for this API key.",
      );
    }
  } catch (error) {
    const classified = classifyProjectApiError(error, "keyword_sync");
    if (
      classified instanceof AppError &&
      classified.code === "UNAUTHENTICATED"
    ) {
      throw classified;
    }
    quotaWarnings.push(
      `SE Ranking quota could not be verified: ${classified.message}`,
    );
  }

  const read = await readRemoteInventory(
    transport,
    projectBinding.remoteSiteId,
  );

  const plan = buildPlan(scopedKeywords, read, resolved, "assignments");

  const unverifiableEngines = computeUnverifiableEngineIds(
    read,
    engineBindings,
  );

  const keywords: SeRankingSelectiveSyncPreviewKeyword[] = scopedKeywords.map(
    (kw) => {
      const identity = normalizeKeywordIdentity(kw.keyword);
      const remote = read.inventory.byIdentity.get(identity);
      const mapping = mappings.get(kw.id);
      const engineMembership: Record<string, boolean> = {};
      if (remote) {
        for (const [engineId, members] of read.inventory.engineMembership) {
          engineMembership[String(engineId)] = members.has(remote.id);
        }
      }
      return {
        trackingKeywordId: kw.id,
        keyword: kw.keyword,
        assignedTargetIds: kw.assignedTargetIds,
        hasExplicitAssignments: kw.hasExplicitAssignments,
        remoteKeywordId: remote?.id ?? null,
        engineMembership,
        mappedLocally: Boolean(
          remote && mapping && mapping.remoteKeywordId === remote.id,
        ),
        mappingStatus: mapping?.status ?? null,
      };
    },
  );

  const remaining = trackedKeywordCapacity?.remaining;
  if (
    typeof remaining === "number" &&
    plan.counts.estimatedAdditionalEngineSlots > remaining
  ) {
    quotaWarnings.push(
      `Estimated ${plan.counts.estimatedAdditionalEngineSlots} additional tracked keyword slots exceed the reported remaining capacity (${remaining}).`,
    );
  }
  if (unverifiableEngines.length > 0) {
    quotaWarnings.push(
      `Engine membership could not be verified for SE Ranking engine(s) ${unverifiableEngines.join(", ")}. Affected keywords will not be modified until this can be verified.`,
    );
  }

  return {
    linked: true,
    reason: null,
    selectedCount: scopedKeywords.length,
    remoteProject: {
      siteId: projectBinding.remoteSiteId,
      title: remoteTitle,
    },
    engineBindings,
    configDevices: config.devices,
    inventory: {
      status: read.inventory.status,
      enginesWithUnknownMembership: unverifiableEngines,
    },
    keywords,
    counts: plan.counts,
    approvedKeywordIds: selectKeywordsWithWork(plan),
    quota: {
      trackedKeywordCapacity,
      projectSubscription,
      warnings: quotaWarnings,
    },
  };
}

export type SeRankingKeywordSyncStatusValue =
  | "synced"
  | "not_synced"
  | "partial"
  | "failed"
  | "unknown";

export interface SeRankingKeywordSyncStatusesResponse {
  linked: boolean;
  bindingStatus: string | null;
  statuses: Record<string, SeRankingKeywordSyncStatusValue>;
}

export async function getSeRankingKeywordSyncStatuses(
  params: {
    organizationId: string;
    projectId: string;
    configId: string;
  },
  deps: SeRankingSelectiveSyncDeps = defaultSelectiveSyncDeps(),
): Promise<SeRankingKeywordSyncStatusesResponse> {
  const resolved = await resolveContext({ ...params, deps });
  if (!resolved.linked) {
    return { linked: false, bindingStatus: null, statuses: {} };
  }
  const { transport, projectBinding } = resolved;
  const [keywords, read] = await Promise.all([
    resolveScopedKeywords({
      store: deps.store,
      projectId: params.projectId,
      configId: params.configId,
    }),
    readRemoteInventory(transport, projectBinding.remoteSiteId),
  ]);
  const plan = buildPlan(keywords, read, resolved, "assignments");
  const statuses: Record<string, SeRankingKeywordSyncStatusValue> = {};
  for (const item of plan.keywords) {
    const id = item.trackingKeywordId;
    if (
      item.classification === "unknown" ||
      item.unverifiedEngineIds.length > 0
    ) {
      statuses[id] = "unknown";
    } else if (item.classification === "missing_remote") {
      statuses[id] = item.mappingStatus === "failed" ? "failed" : "not_synced";
    } else if (item.classification === "fully_synced") {
      statuses[id] = "synced";
    } else {
      statuses[id] = "partial";
    }
  }
  return { linked: true, bindingStatus: projectBinding.status, statuses };
}
