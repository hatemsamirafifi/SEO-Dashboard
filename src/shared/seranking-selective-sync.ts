/**
 * Selective SE Ranking keyword synchronization — shared, dependency-free
 * planning logic.
 *
 * Used by the server (preview + confirm orchestration), the client (preview
 * modal recomputation when the engine choice changes) and the e2e fixtures,
 * so every surface classifies keywords identically.
 *
 * Identity contract: keywords are matched by exact normalized Unicode
 * identity — safe trim, NFC normalization, and case folding only. Diacritics
 * and Arabic vowel marks (tashkeel) are meaningful and are NEVER stripped,
 * because stripping them merges distinct keywords.
 */

export const SE_RANKING_ENGINE_MODES = [
  "assignments",
  "desktop",
  "mobile",
  "both",
] as const;

export type SeRankingEngineMode = (typeof SE_RANKING_ENGINE_MODES)[number];

export const SE_RANKING_SYNC_ACTIONS = [
  "add_remote",
  "repair_mapping",
  "update_engines",
  "none",
  "blocked",
] as const;

export type SeRankingSyncAction = (typeof SE_RANKING_SYNC_ACTIONS)[number];

export const SE_RANKING_SYNC_CLASSES = [
  "fully_synced",
  "partially_synced",
  "remote_unmapped",
  "missing_remote",
  "unknown",
] as const;

export type SeRankingSyncClass = (typeof SE_RANKING_SYNC_CLASSES)[number];

/** Normalizes a keyword to its exact matching identity. */
export function normalizeKeywordIdentity(raw: string): string {
  return raw.trim().normalize("NFC").toLowerCase();
}

export interface SeRankingSelectiveSyncEngineBindings {
  /** Remote site engine id bound to the desktop tracking target, if any. */
  desktop: number | null;
  /** Remote site engine id bound to the mobile tracking target, if any. */
  mobile: number | null;
  /** Remote site engine id per local tracking target id. */
  byTargetId: Record<string, number | null>;
}

export interface SeRankingSelectiveSyncRemoteKeyword {
  id: string;
  keyword: string;
}

export interface SeRankingSelectiveSyncLocalKeyword {
  id: string;
  keyword: string;
  /** Explicit tracking target assignments (empty = config default devices). */
  assignedTargetIds: string[];
  hasExplicitAssignments?: boolean;
}

export interface SeRankingSelectiveSyncMapping {
  remoteKeywordId: string;
  status: string;
}

/**
 * Verified remote inventory. Engine membership is only known through the
 * documented per-engine keyword listing (`GET /keywords?site_engine_id=`),
 * so `engineMembership` maps engine id -> set of remote keyword ids, and
 * `enginesWithUnknownMembership` lists engines whose per-engine listing
 * failed. Absence of an engine from `engineMembership` therefore means
 * "listing failed", never "no keyword is assigned".
 */
export interface SeRankingSelectiveSyncInventory {
  /** "ok" when the full project keyword listing succeeded, otherwise "unknown". */
  status: "ok" | "unknown";
  /** Remote keywords by normalized identity. Empty when status is "unknown". */
  byIdentity: Map<string, SeRankingSelectiveSyncRemoteKeyword>;
  /** Verified engine membership per successfully listed engine. */
  engineMembership: Map<number, Set<string>>;
  /** Engines whose per-engine listing failed (membership unverifiable). */
  enginesWithUnknownMembership: number[];
}

export interface SeRankingSelectiveSyncPlanInput {
  localKeywords: SeRankingSelectiveSyncLocalKeyword[];
  inventory: SeRankingSelectiveSyncInventory;
  /** Local keyword id -> existing mapping, if any. */
  mappings: Map<string, SeRankingSelectiveSyncMapping>;
  engineBindings: SeRankingSelectiveSyncEngineBindings;
  engineMode: SeRankingEngineMode;
  /** Config-level device choice used only for keywords with no explicit target assignments. */
  configDevices: "desktop" | "mobile" | "both";
}

export interface SeRankingSelectiveSyncKeywordPlan {
  trackingKeywordId: string;
  keyword: string;
  classification: SeRankingSyncClass;
  action: SeRankingSyncAction;
  remoteKeywordId: string | null;
  mappedLocally: boolean;
  mappingStatus: string | null;
  requiredEngineIds: number[];
  /** Required engines whose remote membership could not be verified. */
  unverifiedEngineIds: number[];
  /** Required engines confirmed missing on the remote keyword. */
  missingEngineIds: number[];
  blockedReason: string | null;
}

export interface SeRankingSelectiveSyncPlan {
  keywords: SeRankingSelectiveSyncKeywordPlan[];
  counts: {
    selected: number;
    alreadyRemote: number;
    alreadyMappedLocally: number;
    missingRemote: number;
    fullySynced: number;
    keywordsWithWork: number;
    /** `null` when desktop membership is unverifiable. */
    missingDesktopAssignments: number | null;
    /** `null` when mobile membership is unverifiable. */
    missingMobileAssignments: number | null;
    /**
     * Estimated additional keyword-engine tracking slots the confirmation
     * would require (new keywords + engine assignments for existing ones).
     */
    estimatedAdditionalEngineSlots: number;
    unknown: number;
  };
  inventoryStatus: "ok" | "unknown";
  engineKnowledgeIncomplete: boolean;
}

/**
 * Resolves the engine ids a keyword must be tracked on under the chosen mode.
 *
 * "assignments" (default) uses the keyword's explicit target assignments and
 * never silently broadens: keywords without explicit assignments fall back to
 * the config's own device choice, which the preview surfaces explicitly.
 */
export function resolveRequiredEngineIds(
  localKeyword: SeRankingSelectiveSyncLocalKeyword,
  engineMode: SeRankingEngineMode,
  engineBindings: SeRankingSelectiveSyncEngineBindings,
  configDevices: "desktop" | "mobile" | "both",
): { engineIds: number[]; blockedReason: string | null } {
  if (
    engineMode === "assignments" &&
    (localKeyword.hasExplicitAssignments ||
      localKeyword.assignedTargetIds.length > 0)
  ) {
    const engineIds = new Set<number>();
    for (const targetId of localKeyword.assignedTargetIds) {
      const engineId = engineBindings.byTargetId[targetId];
      if (engineId == null) {
        return {
          engineIds: [],
          blockedReason: "An assigned target has no SE Ranking engine binding",
        };
      }
      engineIds.add(engineId);
    }
    return engineIds.size
      ? { engineIds: [...engineIds], blockedReason: null }
      : {
          engineIds: [],
          blockedReason: "This keyword has no enabled target assignments",
        };
  }

  const devices = engineMode === "assignments" ? configDevices : engineMode;
  const desktop = devices === "mobile" ? [] : [engineBindings.desktop];
  const mobile = devices === "desktop" ? [] : [engineBindings.mobile];
  const engineIds = [...desktop, ...mobile];
  if (engineIds.some((id) => id === null)) {
    return {
      engineIds: [],
      blockedReason:
        "A requested device has no unambiguous SE Ranking engine binding",
    };
  }
  return {
    engineIds: [...new Set(engineIds.filter((id) => id !== null))],
    blockedReason: null,
  };
}

function calculateMissingAssignments(
  pairs: Map<string, Set<number>>,
  bindings: SeRankingSelectiveSyncEngineBindings,
) {
  const slots = [...pairs.values()];
  const count = (engineId: number | null) =>
    engineId === null ? 0 : slots.filter((ids) => ids.has(engineId)).length;
  return {
    estimatedAdditionalEngineSlots: slots.reduce(
      (sum, ids) => sum + ids.size,
      0,
    ),
    missingDesktopAssignments: count(bindings.desktop),
    missingMobileAssignments: count(bindings.mobile),
  };
}

function classifyExistingKeyword(
  plan: SeRankingSelectiveSyncKeywordPlan,
  mapping: SeRankingSelectiveSyncMapping | undefined,
) {
  if (
    plan.missingEngineIds.length === 0 &&
    plan.unverifiedEngineIds.length === 0 &&
    plan.mappedLocally &&
    mapping?.status === "synced"
  ) {
    plan.classification = "fully_synced";
    return;
  }
  plan.classification = plan.mappedLocally
    ? "partially_synced"
    : "remote_unmapped";
  if (plan.unverifiedEngineIds.length) {
    plan.action = "blocked";
    plan.blockedReason =
      "SE Ranking engine membership could not be verified for this keyword";
  } else {
    plan.action = plan.missingEngineIds.length
      ? "update_engines"
      : "repair_mapping";
  }
}

/**
 * Computes the per-keyword sync plan for one engine mode.
 *
 * Fails closed everywhere: unverifiable remote membership is reported as
 * unknown/blocked, never as "already assigned" or "not assigned".
 */
export function computeSelectiveSyncPlan(
  input: SeRankingSelectiveSyncPlanInput,
): SeRankingSelectiveSyncPlan {
  const {
    localKeywords,
    inventory,
    mappings,
    engineBindings,
    engineMode,
    configDevices,
  } = input;

  const unknownEngines = new Set(inventory.enginesWithUnknownMembership);
  const engineKnowledgeIncomplete =
    inventory.status !== "ok" || unknownEngines.size > 0;

  const keywords: SeRankingSelectiveSyncKeywordPlan[] = [];
  const counts = {
    selected: localKeywords.length,
    alreadyRemote: 0,
    alreadyMappedLocally: 0,
    missingRemote: 0,
    fullySynced: 0,
    keywordsWithWork: 0,
    missingDesktopAssignments: 0,
    missingMobileAssignments: 0,
    estimatedAdditionalEngineSlots: 0,
    unknown: 0,
  };
  const missingPairs = new Map<string, Set<number>>();
  let desktopKnowledgeFailed = false;
  let mobileKnowledgeFailed = false;

  for (const local of localKeywords) {
    const identity = normalizeKeywordIdentity(local.keyword);
    const remote = inventory.byIdentity.get(identity);
    const mapping = mappings.get(local.id);
    const required = resolveRequiredEngineIds(
      local,
      engineMode,
      engineBindings,
      configDevices,
    );

    const plan: SeRankingSelectiveSyncKeywordPlan = {
      trackingKeywordId: local.id,
      keyword: local.keyword,
      classification: "unknown",
      action: "none",
      remoteKeywordId: remote?.id ?? null,
      mappedLocally: Boolean(
        remote && mapping && mapping.remoteKeywordId === remote.id,
      ),
      mappingStatus: mapping?.status ?? null,
      requiredEngineIds: required.engineIds,
      unverifiedEngineIds: [],
      missingEngineIds: [],
      blockedReason: required.blockedReason,
    };

    if (inventory.status !== "ok") {
      plan.classification = "unknown";
      plan.action = "blocked";
      plan.blockedReason =
        plan.blockedReason ??
        "Remote keyword inventory could not be read from SE Ranking";
      counts.unknown++;
      keywords.push(plan);
      continue;
    }

    if (remote) counts.alreadyRemote++;
    if (mapping) counts.alreadyMappedLocally++;

    if (required.blockedReason) {
      // Engine bindings are stale/missing — nothing can be safely written.
      plan.classification = remote ? "partially_synced" : "missing_remote";
      plan.action = "blocked";
      if (!remote) counts.missingRemote++;
      counts.keywordsWithWork++;
      keywords.push(plan);
      continue;
    }

    // Required engines whose remote state could not be verified. Fail closed:
    // a keyword is never added or patched against an unverifiable engine.
    const unverifiedRequiredEngines = required.engineIds.filter((engineId) =>
      unknownEngines.has(engineId),
    );

    if (!remote) {
      if (unverifiedRequiredEngines.length > 0) {
        plan.classification = "missing_remote";
        plan.action = "blocked";
        plan.unverifiedEngineIds = unverifiedRequiredEngines;
        plan.blockedReason =
          "SE Ranking engine could not be verified for this keyword";
        counts.missingRemote++;
        counts.keywordsWithWork++;
        keywords.push(plan);
        continue;
      }
      plan.classification = "missing_remote";
      plan.action = "add_remote";
      plan.missingEngineIds = [...required.engineIds];
      counts.missingRemote++;
      counts.keywordsWithWork++;
      const slots = missingPairs.get(identity) ?? new Set<number>();
      for (const id of plan.missingEngineIds) slots.add(id);
      missingPairs.set(identity, slots);
      keywords.push(plan);
      continue;
    }

    // Verify required engine membership from the per-engine listings.
    const missingEngineIds: number[] = [];
    const unverifiedEngineIds: number[] = [];
    for (const engineId of required.engineIds) {
      if (unknownEngines.has(engineId)) {
        unverifiedEngineIds.push(engineId);
        if (engineId === engineBindings.desktop) desktopKnowledgeFailed = true;
        if (engineId === engineBindings.mobile) mobileKnowledgeFailed = true;
        continue;
      }
      const members = inventory.engineMembership.get(engineId);
      if (!members || !members.has(remote.id)) {
        missingEngineIds.push(engineId);
      }
    }
    plan.missingEngineIds = missingEngineIds;
    plan.unverifiedEngineIds = unverifiedEngineIds;

    classifyExistingKeyword(plan, mapping);
    if (plan.action === "none") counts.fullySynced++;
    else counts.keywordsWithWork++;
    if (plan.action === "update_engines") {
      const slots = missingPairs.get(identity) ?? new Set<number>();
      for (const id of plan.missingEngineIds) slots.add(id);
      missingPairs.set(identity, slots);
    }

    keywords.push(plan);
  }

  Object.assign(
    counts,
    calculateMissingAssignments(missingPairs, engineBindings),
  );

  return {
    keywords,
    counts: {
      ...counts,
      missingDesktopAssignments: desktopKnowledgeFailed
        ? null
        : counts.missingDesktopAssignments,
      missingMobileAssignments: mobileKnowledgeFailed
        ? null
        : counts.missingMobileAssignments,
    },
    inventoryStatus: inventory.status,
    engineKnowledgeIncomplete,
  };
}

/**
 * Keyword ids the plan can actually act on (the "displayed set" for
 * sync-all). Blocked/unknown keywords are excluded: they are not safely
 * writable and must not be silently approved for upload.
 */
export function selectKeywordsWithWork(
  plan: SeRankingSelectiveSyncPlan,
): string[] {
  return plan.keywords
    .filter(
      (k) =>
        k.action === "add_remote" ||
        k.action === "repair_mapping" ||
        k.action === "update_engines",
    )
    .map((k) => k.trackingKeywordId);
}
