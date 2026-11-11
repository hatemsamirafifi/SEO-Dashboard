import { and, eq, inArray, isNull } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { db } from "@/db";
import { rankTrackingTargets, rankTrackingKeywordTargets } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";

export const RankTrackingTargetRepository = {
  async createTarget(
    data: InferInsertModel<typeof rankTrackingTargets>,
  ): Promise<InferSelectModel<typeof rankTrackingTargets>> {
    const now = new Date().toISOString();
    const row: InferSelectModel<typeof rankTrackingTargets> = {
      id: data.id,
      organizationId: data.organizationId,
      localProjectId: data.localProjectId,
      trackingConfigId: data.trackingConfigId ?? null,
      searchEngine: data.searchEngine ?? "google",
      countryCode: data.countryCode,
      regionCode: data.regionCode ?? null,
      cityName: data.cityName ?? null,
      languageCode: data.languageCode ?? "en",
      device: data.device,
      enabled: data.enabled ?? true,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };
    await db.insert(rankTrackingTargets).values(row);
    return row;
  },

  async getTargetById(
    targetId: string,
  ): Promise<InferSelectModel<typeof rankTrackingTargets> | null> {
    const rows = await db
      .select()
      .from(rankTrackingTargets)
      .where(eq(rankTrackingTargets.id, targetId))
      .limit(1);
    return rows[0] ?? null;
  },

  async getTargetsForProject(projectId: string, enabledOnly = true) {
    const conditions = [eq(rankTrackingTargets.localProjectId, projectId)];
    if (enabledOnly) {
      conditions.push(eq(rankTrackingTargets.enabled, true));
    }
    return db
      .select()
      .from(rankTrackingTargets)
      .where(and(...conditions))
      .orderBy(rankTrackingTargets.createdAt);
  },

  async getTargetsForConfig(configId: string, enabledOnly = true) {
    const conditions = [eq(rankTrackingTargets.trackingConfigId, configId)];
    if (enabledOnly) {
      conditions.push(eq(rankTrackingTargets.enabled, true));
    }
    return db
      .select()
      .from(rankTrackingTargets)
      .where(and(...conditions))
      .orderBy(rankTrackingTargets.createdAt);
  },

  async findTarget(params: {
    localProjectId: string;
    searchEngine: string;
    countryCode: string;
    cityName?: string | null;
    languageCode: string;
    device: "desktop" | "mobile";
  }) {
    const conditions = [
      eq(rankTrackingTargets.localProjectId, params.localProjectId),
      eq(rankTrackingTargets.searchEngine, params.searchEngine),
      eq(rankTrackingTargets.countryCode, params.countryCode.toLowerCase()),
      eq(rankTrackingTargets.languageCode, params.languageCode.toLowerCase()),
      eq(rankTrackingTargets.device, params.device),
    ];

    if (params.cityName) {
      conditions.push(eq(rankTrackingTargets.cityName, params.cityName));
    } else {
      conditions.push(isNull(rankTrackingTargets.cityName));
    }

    const rows = await db
      .select()
      .from(rankTrackingTargets)
      .where(and(...conditions))
      .limit(1);
    return rows[0] ?? null;
  },

  async updateTarget(
    targetId: string,
    data: Partial<InferInsertModel<typeof rankTrackingTargets>>,
  ) {
    const nowIso = new Date().toISOString();
    await db
      .update(rankTrackingTargets)
      .set({ ...data, updatedAt: nowIso })
      .where(eq(rankTrackingTargets.id, targetId));
  },

  /**
   * Non-destructive: sets enabled to false, preserving local targets,
   * bindings, and history.
   */
  async softDeleteTarget(targetId: string) {
    const nowIso = new Date().toISOString();
    await db
      .update(rankTrackingTargets)
      .set({ enabled: false, updatedAt: nowIso })
      .where(eq(rankTrackingTargets.id, targetId));
  },

  async assignKeywordToTarget(
    keywordId: string,
    targetId: string,
    id?: string,
  ) {
    const recordId = id || crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await db
      .insert(rankTrackingKeywordTargets)
      .values({
        id: recordId,
        trackingKeywordId: keywordId,
        trackingTargetId: targetId,
        enabled: true,
        createdAt: nowIso,
        updatedAt: nowIso,
      })
      .onConflictDoUpdate({
        target: [
          rankTrackingKeywordTargets.trackingKeywordId,
          rankTrackingKeywordTargets.trackingTargetId,
        ],
        set: {
          enabled: true,
          updatedAt: nowIso,
        },
      });
  },

  async bulkAssignKeywordsToTargets(
    pairs: Array<{ keywordId: string; targetId: string }>,
  ) {
    if (pairs.length === 0) return;
    const rows = pairs.map((p) => ({
      id: crypto.randomUUID(),
      trackingKeywordId: p.keywordId,
      trackingTargetId: p.targetId,
      enabled: true,
    }));
    await executeInBatches(rows, (tx, row) =>
      tx.insert(rankTrackingKeywordTargets).values(row).onConflictDoNothing(),
    );
  },

  async getKeywordTargetsForTargets(targetIds: string[], enabledOnly = true) {
    if (targetIds.length === 0) return [];
    const conditions = [
      inArray(rankTrackingKeywordTargets.trackingTargetId, targetIds),
    ];
    if (enabledOnly) {
      conditions.push(eq(rankTrackingKeywordTargets.enabled, true));
    }
    return db
      .select()
      .from(rankTrackingKeywordTargets)
      .where(and(...conditions));
  },

  async getKeywordTargetsForKeyword(keywordId: string, enabledOnly = true) {
    const conditions = [
      eq(rankTrackingKeywordTargets.trackingKeywordId, keywordId),
    ];
    if (enabledOnly) {
      conditions.push(eq(rankTrackingKeywordTargets.enabled, true));
    }
    return db
      .select()
      .from(rankTrackingKeywordTargets)
      .where(and(...conditions));
  },

  async getKeywordTargetsForTarget(targetId: string, enabledOnly = true) {
    const conditions = [
      eq(rankTrackingKeywordTargets.trackingTargetId, targetId),
    ];
    if (enabledOnly) {
      conditions.push(eq(rankTrackingKeywordTargets.enabled, true));
    }
    return db
      .select()
      .from(rankTrackingKeywordTargets)
      .where(and(...conditions));
  },

  /**
   * Non-destructive: disables association without deleting record
   */
  async disableKeywordTarget(keywordId: string, targetId: string) {
    const nowIso = new Date().toISOString();
    await db
      .update(rankTrackingKeywordTargets)
      .set({ enabled: false, updatedAt: nowIso })
      .where(
        and(
          eq(rankTrackingKeywordTargets.trackingKeywordId, keywordId),
          eq(rankTrackingKeywordTargets.trackingTargetId, targetId),
        ),
      );
  },
};
