import { and, eq, gte } from "drizzle-orm";
import { db } from "@/db";
import { serpOrganicSnapshots } from "@/db/schema";
import { executeInBatches } from "@/db/runBatch";
import { sha256HexFull } from "@/shared/intelligence";

/**
 * Storage for the organic results observed during a rank check (spec 019).
 *
 * The rows are what the provider already returned; nothing here calls a
 * provider. Writes are idempotent: a replayed workflow step produces the same
 * deterministic ids and the unique index swallows the duplicates.
 */

export type SerpOrganicSnapshotRow = {
  projectId: string;
  configId: string;
  runId: string;
  trackingKeywordId: string;
  keyword: string;
  searchEngine: string;
  locationCode: number;
  locationName: string | null;
  languageCode: string;
  device: "desktop" | "mobile";
  position: number;
  url: string;
  normalizedUrl: string;
  title: string | null;
  domain: string | null;
  provider: string;
  coverageStatus: "full" | "partial";
  observedAt: string;
};

async function deterministicId(row: SerpOrganicSnapshotRow): Promise<string> {
  return (
    await sha256HexFull(
      [
        row.runId,
        row.trackingKeywordId,
        row.device,
        String(row.position),
        row.normalizedUrl,
      ].join("|"),
    )
  ).slice(0, 36);
}

async function insertOrganicSnapshots(rows: SerpOrganicSnapshotRow[]) {
  if (rows.length === 0) return;
  await executeInBatches(rows, async (tx, row) =>
    tx
      .insert(serpOrganicSnapshots)
      .values({ id: await deterministicId(row), ...row })
      .onConflictDoNothing(),
  );
}

type StoredOrganicSnapshot = {
  trackingKeywordId: string;
  keyword: string;
  position: number;
  url: string;
  normalizedUrl: string;
  title: string | null;
  domain: string | null;
  provider: string;
  coverageStatus: "full" | "partial";
  observedAt: string;
  searchEngine: string;
  locationCode: number;
  languageCode: string;
  device: "desktop" | "mobile";
};

/**
 * Stored organic rows for one project, market, and device inside the
 * freshness window. Bounded: the clustering read never loads every row the
 * project ever stored.
 */
async function getOrganicSnapshots(input: {
  projectId: string;
  configId: string;
  device: "desktop" | "mobile";
  locationCode: number;
  languageCode: string;
  since: string;
  limit?: number;
}): Promise<StoredOrganicSnapshot[]> {
  const rows = await db
    .select({
      trackingKeywordId: serpOrganicSnapshots.trackingKeywordId,
      keyword: serpOrganicSnapshots.keyword,
      position: serpOrganicSnapshots.position,
      url: serpOrganicSnapshots.url,
      normalizedUrl: serpOrganicSnapshots.normalizedUrl,
      title: serpOrganicSnapshots.title,
      domain: serpOrganicSnapshots.domain,
      provider: serpOrganicSnapshots.provider,
      coverageStatus: serpOrganicSnapshots.coverageStatus,
      observedAt: serpOrganicSnapshots.observedAt,
      searchEngine: serpOrganicSnapshots.searchEngine,
      locationCode: serpOrganicSnapshots.locationCode,
      languageCode: serpOrganicSnapshots.languageCode,
      device: serpOrganicSnapshots.device,
    })
    .from(serpOrganicSnapshots)
    .where(
      and(
        eq(serpOrganicSnapshots.projectId, input.projectId),
        eq(serpOrganicSnapshots.configId, input.configId),
        eq(serpOrganicSnapshots.device, input.device),
        eq(serpOrganicSnapshots.locationCode, input.locationCode),
        eq(serpOrganicSnapshots.languageCode, input.languageCode),
        gte(serpOrganicSnapshots.observedAt, input.since),
      ),
    )
    .limit(input.limit ?? 5_000);
  return rows;
}

export const SerpOrganicSnapshotRepository = {
  insertOrganicSnapshots,
  getOrganicSnapshots,
};
