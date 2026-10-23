import { z } from "zod";
import { db } from "@/db";
import { competitorSnapshots, projects, keywordMetrics } from "@/db/schema";
import { and, desc, eq } from "drizzle-orm";

/**
 * D1 persistence for SERP competitor analyses (DataForSEO labs
 * serp_competitors). The DataForSEO provider write-throughs every paid fetch
 * here; the internal provider serves the latest snapshot back for free, so a
 * repeat analysis of the same keyword set + market never re-bills.
 *
 * Snapshots are scoped by (projectId, keywordKey, locationCode, languageCode).
 * keywordKey is the canonical form of the requested keyword set — lowercased,
 * deduped, sorted — so "CRM", ["crm"] and ["crm", "sales"] + ["sales", "crm"]
 * all resolve to the same key. Rows accumulate; reads take the latest.
 */

const itemsSchema = z.array(z.unknown());
const countSchema = z.number();

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Reads a numeric counter off an untrusted payload field. */
function readCount(source: unknown, key: string): number | undefined {
  if (!isRecord(source)) return undefined;
  const parsed = countSchema.safeParse(source[key]);
  return parsed.success ? parsed.data : undefined;
}

/** Reads the competitor item list off an untrusted payload. */
function readItems(source: unknown): unknown[] | null {
  if (!isRecord(source)) return null;
  const parsed = itemsSchema.safeParse(source.items);
  return parsed.success ? parsed.data : null;
}

export function canonicalKeywordKey(keywords: string[]): string {
  const canonical = [
    ...new Set(keywords.map((keyword) => keyword.toLowerCase())),
  ].toSorted();
  return JSON.stringify(canonical);
}

export async function persistCompetitorSnapshot(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  items: unknown[];
  totalCount?: number;
  itemsCount?: number;
  limit?: number;
}): Promise<void> {
  let payload: unknown = params.items;
  const totalCount =
    params.totalCount ?? readCount(params.items, "total_count");
  const itemsCount =
    params.itemsCount ?? readCount(params.items, "items_count");
  const limit = params.limit ?? readCount(params.items, "limit");

  if (
    totalCount !== undefined ||
    itemsCount !== undefined ||
    limit !== undefined
  ) {
    payload = {
      total_count: totalCount,
      items_count: itemsCount,
      limit,
      items: params.items,
    };
  }

  await db.insert(competitorSnapshots).values({
    projectId: params.projectId,
    keywordKey: canonicalKeywordKey(params.keywords),
    keywordsJson: JSON.stringify(params.keywords),
    locationCode: params.locationCode,
    languageCode: params.languageCode,
    itemsJson: JSON.stringify(payload),
  });
}

/**
 * Latest persisted snapshot for a keyword set + market, or null when none
 * exists. Corrupt JSON or a non-array payload is treated as a miss.
 */
export async function getLatestCompetitorSnapshot(params: {
  projectId: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
}): Promise<unknown[] | null> {
  const rows = await db
    .select()
    .from(competitorSnapshots)
    .where(
      and(
        eq(competitorSnapshots.projectId, params.projectId),
        eq(
          competitorSnapshots.keywordKey,
          canonicalKeywordKey(params.keywords),
        ),
        eq(competitorSnapshots.locationCode, params.locationCode),
        eq(competitorSnapshots.languageCode, params.languageCode),
      ),
    )
    .orderBy(desc(competitorSnapshots.fetchedAt))
    .limit(1);

  const row = rows[0];
  if (!row) return null;

  try {
    const parsed: unknown = JSON.parse(row.itemsJson);
    const items = itemsSchema.safeParse(parsed);
    if (items.success) return items.data;
    const nested = readItems(parsed);
    if (nested) return nested;
    return null;
  } catch {
    return null;
  }
}

export type StoredCompetitorSnapshot = {
  id: number;
  projectId: string;
  keywordKey: string;
  keywords: string[];
  locationCode: number;
  languageCode: string;
  items: unknown[];
  totalCount?: number | null;
  itemsCount?: number | null;
  limit?: number | null;
  fetchedAt: string;
};

/**
 * Reads the latest stored competitor snapshots for a project. Returns up to
 * `limit` valid snapshots. Corrupt rows are omitted.
 */
export async function getLatestCompetitorSnapshotsForProject(
  projectId: string,
  limit = 20,
): Promise<StoredCompetitorSnapshot[]> {
  const rows = await db
    .select()
    .from(competitorSnapshots)
    .where(eq(competitorSnapshots.projectId, projectId))
    .orderBy(desc(competitorSnapshots.fetchedAt))
    .limit(limit);

  const out: StoredCompetitorSnapshot[] = [];
  for (const row of rows) {
    try {
      const parsed: unknown = JSON.parse(row.itemsJson);
      const keywords: unknown = JSON.parse(row.keywordsJson);
      if (!Array.isArray(keywords)) continue;

      const arrayItems = itemsSchema.safeParse(parsed);
      const nestedItems = arrayItems.success ? null : readItems(parsed);
      const items = arrayItems.success ? arrayItems.data : nestedItems;
      if (!items) continue;

      const totalCount = readCount(parsed, "total_count") ?? null;
      const itemsCount = readCount(parsed, "items_count") ?? null;
      const snapshotLimit = readCount(parsed, "limit") ?? null;

      out.push({
        id: row.id,
        projectId: row.projectId,
        keywordKey: row.keywordKey,
        keywords: keywords.map(String),
        locationCode: row.locationCode,
        languageCode: row.languageCode,
        items,
        totalCount,
        itemsCount,
        limit: snapshotLimit,
        fetchedAt: row.fetchedAt,
      });
    } catch {
      // Skip unparseable rows
    }
  }
  return out;
}

export async function getProjectDomain(
  projectId: string,
): Promise<string | null> {
  const rows = await db
    .select({ domain: projects.domain })
    .from(projects)
    .where(eq(projects.id, projectId))
    .limit(1);
  return rows[0]?.domain ?? null;
}

export async function getKeywordSearchVolumes(
  projectId: string,
): Promise<Map<string, number>> {
  const rows = await db
    .select({
      keyword: keywordMetrics.keyword,
      searchVolume: keywordMetrics.searchVolume,
    })
    .from(keywordMetrics)
    .where(eq(keywordMetrics.projectId, projectId));
  const map = new Map<string, number>();
  for (const r of rows) {
    if (typeof r.searchVolume === "number" && r.searchVolume > 0) {
      map.set(r.keyword.toLowerCase(), r.searchVolume);
    }
  }
  return map;
}

export async function getProjectMarket(
  projectId: string,
): Promise<{ locationCode: number; languageCode: string } | null> {
  try {
    const rows = await db
      .select({
        locationCode: projects.locationCode,
        languageCode: projects.languageCode,
      })
      .from(projects)
      .where(eq(projects.id, projectId))
      .limit(1);
    const row = rows[0];
    if (!row) return null;
    return {
      locationCode: row.locationCode ?? 2840,
      languageCode: row.languageCode ?? "en",
    };
  } catch {
    return null;
  }
}
