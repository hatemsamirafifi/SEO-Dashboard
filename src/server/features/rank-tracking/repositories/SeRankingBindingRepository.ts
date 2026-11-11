import { and, desc, eq } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { db } from "@/db";
import {
  seRankingAccountBindings,
  seRankingProjectBindings,
  seRankingEngineBindings,
  seRankingKeywordMappings,
} from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";

export type AccountBindingRow = InferSelectModel<
  typeof seRankingAccountBindings
>;
export type ProjectBindingRow = InferSelectModel<
  typeof seRankingProjectBindings
>;
export type EngineBindingRow = InferSelectModel<typeof seRankingEngineBindings>;

export const SeRankingBindingRepository = {
  // ---------------------------------------------------------------------------
  // Account Bindings
  // ---------------------------------------------------------------------------
  async getAccountBinding(
    organizationId: string,
    accountFingerprint: string,
  ): Promise<AccountBindingRow | null> {
    const rows = await db
      .select()
      .from(seRankingAccountBindings)
      .where(
        and(
          eq(seRankingAccountBindings.organizationId, organizationId),
          eq(seRankingAccountBindings.accountFingerprint, accountFingerprint),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getActiveAccountBinding(
    organizationId: string,
  ): Promise<AccountBindingRow | null> {
    const rows = await db
      .select()
      .from(seRankingAccountBindings)
      .where(
        and(
          eq(seRankingAccountBindings.organizationId, organizationId),
          eq(seRankingAccountBindings.status, "active"),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertAccountBinding(
    data: InferInsertModel<typeof seRankingAccountBindings>,
  ): Promise<AccountBindingRow> {
    const now = new Date().toISOString();
    const existing = await this.getAccountBinding(
      data.organizationId,
      data.accountFingerprint,
    );
    if (existing) {
      const updated: AccountBindingRow = {
        ...existing,
        status: data.status ?? existing.status,
        lastValidatedAt: data.lastValidatedAt ?? existing.lastValidatedAt,
        credentialVersion: data.credentialVersion ?? existing.credentialVersion,
        updatedAt: now,
      };
      await db
        .update(seRankingAccountBindings)
        .set({
          status: updated.status,
          lastValidatedAt: updated.lastValidatedAt,
          credentialVersion: updated.credentialVersion,
          updatedAt: updated.updatedAt,
        })
        .where(eq(seRankingAccountBindings.id, existing.id));
      return updated;
    }

    const row: AccountBindingRow = {
      id: data.id,
      organizationId: data.organizationId,
      accountFingerprint: data.accountFingerprint,
      credentialVersion: data.credentialVersion ?? 1,
      status: data.status ?? "active",
      lastValidatedAt: data.lastValidatedAt ?? null,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };
    await db.insert(seRankingAccountBindings).values(row);
    return row;
  },

  async updateAccountBindingStatus(
    id: string,
    status: "active" | "migration_required" | "disconnected",
  ) {
    await db
      .update(seRankingAccountBindings)
      .set({
        status,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(seRankingAccountBindings.id, id));
  },

  // ---------------------------------------------------------------------------
  // Project Bindings
  // ---------------------------------------------------------------------------
  async getProjectBinding(
    localProjectId: string,
    providerAccountBindingId: string,
  ): Promise<ProjectBindingRow | null> {
    const rows = await db
      .select()
      .from(seRankingProjectBindings)
      .where(
        and(
          eq(seRankingProjectBindings.localProjectId, localProjectId),
          eq(
            seRankingProjectBindings.providerAccountBindingId,
            providerAccountBindingId,
          ),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async getProjectBindingByLocalProject(
    localProjectId: string,
  ): Promise<ProjectBindingRow | null> {
    const rows = await db
      .select()
      .from(seRankingProjectBindings)
      .where(eq(seRankingProjectBindings.localProjectId, localProjectId))
      .orderBy(desc(seRankingProjectBindings.updatedAt))
      .limit(1);
    return rows[0] ?? null;
  },

  async getProjectBindingsForProject(
    localProjectId: string,
  ): Promise<ProjectBindingRow[]> {
    return db
      .select()
      .from(seRankingProjectBindings)
      .where(eq(seRankingProjectBindings.localProjectId, localProjectId))
      .orderBy(desc(seRankingProjectBindings.updatedAt));
  },

  async upsertProjectBinding(
    data: InferInsertModel<typeof seRankingProjectBindings>,
  ): Promise<ProjectBindingRow> {
    const now = new Date().toISOString();
    const row: ProjectBindingRow = {
      id: data.id,
      organizationId: data.organizationId,
      localProjectId: data.localProjectId,
      providerAccountBindingId: data.providerAccountBindingId,
      remoteSiteId: data.remoteSiteId ?? null,
      status: data.status ?? "pending",
      lastSuccessfulSync: data.lastSuccessfulSync ?? null,
      errorMessage: data.errorMessage ?? null,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    await db
      .insert(seRankingProjectBindings)
      .values(row)
      .onConflictDoUpdate({
        target: [
          seRankingProjectBindings.localProjectId,
          seRankingProjectBindings.providerAccountBindingId,
        ],
        set: {
          remoteSiteId: row.remoteSiteId,
          status: row.status,
          lastSuccessfulSync: row.lastSuccessfulSync,
          errorMessage: row.errorMessage,
          updatedAt: now,
        },
      });

    const canonical = await this.getProjectBinding(
      data.localProjectId,
      data.providerAccountBindingId,
    );
    return canonical ?? row;
  },

  async updateProjectBinding(
    id: string,
    data: Partial<InferInsertModel<typeof seRankingProjectBindings>>,
  ) {
    await db
      .update(seRankingProjectBindings)
      .set({
        ...data,
        updatedAt: new Date().toISOString(),
      })
      .where(eq(seRankingProjectBindings.id, id));
  },

  // ---------------------------------------------------------------------------
  // Engine Bindings
  // ---------------------------------------------------------------------------
  async getEngineBindingsForProject(projectBindingId: string) {
    return db
      .select()
      .from(seRankingEngineBindings)
      .where(eq(seRankingEngineBindings.projectBindingId, projectBindingId));
  },

  async getEngineBindingForTarget(
    projectBindingId: string,
    trackingTargetId: string,
  ): Promise<EngineBindingRow | null> {
    const rows = await db
      .select()
      .from(seRankingEngineBindings)
      .where(
        and(
          eq(seRankingEngineBindings.projectBindingId, projectBindingId),
          eq(seRankingEngineBindings.trackingTargetId, trackingTargetId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertEngineBinding(
    data: InferInsertModel<typeof seRankingEngineBindings>,
  ): Promise<EngineBindingRow> {
    const now = new Date().toISOString();
    const row: EngineBindingRow = {
      id: data.id,
      projectBindingId: data.projectBindingId,
      trackingTargetId: data.trackingTargetId,
      remoteSiteEngineId: data.remoteSiteEngineId,
      remoteSearchEngineId: data.remoteSearchEngineId,
      remoteRegionId: data.remoteRegionId ?? null,
      remoteRegionName: data.remoteRegionName ?? null,
      remoteLanguageCode: data.remoteLanguageCode ?? null,
      syncStatus: data.syncStatus ?? "pending",
      lastSuccessfulSync: data.lastSuccessfulSync ?? null,
      createdAt: data.createdAt ?? now,
      updatedAt: data.updatedAt ?? now,
    };

    await db
      .insert(seRankingEngineBindings)
      .values(row)
      .onConflictDoUpdate({
        target: [
          seRankingEngineBindings.projectBindingId,
          seRankingEngineBindings.trackingTargetId,
        ],
        set: {
          remoteSiteEngineId: row.remoteSiteEngineId,
          remoteSearchEngineId: row.remoteSearchEngineId,
          remoteRegionId: row.remoteRegionId,
          remoteRegionName: row.remoteRegionName,
          remoteLanguageCode: row.remoteLanguageCode,
          syncStatus: row.syncStatus,
          lastSuccessfulSync: row.lastSuccessfulSync,
          updatedAt: now,
        },
      });

    const canonical = await this.getEngineBindingForTarget(
      data.projectBindingId,
      data.trackingTargetId,
    );
    return canonical ?? row;
  },

  // ---------------------------------------------------------------------------
  // Keyword Mappings
  // ---------------------------------------------------------------------------
  async getKeywordMappingsForProject(projectBindingId: string) {
    return db
      .select()
      .from(seRankingKeywordMappings)
      .where(eq(seRankingKeywordMappings.projectBindingId, projectBindingId));
  },

  async getKeywordMapping(projectBindingId: string, trackingKeywordId: string) {
    const rows = await db
      .select()
      .from(seRankingKeywordMappings)
      .where(
        and(
          eq(seRankingKeywordMappings.projectBindingId, projectBindingId),
          eq(seRankingKeywordMappings.trackingKeywordId, trackingKeywordId),
        ),
      )
      .limit(1);
    return rows[0] ?? null;
  },

  async upsertKeywordMapping(
    data: InferInsertModel<typeof seRankingKeywordMappings>,
  ) {
    const now = new Date().toISOString();
    await db
      .insert(seRankingKeywordMappings)
      .values({ ...data, createdAt: data.createdAt ?? now, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          seRankingKeywordMappings.projectBindingId,
          seRankingKeywordMappings.trackingKeywordId,
        ],
        set: {
          remoteKeywordId: data.remoteKeywordId,
          status: data.status ?? "synced",
          updatedAt: now,
        },
      });
    return (
      (await this.getKeywordMapping(
        data.projectBindingId,
        data.trackingKeywordId,
      )) ?? data
    );
  },

  async bulkUpsertKeywordMappings(
    rows: InferInsertModel<typeof seRankingKeywordMappings>[],
  ) {
    if (rows.length === 0) return;
    const now = new Date().toISOString();
    await executeInBatches(rows, (tx, row) =>
      tx
        .insert(seRankingKeywordMappings)
        .values({ ...row, createdAt: row.createdAt ?? now, updatedAt: now })
        .onConflictDoUpdate({
          target: [
            seRankingKeywordMappings.projectBindingId,
            seRankingKeywordMappings.trackingKeywordId,
          ],
          set: {
            remoteKeywordId: row.remoteKeywordId,
            status: row.status ?? "synced",
            updatedAt: now,
          },
        }),
    );
  },

  /**
   * Reuses engine bindings & keyword mappings when an API key rotates on the
   * SAME SE Ranking account (same accessible remoteSiteId) without duplicating remote resources.
   */
  async cloneBindingsForKeyRotation(
    fromProjectBindingId: string,
    toProjectBindingId: string,
  ) {
    if (fromProjectBindingId === toProjectBindingId) return;
    const now = new Date().toISOString();

    const [engines, kwMappings] = await Promise.all([
      this.getEngineBindingsForProject(fromProjectBindingId),
      this.getKeywordMappingsForProject(fromProjectBindingId),
    ]);

    for (const eng of engines) {
      await db
        .insert(seRankingEngineBindings)
        .values({
          id: crypto.randomUUID(),
          projectBindingId: toProjectBindingId,
          trackingTargetId: eng.trackingTargetId,
          remoteSiteEngineId: eng.remoteSiteEngineId,
          remoteSearchEngineId: eng.remoteSearchEngineId,
          remoteRegionId: eng.remoteRegionId,
          remoteRegionName: eng.remoteRegionName,
          remoteLanguageCode: eng.remoteLanguageCode,
          syncStatus: eng.syncStatus,
          lastSuccessfulSync: eng.lastSuccessfulSync,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing();
    }

    if (kwMappings.length > 0) {
      await executeInBatches(kwMappings, (tx, m) =>
        tx
          .insert(seRankingKeywordMappings)
          .values({
            id: crypto.randomUUID(),
            projectBindingId: toProjectBindingId,
            trackingKeywordId: m.trackingKeywordId,
            remoteKeywordId: m.remoteKeywordId,
            status: m.status,
            createdAt: now,
            updatedAt: now,
          })
          .onConflictDoNothing(),
      );
    }
  },
};
