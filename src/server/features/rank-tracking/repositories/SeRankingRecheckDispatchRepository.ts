import { eq } from "drizzle-orm";
import type { InferInsertModel, InferSelectModel } from "drizzle-orm";
import { db } from "@/db";
import { seRankingRecheckDispatch } from "@/db/schema";

export type RecheckDispatchRow = InferSelectModel<
  typeof seRankingRecheckDispatch
>;
export type RecheckDispatchInsert = InferInsertModel<
  typeof seRankingRecheckDispatch
>;

/**
 * Durable dispatch ledger for paid SE Ranking recheck POSTs.
 *
 * The recheck endpoint is not idempotent and SE Ranking exposes no check-job
 * ID, so this row is the only guard against re-billing the same recheck after
 * a workflow restart or step retry. Status lifecycle is owned by
 * `dispatchSeRankingRecheck` (seRankingCheckDispatch.ts).
 */
export const SeRankingRecheckDispatchRepository = {
  async getDispatchById(id: string): Promise<RecheckDispatchRow | null> {
    const rows = await db
      .select()
      .from(seRankingRecheckDispatch)
      .where(eq(seRankingRecheckDispatch.id, id))
      .limit(1);
    return rows[0] ?? null;
  },

  async createDispatch(
    data: RecheckDispatchInsert,
  ): Promise<RecheckDispatchRow | null> {
    const inserted = await db
      .insert(seRankingRecheckDispatch)
      .values(data)
      .onConflictDoNothing()
      .returning();
    return inserted[0] ?? null;
  },

  async updateDispatch(
    id: string,
    data: Partial<
      Pick<
        RecheckDispatchInsert,
        "status" | "dispatchedAt" | "outcomeAt" | "providerResponse"
      >
    >,
  ): Promise<void> {
    await db
      .update(seRankingRecheckDispatch)
      .set(data)
      .where(eq(seRankingRecheckDispatch.id, id));
  },
};
