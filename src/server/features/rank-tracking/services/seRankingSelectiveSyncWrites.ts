import { AppError } from "@/server/lib/errors";
import { classifyProjectApiError } from "@/server/lib/seranking/projectAccess";
import {
  normalizeKeywordIdentity,
  type SeRankingSelectiveSyncKeywordPlan,
} from "@/shared/seranking-selective-sync";
import type { SelectiveSyncTransport } from "./seRankingSelectiveSyncContext";
import {
  readRemoteInventory,
  type RemoteInventoryRead,
} from "./seRankingSelectiveSyncInventory";
import type { SeRankingSelectiveSyncConfirmResult } from "./seRankingSelectiveSyncConfirmation";

const POST_BATCH_SIZE = 25;

function groupKeywordPlans(plans: SeRankingSelectiveSyncKeywordPlan[]) {
  const groups = new Map<string, SeRankingSelectiveSyncKeywordPlan[]>();
  for (const plan of plans) {
    const identity = normalizeKeywordIdentity(plan.keyword);
    const group = groups.get(identity) ?? [];
    group.push(plan);
    groups.set(identity, group);
  }
  return [...groups.values()];
}

export async function addMissingKeywords(
  transport: SelectiveSyncTransport,
  remoteSiteId: number,
  toAdd: SeRankingSelectiveSyncKeywordPlan[],
  result: SeRankingSelectiveSyncConfirmResult,
) {
  const postedKeywordIds = new Set<string>();
  const attemptedIds = new Set<string>();
  const groups = groupKeywordPlans(toAdd);
  let blockedWrite: Error | null = null;
  for (let i = 0; i < groups.length; i += POST_BATCH_SIZE) {
    const batch = groups.slice(i, i + POST_BATCH_SIZE);
    const plans = batch.flat();
    try {
      if (blockedWrite) throw blockedWrite;
      for (const plan of plans) attemptedIds.add(plan.trackingKeywordId);
      await transport.addKeywordsOnce(
        remoteSiteId,
        batch.map(([keyword, ...equivalent]) => ({
          keyword: keyword.keyword,
          siteEngineIds: [
            ...new Set(
              [keyword, ...equivalent].flatMap(
                (plan) => plan.requiredEngineIds,
              ),
            ),
          ],
        })),
      );
      for (const plan of plans) postedKeywordIds.add(plan.trackingKeywordId);
    } catch (error) {
      const classified = classifyProjectApiError(error, "keyword_sync");
      if (
        classified instanceof AppError &&
        (classified.code === "PAYMENT_REQUIRED" ||
          classified.code === "RATE_LIMITED")
      ) {
        blockedWrite = classified;
      }
      for (const plan of plans) {
        result.failed.push({
          trackingKeywordId: plan.trackingKeywordId,
          keyword: plan.keyword,
          stage: "add",
          message: classified.message,
        });
      }
    }
  }
  return { postedKeywordIds, attemptedIds };
}

export async function addMissingAssignments(input: {
  transport: SelectiveSyncTransport;
  remoteSiteId: number;
  secondRead: RemoteInventoryRead;
  plans: SeRankingSelectiveSyncKeywordPlan[];
  existingKeywordIds: Set<string>;
  committedKeywordIds: Set<string>;
  result: SeRankingSelectiveSyncConfirmResult;
}) {
  const {
    transport,
    remoteSiteId,
    secondRead,
    plans,
    existingKeywordIds,
    committedKeywordIds,
    result,
  } = input;
  const patchKnowledgeComplete =
    secondRead.siteEngineIds !== null &&
    secondRead.inventory.enginesWithUnknownMembership.length === 0;

  const enginePatchTargets = plans.filter(
    (k) =>
      k.action === "update_engines" &&
      k.missingEngineIds.length > 0 &&
      (existingKeywordIds.has(k.trackingKeywordId) ||
        committedKeywordIds.has(k.trackingKeywordId)),
  );

  const attemptedPatches = new Set<string>();
  for (const [k, ...equivalent] of groupKeywordPlans(enginePatchTargets)) {
    if (!patchKnowledgeComplete) {
      result.blocked.push({
        trackingKeywordId: k.trackingKeywordId,
        keyword: k.keyword,
        stage: "blocked",
        message:
          "Engine assignment update skipped: remote engine membership could not be fully verified.",
      });
      continue;
    }
    const remoteId = k.remoteKeywordId;
    const remoteRecord = remoteId
      ? secondRead.fullKeywordRecords.get(remoteId)
      : undefined;
    if (!remoteId || !remoteRecord) continue;

    const unionEngines = new Set<number>(
      [k, ...equivalent].flatMap((plan) => plan.requiredEngineIds),
    );
    for (const [engineId, members] of secondRead.inventory.engineMembership) {
      if (members.has(remoteId)) unionEngines.add(engineId);
    }
    try {
      attemptedPatches.add(remoteId);
      await transport.updateKeyword({
        siteId: remoteSiteId,
        keywordId: remoteId,
        keyword: remoteRecord.keyword,
        ...(remoteRecord.groupId !== undefined
          ? { groupId: remoteRecord.groupId }
          : {}),
        ...(remoteRecord.targetUrl !== undefined
          ? { targetUrl: remoteRecord.targetUrl }
          : {}),
        siteEngineIds: [...unionEngines].toSorted((a, b) => a - b),
      });
    } catch (error) {
      const classified = classifyProjectApiError(error, "keyword_sync");
      result.failed.push({
        trackingKeywordId: k.trackingKeywordId,
        keyword: k.keyword,
        stage: "engines",
        message: classified.message,
      });
    }
  }

  // 6. Final verification read (only needed when we wrote something).
  let finalRead = secondRead;
  if (attemptedPatches.size > 0) {
    const verifyRead = await readRemoteInventory(transport, remoteSiteId);
    if (verifyRead.inventory.status === "ok") {
      finalRead = verifyRead;
    } else {
      for (const k of plans) {
        if (k.remoteKeywordId && attemptedPatches.has(k.remoteKeywordId)) {
          result.unknown.push({
            trackingKeywordId: k.trackingKeywordId,
            keyword: k.keyword,
          });
        }
      }
    }
  }
  return { finalRead, enginePatchTargets, attemptedPatches };
}
