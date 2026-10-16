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
  const meta = params.items as unknown as {
    total_count?: number;
    items_count?: number;
    limit?: number;
  };
  const totalCount =
    params.totalCount ??
    (typeof meta.total_count === "number" ? meta.total_count : undefined);
  const itemsCount =
    params.itemsCount ??
    (typeof meta.items_count === "number" ? meta.items_count : undefined);
  const limit =
    params.limit ??
    (typeof meta.limit === "number" ? meta.limit : undefined);

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
    if (Array.isArray(parsed)) return parsed;
    if (
      parsed &&
      typeof parsed === "object" &&
      "items" in parsed &&
      Array.isArray((parsed as { items: unknown[] }).items)
    ) {
      return (parsed as { items: unknown[] }).items;
    }
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

      let items: unknown[] = [];
      let totalCount: number | null = null;
      let itemsCount: number | null = null;
      let snapshotLimit: number | null = null;

      if (Array.isArray(parsed)) {
        items = parsed;
        const meta = parsed as unknown as {
          total_count?: number;
          items_count?: number;
          limit?: number;
        };
        totalCount =
          typeof meta.total_count === "number" ? meta.total_count : null;
        itemsCount =
          typeof meta.items_count === "number" ? meta.items_count : null;
        snapshotLimit =
          typeof meta.limit === "number" ? meta.limit : null;
      } else if (
        parsed &&
        typeof parsed === "object" &&
        "items" in parsed &&
        Array.isArray((parsed as { items: unknown[] }).items)
      ) {
        const obj = parsed as {
          items: unknown[];
          total_count?: number;
          items_count?: number;
          limit?: number;
        };
        items = obj.items;
        totalCount =
          typeof obj.total_count === "number" ? obj.total_count : null;
        itemsCount =
          typeof obj.items_count === "number" ? obj.items_count : null;
        snapshotLimit =
          typeof obj.limit === "number" ? obj.limit : null;
      } else {
        continue;
      }

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
