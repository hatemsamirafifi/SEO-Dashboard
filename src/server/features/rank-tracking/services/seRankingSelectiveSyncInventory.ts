import type { SeRankingProjectKeyword } from "@/server/lib/seranking";
import {
  computeSelectiveSyncPlan,
  normalizeKeywordIdentity,
  type SeRankingEngineMode,
  type SeRankingSelectiveSyncEngineBindings,
  type SeRankingSelectiveSyncInventory,
  type SeRankingSelectiveSyncPlan,
} from "@/shared/seranking-selective-sync";
import type {
  SelectiveSyncContext,
  SelectiveSyncLocalKeyword,
  SelectiveSyncStore,
  SelectiveSyncTransport,
} from "./seRankingSelectiveSyncContext";

export interface RemoteInventoryRead {
  inventory: SeRankingSelectiveSyncInventory;
  /** All remote site engine ids, or null when the engine listing failed. */
  siteEngineIds: number[] | null;
  fullKeywordRecords: Map<string, SeRankingProjectKeyword>;
}

/**
 * Reads the remote keyword inventory. Engine membership is only knowable via
 * the documented per-engine keyword listing, so every site engine is listed.
 * Failures are recorded per-engine (never inferred as "no membership").
 */
function readEngineMembers(
  engineId: number,
  listedMembers: SeRankingProjectKeyword[],
  keywords: SeRankingProjectKeyword[],
) {
  const ids = new Set(listedMembers.map((member) => member.id));
  for (const keyword of keywords) {
    if (!keyword.siteEngineIds.length) continue;
    if (keyword.siteEngineIds.includes(engineId)) ids.add(keyword.id);
    else ids.delete(keyword.id);
  }
  return ids;
}

export async function readRemoteInventory(
  transport: SelectiveSyncTransport,
  remoteSiteId: number,
): Promise<RemoteInventoryRead> {
  let fullKeywords: SeRankingProjectKeyword[] = [];
  let fullOk = true;
  try {
    fullKeywords = await transport.listKeywords(remoteSiteId);
    const identities = fullKeywords.map((k) =>
      normalizeKeywordIdentity(k.keyword),
    );
    fullOk =
      identities.every(Boolean) &&
      new Set(identities).size === fullKeywords.length &&
      new Set(fullKeywords.map((k) => k.id)).size === fullKeywords.length;
  } catch {
    fullOk = false;
  }

  let siteEngineIds: number[] | null = null;
  try {
    const engines = await transport.listSiteSearchEngines(remoteSiteId);
    const ids = engines.map((engine) => engine.siteEngineId);
    siteEngineIds =
      ids.every((id) => Number.isSafeInteger(id) && id > 0) &&
      new Set(ids).size === ids.length
        ? ids
        : null;
  } catch {
    siteEngineIds = null;
  }

  const engineMembership = new Map<number, Set<string>>();
  const enginesWithUnknownMembership: number[] = [];
  if (fullOk && siteEngineIds !== null) {
    const fullIds = new Set(fullKeywords.map((keyword) => keyword.id));
    for (const engineId of siteEngineIds) {
      try {
        const members = await transport.listKeywordsForEngine(
          remoteSiteId,
          engineId,
        );
        if (members.some((member) => !fullIds.has(member.id))) {
          enginesWithUnknownMembership.push(engineId);
        } else {
          engineMembership.set(
            engineId,
            readEngineMembers(engineId, members, fullKeywords),
          );
        }
      } catch {
        enginesWithUnknownMembership.push(engineId);
      }
    }
  }

  const byIdentity = new Map<string, { id: string; keyword: string }>();
  const fullKeywordRecords = new Map<string, SeRankingProjectKeyword>();
  if (fullOk) {
    for (const kw of fullKeywords) {
      const identity = normalizeKeywordIdentity(kw.keyword);
      if (identity.length > 0 && !byIdentity.has(identity)) {
        byIdentity.set(identity, { id: kw.id, keyword: kw.keyword });
        fullKeywordRecords.set(kw.id, kw);
      }
    }
  }

  return {
    inventory: {
      status: fullOk ? "ok" : "unknown",
      byIdentity,
      engineMembership,
      enginesWithUnknownMembership,
    },
    siteEngineIds,
    fullKeywordRecords,
  };
}

/**
 * Engines whose membership cannot be verified for planning: listing-failed
 * engines plus required engine bindings that are stale (no longer present on
 * the remote site).
 */
export function computeUnverifiableEngineIds(
  read: RemoteInventoryRead,
  engineBindings: SeRankingSelectiveSyncEngineBindings,
): number[] {
  const required = new Set<number>();
  if (engineBindings.desktop !== null) required.add(engineBindings.desktop);
  if (engineBindings.mobile !== null) required.add(engineBindings.mobile);
  for (const id of Object.values(engineBindings.byTargetId)) {
    if (id !== null) required.add(id);
  }

  const unknown = new Set(read.inventory.enginesWithUnknownMembership);
  if (read.siteEngineIds === null) {
    for (const id of required) unknown.add(id);
  } else {
    const known = new Set(read.siteEngineIds);
    for (const id of required) {
      if (!known.has(id)) unknown.add(id);
    }
  }
  return [...unknown];
}

export function buildPlan(
  localKeywords: SelectiveSyncLocalKeyword[],
  read: RemoteInventoryRead,
  context: Pick<SelectiveSyncContext, "mappings" | "engineBindings" | "config">,
  engineMode: SeRankingEngineMode,
): SeRankingSelectiveSyncPlan {
  const { mappings, engineBindings, config } = context;
  return computeSelectiveSyncPlan({
    localKeywords,
    inventory: {
      ...read.inventory,
      enginesWithUnknownMembership: computeUnverifiableEngineIds(
        read,
        engineBindings,
      ),
    },
    mappings: new Map(
      [...mappings.entries()].map(([id, m]) => [
        id,
        { remoteKeywordId: m.remoteKeywordId, status: m.status },
      ]),
    ),
    engineBindings,
    engineMode,
    configDevices: config.devices,
  });
}

export async function resolveScopedKeywords(params: {
  store: SelectiveSyncStore;
  configId: string;
  projectId: string;
  keywordIds?: string[];
}): Promise<SelectiveSyncLocalKeyword[]> {
  const assignments = await params.store.getKeywordTargetAssignments(
    params.projectId,
  );
  const rows = await params.store.getLocalKeywords(params.configId);
  const localKeywords: SelectiveSyncLocalKeyword[] = rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    assignedTargetIds: assignments[row.id] ?? [],
    hasExplicitAssignments: Object.hasOwn(assignments, row.id),
  }));
  if (params.keywordIds && params.keywordIds.length > 0) {
    const requested = new Set(params.keywordIds);
    return localKeywords.filter((kw) => requested.has(kw.id));
  }
  return localKeywords;
}
