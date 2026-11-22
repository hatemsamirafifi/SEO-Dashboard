import {
  normalizeKeywordIdentity,
  type SeRankingSelectiveSyncKeywordPlan,
} from "@/shared/seranking-selective-sync";
import type {
  SelectiveSyncMappingRow,
  SelectiveSyncStore,
} from "./seRankingSelectiveSyncContext";
import type { RemoteInventoryRead } from "./seRankingSelectiveSyncInventory";
import type { SeRankingSelectiveSyncConfirmResult } from "./seRankingSelectiveSyncConfirmation";

export async function recordSyncResult(input: {
  store: SelectiveSyncStore;
  bindingId: string;
  mappings: Map<string, SelectiveSyncMappingRow>;
  keywords: SeRankingSelectiveSyncKeywordPlan[];
  enginePatchTargets: SeRankingSelectiveSyncKeywordPlan[];
  finalRead: RemoteInventoryRead;
  attemptedPatches: Set<string>;
  existingKeywordIds: Set<string>;
  committedKeywordIds: Set<string>;
  result: SeRankingSelectiveSyncConfirmResult;
}) {
  const {
    store,
    bindingId,
    mappings,
    keywords,
    enginePatchTargets,
    finalRead,
    attemptedPatches,
    existingKeywordIds,
    committedKeywordIds,
    result,
  } = input;
  const verifiedAssignments = new Map<string, Set<number>>();
  for (const row of enginePatchTargets) {
    if (!row.remoteKeywordId || !attemptedPatches.has(row.remoteKeywordId))
      continue;
    const ids =
      verifiedAssignments.get(row.remoteKeywordId) ?? new Set<number>();
    for (const engineId of row.missingEngineIds) {
      if (
        finalRead.inventory.engineMembership
          .get(engineId)
          ?.has(row.remoteKeywordId)
      )
        ids.add(engineId);
    }
    verifiedAssignments.set(row.remoteKeywordId, ids);
  }
  result.engineAssignmentsUpdatedCount = [
    ...verifiedAssignments.values(),
  ].reduce((sum, ids) => sum + ids.size, 0);

  // 7. Classify outcomes and repair local mappings.
  const nowIso = new Date().toISOString();
  const mappingUpserts: Array<{
    id: string;
    projectBindingId: string;
    trackingKeywordId: string;
    remoteKeywordId: string;
    status: "synced" | "partial" | "failed" | "pending";
    createdAt: string;
    updatedAt: string;
  }> = [];

  const unknownIds = new Set(result.unknown.map((u) => u.trackingKeywordId));
  const failedIds = new Set(result.failed.map((f) => f.trackingKeywordId));

  const addedIdentities = new Set<string>();
  const skippedIdentities = new Set<string>();
  for (const k of keywords) {
    const id = k.trackingKeywordId;
    const keyword = k.keyword;
    const identity = normalizeKeywordIdentity(keyword);
    if (k.remoteKeywordId === null) {
      if (unknownIds.has(id)) {
        result.finalStatuses[id] = "unknown";
      } else if (k.action === "blocked") {
        result.blocked.push({
          trackingKeywordId: id,
          keyword,
          stage: "blocked",
          message: k.blockedReason ?? "Keyword cannot be safely synchronized.",
        });
        result.finalStatuses[id] = "not_synced";
      } else {
        if (!failedIds.has(id))
          result.failed.push({
            trackingKeywordId: id,
            keyword,
            stage: "verify",
            message: "SE Ranking did not confirm the keyword was added.",
          });
        result.finalStatuses[id] = "failed";
      }
      continue;
    }

    const partial =
      k.action === "blocked" ||
      k.missingEngineIds.length > 0 ||
      k.unverifiedEngineIds.length > 0 ||
      unknownIds.has(id);
    if (
      k.action === "blocked" &&
      !result.blocked.some((row) => row.trackingKeywordId === id)
    ) {
      result.blocked.push({
        trackingKeywordId: id,
        keyword,
        stage: "blocked",
        message: k.blockedReason ?? "Keyword cannot be safely synchronized.",
      });
    }
    result.finalStatuses[id] = unknownIds.has(id)
      ? "unknown"
      : partial
        ? "partial"
        : "synced";
    if (partial)
      result.partiallySynced.push({ trackingKeywordId: id, keyword });

    if (committedKeywordIds.has(id)) {
      result.addedKeywordIds.push(id);
      addedIdentities.add(identity);
    } else if (existingKeywordIds.has(id)) {
      skippedIdentities.add(identity);
    }

    // Mapping repair / creation for every keyword with a known remote id.
    // "Repaired" = the keyword already existed remotely before this confirm;
    // "created" = the mapping belongs to a keyword this confirm added.
    if (k.remoteKeywordId) {
      const existingMapping = mappings.get(k.trackingKeywordId);
      const mappingStatus = partial ? "partial" : "synced";
      const needsUpsert =
        !existingMapping ||
        existingMapping.remoteKeywordId !== k.remoteKeywordId ||
        existingMapping.status !== mappingStatus;
      if (needsUpsert) {
        if (existingKeywordIds.has(k.trackingKeywordId)) {
          result.mappingsRepairedCount++;
        } else {
          result.mappingsCreatedCount++;
        }
        mappingUpserts.push({
          id: existingMapping?.id ?? crypto.randomUUID(),
          projectBindingId: bindingId,
          trackingKeywordId: k.trackingKeywordId,
          remoteKeywordId: k.remoteKeywordId,
          status: mappingStatus,
          createdAt: existingMapping?.createdAt ?? nowIso,
          updatedAt: nowIso,
        });
      }
    }
  }

  if (mappingUpserts.length > 0) {
    await store.upsertKeywordMappings(mappingUpserts);
  }

  result.addedCount = addedIdentities.size;
  result.skippedExistingCount = skippedIdentities.size;
  result.ok =
    result.failed.length === 0 &&
    result.unknown.length === 0 &&
    result.blocked.length === 0 &&
    result.partiallySynced.length === 0 &&
    result.staleApprovedKeywordIds.length === 0;
  return result;
}
