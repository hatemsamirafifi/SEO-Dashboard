import { AppError } from "@/server/lib/errors";
import { classifyProjectApiError } from "@/server/lib/seranking/projectAccess";
import type {
  SeRankingEngineMode,
  SeRankingSelectiveSyncEngineBindings,
} from "@/shared/seranking-selective-sync";
import {
  defaultSelectiveSyncDeps,
  notLinkedMessage,
  resolveContext,
  type SeRankingSelectiveSyncDeps,
  type SelectiveSyncConfig,
  type SelectiveSyncMappingRow,
  type SelectiveSyncProjectBinding,
  type SelectiveSyncTransport,
} from "./seRankingSelectiveSyncContext";
import {
  buildPlan,
  readRemoteInventory,
  resolveScopedKeywords,
} from "./seRankingSelectiveSyncInventory";
import {
  addMissingAssignments,
  addMissingKeywords,
} from "./seRankingSelectiveSyncWrites";
import { recordSyncResult } from "./seRankingSelectiveSyncResults";
import type { SeRankingKeywordSyncStatusValue } from "./seRankingSelectiveSyncService";

const activeConfirms = new Set<string>();

function acquireConfirmLock(projectBindingId: string): () => void {
  if (activeConfirms.has(projectBindingId)) {
    throw new AppError(
      "CONFLICT",
      "A SE Ranking keyword sync is already running for this project. Wait for it to finish before confirming again.",
    );
  }
  activeConfirms.add(projectBindingId);
  return () => {
    activeConfirms.delete(projectBindingId);
  };
}

export interface SeRankingSelectiveSyncFailure {
  trackingKeywordId: string;
  keyword: string;
  stage: "add" | "engines" | "verify" | "blocked";
  message: string;
}

export interface SeRankingSelectiveSyncConfirmResult {
  ok: boolean;
  addedCount: number;
  addedKeywordIds: string[];
  skippedExistingCount: number;
  mappingsRepairedCount: number;
  mappingsCreatedCount: number;
  engineAssignmentsUpdatedCount: number;
  failed: SeRankingSelectiveSyncFailure[];
  partiallySynced: Array<{ trackingKeywordId: string; keyword: string }>;
  unknown: Array<{ trackingKeywordId: string; keyword: string }>;
  blocked: SeRankingSelectiveSyncFailure[];
  staleApprovedKeywordIds: string[];
  finalStatuses: Record<string, SeRankingKeywordSyncStatusValue>;
}

interface ConfirmScope {
  organizationId: string;
  projectId: string;
  configId: string;
  keywordIds?: string[];
  syncAllMissing?: boolean;
  approvedKeywordIds: string[];
  engineMode: SeRankingEngineMode;
  expectedSiteId?: number;
  expectedKeywords?: Record<
    string,
    { engineIds: number[]; remoteKeywordId: string | null }
  >;
}

export async function confirmSelectiveSeRankingSync(
  params: ConfirmScope,
  deps: SeRankingSelectiveSyncDeps = defaultSelectiveSyncDeps(),
): Promise<SeRankingSelectiveSyncConfirmResult> {
  if (params.approvedKeywordIds.length === 0 && !params.syncAllMissing) {
    throw new AppError(
      "VALIDATION_ERROR",
      "No keywords were approved for synchronization",
    );
  }

  const resolved = await resolveContext({
    organizationId: params.organizationId,
    projectId: params.projectId,
    configId: params.configId,
    deps,
  });
  if (!resolved.linked) {
    throw new AppError("VALIDATION_ERROR", notLinkedMessage(resolved.reason));
  }

  const { transport, projectBinding, engineBindings, mappings, config } =
    resolved;

  if (
    params.expectedSiteId !== undefined &&
    params.expectedSiteId !== projectBinding.remoteSiteId
  ) {
    throw new AppError(
      "CONFLICT",
      "The linked SE Ranking project changed. Open a fresh preview.",
    );
  }

  const release = acquireConfirmLock(
    `${resolved.accountFingerprint}:${projectBinding.remoteSiteId}`,
  );
  try {
    return await executeConfirmedSync({
      params,
      deps,
      transport,
      projectBinding,
      engineBindings,
      mappings,
      config,
    });
  } finally {
    release();
  }
}

async function executeConfirmedSync(input: {
  params: ConfirmScope;
  deps: SeRankingSelectiveSyncDeps;
  transport: SelectiveSyncTransport;
  projectBinding: SelectiveSyncProjectBinding;
  engineBindings: SeRankingSelectiveSyncEngineBindings;
  mappings: Map<string, SelectiveSyncMappingRow>;
  config: SelectiveSyncConfig;
}): Promise<SeRankingSelectiveSyncConfirmResult> {
  const { params, transport, projectBinding, mappings } = input;

  const scopedKeywords = await resolveScopedKeywords({
    store: input.deps.store,
    configId: params.configId,
    projectId: params.projectId,
    keywordIds: params.keywordIds,
  });
  const scopedById = new Map(scopedKeywords.map((kw) => [kw.id, kw]));

  // The approved scope is frozen at what the user saw; keywords deleted
  // locally since the preview are reported, never silently broadened.
  const approvedSet = new Set(params.approvedKeywordIds);
  const staleApprovedKeywordIds = params.approvedKeywordIds.filter(
    (id) => !scopedById.has(id),
  );
  const approvedKeywords = scopedKeywords.filter((kw) =>
    approvedSet.has(kw.id),
  );

  const result: SeRankingSelectiveSyncConfirmResult = {
    ok: true,
    addedCount: 0,
    addedKeywordIds: [],
    skippedExistingCount: 0,
    mappingsRepairedCount: 0,
    mappingsCreatedCount: 0,
    engineAssignmentsUpdatedCount: 0,
    failed: [],
    partiallySynced: [],
    unknown: [],
    blocked: [],
    staleApprovedKeywordIds,
    finalStatuses: {},
  };

  if (approvedKeywords.length === 0) return result;

  // 1. Fresh pre-write inventory. Fail closed when unreadable: nothing is
  //    uploaded against unknown remote state.
  const initialRead = await readRemoteInventory(
    transport,
    projectBinding.remoteSiteId,
  );
  if (initialRead.inventory.status !== "ok") {
    throw classifyProjectApiError(
      new AppError(
        "TRANSIENT_UPSTREAM",
        "SE Ranking keyword inventory could not be read; nothing was uploaded.",
      ),
      "keyword_sync",
    );
  }

  const plan1 = buildPlan(
    approvedKeywords,
    initialRead,
    input,
    params.engineMode,
  );

  if (params.expectedKeywords) {
    for (const keyword of plan1.keywords) {
      const expected = params.expectedKeywords[keyword.trackingKeywordId];
      const actualIds = keyword.requiredEngineIds.toSorted((a, b) => a - b);
      if (
        !expected ||
        expected.engineIds.toSorted((a, b) => a - b).join(",") !==
          actualIds.join(",") ||
        (expected.remoteKeywordId !== null &&
          expected.remoteKeywordId !== keyword.remoteKeywordId)
      ) {
        throw new AppError(
          "CONFLICT",
          "Keyword assignments changed. Open a fresh preview.",
        );
      }
    }
  }

  const toAdd = plan1.keywords.filter((k) => k.action === "add_remote");
  const existingKeywordIds = new Set(
    plan1.keywords
      .filter((k) => k.classification !== "missing_remote")
      .map((k) => k.trackingKeywordId),
  );

  // 2. Verifiable quota gate for genuinely new uploads.
  if (toAdd.length > 0) {
    try {
      const access = await transport.validateAccessAndQuota(
        projectBinding.remoteSiteId,
      );
      if (
        access.trackedKeywordCapacity.status === "blocked" &&
        access.trackedKeywordCapacity.remaining !== "unknown"
      ) {
        throw new AppError(
          "PAYMENT_REQUIRED",
          `PROJECT_API_KEYWORD_CAPACITY_EXCEEDED: SE Ranking reports no remaining tracked keyword capacity (used ${access.trackedKeywordCapacity.used}/${access.trackedKeywordCapacity.limit}).`,
        );
      }
    } catch (error) {
      if (error instanceof AppError && error.code === "PAYMENT_REQUIRED") {
        throw error;
      }
      // Quota unverifiable — the provider still enforces it on write; proceed.
    }
  }

  // 3. Single-attempt POSTs. No generic retry replay: ambiguous writes are
  //    resolved below by reconciling fresh provider state.
  const { postedKeywordIds, attemptedIds } = await addMissingKeywords(
    transport,
    projectBinding.remoteSiteId,
    toAdd,
    result,
  );

  // 4. Reconcile fresh after the writes.
  const secondRead = attemptedIds.size
    ? await readRemoteInventory(transport, projectBinding.remoteSiteId)
    : initialRead;
  if (secondRead.inventory.status !== "ok") {
    // Ambiguous outcome for everything we attempted; write nothing.
    for (const k of plan1.keywords) {
      if (attemptedIds.has(k.trackingKeywordId)) {
        result.unknown.push({
          trackingKeywordId: k.trackingKeywordId,
          keyword: k.keyword,
        });
        result.finalStatuses[k.trackingKeywordId] = "unknown";
      }
    }
    result.ok = false;
    return result;
  }

  const plan2 = buildPlan(
    approvedKeywords,
    secondRead,
    input,
    params.engineMode,
  );
  const plan2ById = new Map(
    plan2.keywords.map((k) => [k.trackingKeywordId, k]),
  );

  // 5. Resolve ambiguous POST failures against this fresh reconcile: a write
  //    that reported failure but is present remotely actually committed, so
  //    it is not a failure and must not be re-uploaded on retry.
  const committedKeywordIds = new Set(postedKeywordIds);
  const unresolvedAddFailures: SeRankingSelectiveSyncFailure[] = [];
  for (const failure of result.failed) {
    if (failure.stage !== "add") {
      unresolvedAddFailures.push(failure);
      continue;
    }
    const current = plan2ById.get(failure.trackingKeywordId);
    if (
      attemptedIds.has(failure.trackingKeywordId) &&
      current &&
      current.remoteKeywordId &&
      current.classification !== "missing_remote"
    ) {
      committedKeywordIds.add(failure.trackingKeywordId);
      continue;
    }
    unresolvedAddFailures.push(failure);
  }
  result.failed = unresolvedAddFailures;

  // 6. Engine assignment PATCHes for existing keywords — only with complete
  //    engine knowledge, and always as a union so unrelated engines survive.
  const { finalRead, enginePatchTargets, attemptedPatches } =
    await addMissingAssignments({
      transport,
      remoteSiteId: projectBinding.remoteSiteId,
      secondRead,
      plans: plan2.keywords,
      existingKeywordIds,
      committedKeywordIds,
      result,
    });

  const finalPlan = buildPlan(
    approvedKeywords,
    finalRead,
    input,
    params.engineMode,
  );

  return recordSyncResult({
    store: input.deps.store,
    bindingId: projectBinding.id,
    mappings,
    keywords: finalPlan.keywords,
    enginePatchTargets,
    finalRead,
    attemptedPatches,
    existingKeywordIds,
    committedKeywordIds,
    result,
  });
}
