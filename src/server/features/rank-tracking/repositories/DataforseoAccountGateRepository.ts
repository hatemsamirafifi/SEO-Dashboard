import { and, eq, lte, sql } from "drizzle-orm";
import { db } from "@/db";
import { dataforseoAccountRequestSlots } from "@/db/schema";

// Persistent, cross-worker coordination slot for DataForSEO account-scoped
// rank-check dispatch. One row per account (SHA-256 of the effective login —
// never credentials). Every statement is a single atomic UPDATE/INSERT,
// deliberately NOT a transaction: callers wait on the network while holding
// the slot and must never hold a database transaction meanwhile.
//
//   acquire: UPDATE ... SET epoch = epoch + 1 WHERE account_hash = ? AND
//            free_at <= now  (free hand-off, or expired-lease reclaim).
//   create:  INSERT ... ON CONFLICT DO NOTHING for a first-seen account.
//   release: UPDATE ... SET free_at = now + pacing WHERE epoch = ?  — the
//            epoch match is the fence: a stale owner (crashed, lease
//            expired, slot reclaimed with a bumped epoch) matches zero rows.

export interface DataforseoAccountSlotLease {
  /** Fencing counter of the acquired slot; required for a fenced release. */
  epoch: number;
}

export interface DataforseoAccountSlotStore {
  tryAcquireSlot(input: {
    accountHash: string;
    nowIso: string;
    leaseUntilIso: string;
  }): Promise<DataforseoAccountSlotLease | null>;

  tryCreateSlot(input: {
    accountHash: string;
    nowIso: string;
    leaseUntilIso: string;
  }): Promise<DataforseoAccountSlotLease | null>;

  /** Fenced release: returns false when the epoch fence rejected it. */
  releaseSlot(input: {
    accountHash: string;
    epoch: number;
    freeAtIso: string;
  }): Promise<boolean>;
}

async function tryAcquireSlot(input: {
  accountHash: string;
  nowIso: string;
  leaseUntilIso: string;
}): Promise<DataforseoAccountSlotLease | null> {
  const rows = await db
    .update(dataforseoAccountRequestSlots)
    .set({
      epoch: sql`${dataforseoAccountRequestSlots.epoch} + 1`,
      acquiredAt: input.nowIso,
      freeAt: input.leaseUntilIso,
    })
    .where(
      and(
        eq(dataforseoAccountRequestSlots.accountHash, input.accountHash),
        lte(dataforseoAccountRequestSlots.freeAt, input.nowIso),
      ),
    )
    .returning({ epoch: dataforseoAccountRequestSlots.epoch });
  return rows[0] ?? null;
}

async function tryCreateSlot(input: {
  accountHash: string;
  nowIso: string;
  leaseUntilIso: string;
}): Promise<DataforseoAccountSlotLease | null> {
  const rows = await db
    .insert(dataforseoAccountRequestSlots)
    .values({
      accountHash: input.accountHash,
      epoch: 1,
      acquiredAt: input.nowIso,
      freeAt: input.leaseUntilIso,
    })
    .onConflictDoNothing({ target: dataforseoAccountRequestSlots.accountHash })
    .returning({ epoch: dataforseoAccountRequestSlots.epoch });
  return rows[0] ?? null;
}

async function releaseSlot(input: {
  accountHash: string;
  epoch: number;
  freeAtIso: string;
}): Promise<boolean> {
  const rows = await db
    .update(dataforseoAccountRequestSlots)
    .set({ freeAt: input.freeAtIso })
    .where(
      and(
        eq(dataforseoAccountRequestSlots.accountHash, input.accountHash),
        eq(dataforseoAccountRequestSlots.epoch, input.epoch),
      ),
    )
    .returning({ epoch: dataforseoAccountRequestSlots.epoch });
  return rows.length > 0;
}

export const DataforseoAccountGateRepository: DataforseoAccountSlotStore = {
  tryAcquireSlot,
  tryCreateSlot,
  releaseSlot,
};
