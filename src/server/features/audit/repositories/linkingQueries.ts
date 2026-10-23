import { and, eq, gte, inArray, isNotNull, lt, ne, or, sql } from "drizzle-orm";
import { db } from "@/db";
import { auditLinks, auditPages } from "@/db/schema";
import { asPageTypeName } from "@/server/lib/audit/issues/multipage-checks";
import type {
  BrokenLinkEdge,
  InboundEdge,
  InboundStats,
  LinkingPage,
  NonIndexableTargetEdge,
} from "@/server/lib/audit/linking/types";

const EDGE_QUERY_LIMIT = 2_000;
const INBOUND_TARGET_CHUNK = 90;

export async function getLinkingPages(auditId: string): Promise<LinkingPage[]> {
  const rows = await db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      extractionState: auditPages.extractionState,
      title: auditPages.title,
      h1Text: auditPages.h1Text,
      metaDescription: auditPages.metaDescription,
      contentHash: auditPages.contentHash,
      redirectUrl: auditPages.redirectUrl,
      wordCount: auditPages.wordCount,
      isIndexable: auditPages.isIndexable,
      canonicalUrl: auditPages.canonicalUrl,
      headerCanonicalUrl: auditPages.headerCanonicalUrl,
      pageType: auditPages.pageType,
      crawlDepth: auditPages.crawlDepth,
      inSitemap: auditPages.inSitemap,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));

  return rows.map((row) => ({
    ...row,
    pageType: asPageTypeName(row.pageType),
  }));
}

export async function getInboundStats(
  auditId: string,
): Promise<InboundStats[]> {
  const rows = await db
    .select({
      targetUrl: auditLinks.targetUrl,
      inboundLinks: sql<number>`count(case when not ${auditLinks.isNofollow} and ${auditLinks.sourcePageId} <> ${auditPages.id} then 1 end)`,
      inboundSources: sql<number>`count(distinct case when not ${auditLinks.isNofollow} and ${auditLinks.sourcePageId} <> ${auditPages.id} then ${auditLinks.sourcePageId} end)`,
      allInboundLinks: sql<number>`count(case when ${auditLinks.sourcePageId} <> ${auditPages.id} then 1 end)`,
      allInboundSources: sql<number>`count(distinct case when ${auditLinks.sourcePageId} <> ${auditPages.id} then ${auditLinks.sourcePageId} end)`,
      distinctAnchors: sql<number>`count(distinct case when not ${auditLinks.isNofollow} and ${auditLinks.sourcePageId} <> ${auditPages.id} and trim(coalesce(${auditLinks.anchor}, '')) <> '' then lower(trim(${auditLinks.anchor})) end)`,
      emptyAnchors: sql<number>`sum(case when not ${auditLinks.isNofollow} and ${auditLinks.sourcePageId} <> ${auditPages.id} and trim(coalesce(${auditLinks.anchor}, '')) = '' then 1 else 0 end)`,
      sampleAnchor: sql<
        string | null
      >`max(case when not ${auditLinks.isNofollow} and ${auditLinks.sourcePageId} <> ${auditPages.id} and trim(coalesce(${auditLinks.anchor}, '')) <> '' then trim(${auditLinks.anchor}) end)`,
    })
    .from(auditLinks)
    .innerJoin(
      auditPages,
      and(
        eq(auditPages.auditId, auditLinks.auditId),
        eq(auditPages.url, auditLinks.targetUrl),
      ),
    )
    .where(
      and(eq(auditLinks.auditId, auditId), eq(auditLinks.isInternal, true)),
    )
    .groupBy(auditLinks.targetUrl);

  return rows.map((row) => ({
    targetUrl: row.targetUrl,
    inboundLinks: Number(row.inboundLinks ?? 0),
    inboundSources: Number(row.inboundSources ?? 0),
    allInboundLinks: Number(row.allInboundLinks ?? 0),
    allInboundSources: Number(row.allInboundSources ?? 0),
    distinctAnchors: Number(row.distinctAnchors ?? 0),
    emptyAnchors: Number(row.emptyAnchors ?? 0),
    sampleAnchor: row.sampleAnchor ?? null,
  }));
}

export async function getBrokenLinkEdges(
  auditId: string,
): Promise<BrokenLinkEdge[]> {
  const rows = await db
    .select({
      sourcePageId: auditLinks.sourcePageId,
      sourceUrl: auditLinks.sourceUrl,
      targetUrl: auditLinks.targetUrl,
      targetStatus: auditPages.statusCode,
    })
    .from(auditLinks)
    .innerJoin(
      auditPages,
      and(
        eq(auditPages.auditId, auditLinks.auditId),
        eq(auditPages.url, auditLinks.targetUrl),
      ),
    )
    .where(
      and(
        eq(auditLinks.auditId, auditId),
        eq(auditLinks.isInternal, true),
        gte(auditPages.statusCode, 400),
        eq(auditPages.fetchClass, "ok"),
      ),
    )
    .limit(EDGE_QUERY_LIMIT);

  return rows;
}

export async function getNonIndexableTargetEdges(
  auditId: string,
): Promise<NonIndexableTargetEdge[]> {
  const rows = await db
    .select({
      sourcePageId: auditLinks.sourcePageId,
      sourceUrl: auditLinks.sourceUrl,
      targetUrl: auditLinks.targetUrl,
      targetIsIndexable: auditPages.isIndexable,
      targetCanonical: auditPages.canonicalUrl,
      targetHeaderCanonical: auditPages.headerCanonicalUrl,
    })
    .from(auditLinks)
    .innerJoin(
      auditPages,
      and(
        eq(auditPages.auditId, auditLinks.auditId),
        eq(auditPages.url, auditLinks.targetUrl),
      ),
    )
    .where(
      and(
        eq(auditLinks.auditId, auditId),
        eq(auditLinks.isInternal, true),
        eq(auditPages.fetchClass, "ok"),
        gte(auditPages.statusCode, 200),
        lt(auditPages.statusCode, 300),
        ne(auditPages.extractionState, "NOT_EXTRACTED"),
        or(
          eq(auditPages.isIndexable, false),
          isNotNull(auditPages.canonicalUrl),
          isNotNull(auditPages.headerCanonicalUrl),
        ),
      ),
    )
    .limit(EDGE_QUERY_LIMIT);

  const edges: NonIndexableTargetEdge[] = [];
  for (const row of rows) {
    const canonical = row.targetCanonical ?? row.targetHeaderCanonical;
    const reason = !row.targetIsIndexable
      ? ("noindex" as const)
      : canonical && canonical !== row.targetUrl
        ? ("canonicalized" as const)
        : null;
    if (!reason) continue;
    edges.push({
      sourcePageId: row.sourcePageId,
      sourceUrl: row.sourceUrl,
      targetUrl: row.targetUrl,
      reason,
      canonicalUrl: canonical,
    });
  }
  return edges;
}

export async function getInboundEdgesForTargets(
  auditId: string,
  targetUrls: string[],
): Promise<InboundEdge[]> {
  const unique = Array.from(new Set(targetUrls)).slice(0, 200);
  const edges: InboundEdge[] = [];

  for (let i = 0; i < unique.length; i += INBOUND_TARGET_CHUNK) {
    const chunk = unique.slice(i, i + INBOUND_TARGET_CHUNK);
    const rows = await db
      .select({
        targetUrl: auditLinks.targetUrl,
        sourcePageId: auditLinks.sourcePageId,
        sourceUrl: auditLinks.sourceUrl,
        anchor: auditLinks.anchor,
      })
      .from(auditLinks)
      .innerJoin(
        auditPages,
        and(
          eq(auditPages.auditId, auditLinks.auditId),
          eq(auditPages.url, auditLinks.targetUrl),
        ),
      )
      .where(
        and(
          eq(auditLinks.auditId, auditId),
          eq(auditLinks.isInternal, true),
          eq(auditLinks.isNofollow, false),
          ne(auditLinks.sourcePageId, auditPages.id),
          inArray(auditLinks.targetUrl, chunk),
        ),
      )
      .limit(EDGE_QUERY_LIMIT - edges.length);

    edges.push(...rows);
    if (edges.length >= EDGE_QUERY_LIMIT) break;
  }

  return edges;
}
