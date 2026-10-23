/**
 * Data access layer for site audit tables.
 * Provider-aware (D1 or Postgres) via the `@/db` handle. Covers audits,
 * audit_pages, audit_links, audit_issues, and stored Lighthouse results.
 * The audit row's own state machine (create, progress, cancel, finalize)
 * lives in AuditLifecycleRepository and is re-exported here.
 */
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import {
  audits,
  auditIssues,
  auditLighthouseResults,
  auditLinks,
  auditPages,
} from "@/db/schema";
import { getDatabaseProvider } from "@/db/provider";
import { executeInBatches, runBatch } from "@/db/runBatch";
import { AUDIT_ISSUE_TYPES } from "@/shared/audit-issues";
import { deterministicAuditRowId } from "@/server/lib/audit/ids";
import type { DetectedIssue } from "@/server/lib/audit/types";
import type {
  CrawledPageResult,
  LighthouseResult,
} from "@/server/lib/audit/types";
import {
  cancelAudit,
  createAudit,
  failAudit,
  finalizeAuditRun,
  getAuditCancelFlag,
  getAuditForWorkflow,
  getAuditPageCounters,
  updateAuditProgress,
} from "./AuditLifecycleRepository";

// Both internal and external link edges are stored (broken-internal-link,
// orphan checks, and cross-domain checks read them). Mega-menu/footer-heavy
// sites can carry 1000+ links per page; cap what we store so a 10k-page
// crawl can't write tens of millions of link rows.
const MAX_INTERNAL_LINKS_PER_PAGE = 500;
const MAX_EXTERNAL_LINKS_PER_PAGE = 100;
const POSTGRES_LINK_INSERT_SIZE = 500;

/**
 * Persist one crawl batch (pages + link edges + per-page issues).
 * Called inside the crawl-batch Workflow step so results land in D1
 * incrementally instead of accumulating in memory until finalize.
 *
 * Idempotent on step retry: callers assign deterministic page ids
 * (deterministicAuditRowId) and link/issue ids are derived from stable
 * content. Page rows upsert (a retried fetch may legitimately differ — last
 * attempt wins, matching what the step returns); links and issues are
 * insert-or-ignore.
 */
async function insertCrawledBatch(
  auditId: string,
  pages: CrawledPageResult[],
  issues: DetectedIssue[],
) {
  await executeInBatches(pages, (tx, page) => {
    const dataColumns = {
      url: page.url,
      statusCode: page.statusCode,
      redirectUrl: page.redirectUrl,
      title: page.title,
      metaDescription: page.metaDescription,
      canonicalUrl: page.canonicalUrl,
      robotsMeta: page.robotsMeta,
      xRobotsTag: page.xRobotsTag,
      headerCanonicalUrl: page.headerCanonicalUrl,
      ogTitle: page.ogTitle,
      ogDescription: page.ogDescription,
      ogImage: page.ogImage,
      h1Count: page.h1Count,
      h1Text: page.h1Text,
      h2Count: page.h2Count,
      h3Count: page.h3Count,
      h4Count: page.h4Count,
      h5Count: page.h5Count,
      h6Count: page.h6Count,
      headingOrderJson: JSON.stringify(page.headingOrder),
      wordCount: page.wordCount,
      contentHash: page.contentHash,
      imagesTotal: page.imagesTotal,
      imagesMissingAlt: page.imagesMissingAlt,
      imagesJson: JSON.stringify(page.images),
      internalLinkCount: page.links.filter((l) => l.isInternal).length,
      externalLinkCount: page.links.filter((l) => !l.isInternal).length,
      hasStructuredData: page.hasStructuredData,
      structuredDataJson: page.structuredDataJson,
      sallaExtractionJson: page.sallaExtractionJson,
      // Fetch/extraction diagnostics (audit-fetch-class.ts taxonomy)
      extractionState: page.extractionState,
      failureReason: page.failureReason,
      htmlBytes: page.htmlBytes,
      platform: page.platform,
      platformConfidence: page.platformConfidence,
      pageType: page.pageType,
      pageTypeConfidence: page.pageTypeConfidence,
      hreflangTagsJson: JSON.stringify(page.hreflangTags),
      isIndexable: page.isIndexable,
      fetchClass: page.fetchClass,
      crawlDepth: page.crawlDepth,
      inSitemap: page.inSitemap,
      responseTimeMs: page.responseTimeMs,
    };
    return tx
      .insert(auditPages)
      .values({ id: page.id, auditId, ...dataColumns })
      .onConflictDoUpdate({ target: auditPages.id, set: dataColumns });
  });

  const [internalRows, externalRows] = await Promise.all([
    Promise.all(
      pages.flatMap((page) =>
        page.links
          .filter((link) => link.isInternal)
          .slice(0, MAX_INTERNAL_LINKS_PER_PAGE)
          .map(async (link) => ({
            id: await deterministicAuditRowId(
              auditId,
              page.url,
              link.targetUrl,
            ),
            auditId,
            sourcePageId: page.id,
            sourceUrl: page.url,
            targetUrl: link.targetUrl,
            anchor: link.anchor,
            isInternal: link.isInternal,
            isNofollow: link.isNofollow,
          })),
      ),
    ),
    Promise.all(
      pages.flatMap((page) =>
        page.links
          .filter((link) => !link.isInternal)
          .slice(0, MAX_EXTERNAL_LINKS_PER_PAGE)
          .map(async (link) => ({
            id: await deterministicAuditRowId(
              auditId,
              page.url,
              "external",
              link.targetUrl,
            ),
            auditId,
            sourcePageId: page.id,
            sourceUrl: page.url,
            targetUrl: link.targetUrl,
            anchor: link.anchor,
            isInternal: link.isInternal,
            isNofollow: link.isNofollow,
          })),
      ),
    ),
  ]);
  const linkRows = [...internalRows, ...externalRows];
  if (getDatabaseProvider() === "postgres") {
    // A Postgres transaction executes runBatch statements sequentially. Bulk
    // values avoid thousands of Hyperdrive round trips on link-heavy pages.
    for (let i = 0; i < linkRows.length; i += POSTGRES_LINK_INSERT_SIZE) {
      await db
        .insert(auditLinks)
        .values(linkRows.slice(i, i + POSTGRES_LINK_INSERT_SIZE))
        .onConflictDoNothing();
    }
  } else {
    await executeInBatches(linkRows, (tx, row) =>
      tx.insert(auditLinks).values(row).onConflictDoNothing(),
    );
  }

  await insertIssues(auditId, issues);
}

async function insertIssues(auditId: string, issues: DetectedIssue[]) {
  const issueRows = await Promise.all(
    issues.map(async (issue) => ({
      id: await deterministicAuditRowId(
        auditId,
        issue.pageUrl,
        issue.issueType,
        issue.dedupeKey ?? "",
      ),
      auditId,
      pageId: issue.pageId,
      pageUrl: issue.pageUrl,
      issueType: issue.issueType,
      severity: AUDIT_ISSUE_TYPES[issue.issueType].severity,
      detailsJson: issue.details ? JSON.stringify(issue.details) : null,
    })),
  );
  if (issueRows.length === 0) return;

  // Multi-row INSERT statements instead of one statement per row: D1 caps
  // bound parameters at ~100 per statement (7 columns × 14 rows = 98), and a
  // finalize pass with thousands of issues would otherwise spend most of its
  // time issuing single-row inserts (Postgres gets large multi-row
  // statements to avoid thousands of Hyperdrive round trips).
  const chunkSize = getDatabaseProvider() === "postgres" ? 500 : 14;
  await runBatch((tx) => {
    const statements: Promise<unknown>[] = [];
    for (let i = 0; i < issueRows.length; i += chunkSize) {
      statements.push(
        tx
          .insert(auditIssues)
          .values(issueRows.slice(i, i + chunkSize))
          .onConflictDoNothing(),
      );
    }
    return statements;
  });
}

async function insertLighthouseResults(
  auditId: string,
  lighthouseResults: LighthouseResult[],
) {
  const rows = await Promise.all(
    lighthouseResults.map(async (result) => ({
      id: await deterministicAuditRowId(
        auditId,
        result.pageId,
        result.strategy,
      ),
      auditId,
      pageId: result.pageId,
      strategy: result.strategy,
      performanceScore: result.performanceScore,
      accessibilityScore: result.accessibilityScore,
      bestPracticesScore: result.bestPracticesScore,
      seoScore: result.seoScore,
      lcpMs: result.lcpMs,
      cls: result.cls,
      inpMs: result.inpMs,
      ttfbMs: result.ttfbMs,
      errorMessage: result.errorMessage ?? null,
      r2Key: result.r2Key ?? null,
      payloadSizeBytes: result.payloadSizeBytes ?? null,
    })),
  );
  // Upsert: a step retry can charge a second DataForSEO call whose result
  // must not be silently dropped in favor of a failed first attempt.
  await executeInBatches(rows, (tx, row) => {
    const { id: _id, auditId: _auditId, ...dataColumns } = row;
    return tx.insert(auditLighthouseResults).values(row).onConflictDoUpdate({
      target: auditLighthouseResults.id,
      set: dataColumns,
    });
  });
}

async function getAuditForProject(auditId: string, projectId: string) {
  return db.query.audits.findFirst({
    where: and(eq(audits.id, auditId), eq(audits.projectId, projectId)),
  });
}

async function getLatestAuditForProject(projectId: string) {
  return db.query.audits.findFirst({
    where: eq(audits.projectId, projectId),
    orderBy: desc(audits.startedAt),
  });
}

async function getIssuesForAudit(
  auditId: string,
  filters: { severity?: "critical" | "warning" | "info"; issueType?: string },
) {
  return db.query.auditIssues.findMany({
    where: and(
      eq(auditIssues.auditId, auditId),
      filters.severity ? eq(auditIssues.severity, filters.severity) : undefined,
      filters.issueType
        ? eq(auditIssues.issueType, filters.issueType)
        : undefined,
    ),
  });
}

async function getPagesForAudit(auditId: string) {
  return db
    .select({
      id: auditPages.id,
      url: auditPages.url,
      statusCode: auditPages.statusCode,
      fetchClass: auditPages.fetchClass,
      extractionState: auditPages.extractionState,
      failureReason: auditPages.failureReason,
      platform: auditPages.platform,
      platformConfidence: auditPages.platformConfidence,
      redirectUrl: auditPages.redirectUrl,
      title: auditPages.title,
      metaDescription: auditPages.metaDescription,
      wordCount: auditPages.wordCount,
      isIndexable: auditPages.isIndexable,
      crawlDepth: auditPages.crawlDepth,
      inSitemap: auditPages.inSitemap,
      internalLinkCount: auditPages.internalLinkCount,
      responseTimeMs: auditPages.responseTimeMs,
    })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId));
}

async function hasPagesForAudit(auditId: string): Promise<boolean> {
  const rows = await db
    .select({ id: auditPages.id })
    .from(auditPages)
    .where(eq(auditPages.auditId, auditId))
    .limit(1);
  return rows.length > 0;
}

/**
 * One page row, scoped to its audit and the audit's project. Returns null when
 * either scope check fails so callers cannot read another project's pages.
 */
async function getAuditPageForProject(input: {
  pageId: string;
  auditId: string;
  projectId: string;
}) {
  const audit = await getAuditForProject(input.auditId, input.projectId);
  if (!audit) return null;
  return (
    (await db.query.auditPages.findFirst({
      where: and(
        eq(auditPages.id, input.pageId),
        eq(auditPages.auditId, input.auditId),
      ),
    })) ?? null
  );
}

async function getAuditsByProject(projectId: string) {
  const rows = await db
    .select({ audit: audits })
    .from(audits)
    .where(eq(audits.projectId, projectId))
    .orderBy(desc(audits.startedAt));

  return rows.map(({ audit }) => audit);
}

async function getAuditUsageForUser(userId: string) {
  const rows = await db.query.audits.findMany({
    where: eq(audits.startedByUserId, userId),
    columns: {
      status: true,
      pagesTotal: true,
      lighthouseTotal: true,
    },
  });

  return {
    capacityUnits: rows.reduce(
      (total, row) => total + row.pagesTotal + row.lighthouseTotal,
      0,
    ),
    runningCount: rows.filter((row) => row.status === "running").length,
  };
}

async function getAuditResultsForProject(auditId: string, projectId: string) {
  const audit = await getAuditForProject(auditId, projectId);
  if (!audit) {
    return { audit: null, pages: [], lighthouse: [], issues: [] };
  }

  const [pages, lighthouse, issues] = await Promise.all([
    // Per-page JSON blobs (images, headings, hreflang, structured data) can
    // run to tens of MB on a 10k-page audit — reading them into one request
    // pushes the Worker past its 128 MB memory limit. Nothing consumes them
    // in the bulk results; readers load per-page details on demand.
    db.query.auditPages.findMany({
      where: eq(auditPages.auditId, auditId),
      columns: {
        imagesJson: false,
        headingOrderJson: false,
        hreflangTagsJson: false,
        structuredDataJson: false,
      },
    }),
    db.query.auditLighthouseResults.findMany({
      where: eq(auditLighthouseResults.auditId, auditId),
    }),
    db.query.auditIssues.findMany({
      where: eq(auditIssues.auditId, auditId),
    }),
  ]);

  return { audit, pages, lighthouse, issues };
}

async function getLighthouseResultById(input: {
  lighthouseResultId: string;
  projectId: string;
}) {
  const lighthouse = await db.query.auditLighthouseResults.findFirst({
    where: eq(auditLighthouseResults.id, input.lighthouseResultId),
  });

  if (!lighthouse) {
    return null;
  }

  const [parentAudit, page] = await Promise.all([
    db.query.audits.findFirst({
      where: and(
        eq(audits.id, lighthouse.auditId),
        eq(audits.projectId, input.projectId),
      ),
    }),
    db.query.auditPages.findFirst({
      where: eq(auditPages.id, lighthouse.pageId),
    }),
  ]);

  if (!parentAudit) {
    return null;
  }

  return {
    lighthouse,
    page,
    audit: parentAudit,
  };
}

async function deleteAuditForProject(auditId: string, projectId: string) {
  await db
    .delete(audits)
    .where(and(eq(audits.id, auditId), eq(audits.projectId, projectId)));
}

export const AuditRepository = {
  createAudit,
  updateAuditProgress,
  finalizeAuditRun,
  getAuditPageCounters,
  getAuditCancelFlag,
  cancelAudit,
  failAudit,
  getAuditForWorkflow,
  insertCrawledBatch,
  insertIssues,
  insertLighthouseResults,
  getAuditForProject,
  getLatestAuditForProject,
  getIssuesForAudit,
  getPagesForAudit,
  getAuditPageForProject,
  hasPagesForAudit,
  getAuditsByProject,
  getAuditUsageForUser,
  getAuditResultsForProject,
  getLighthouseResultById,
  deleteAuditForProject,
} as const;
