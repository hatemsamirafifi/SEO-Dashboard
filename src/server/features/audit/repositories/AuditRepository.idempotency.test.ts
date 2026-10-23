/**
 * Resume-after-step-restart idempotency: a crawl-batch step that replays
 * (same deterministic ids) must not duplicate pages, links, or issues.
 */
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CrawledPageResult,
  DetectedIssue,
} from "@/server/lib/audit/types";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client, { schema });
  return { db: database.db };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const statement of build(database.db)) await statement;
  },
  executeInBatches: async (
    items: unknown[],
    buildStatement: (tx: unknown, item: unknown) => Promise<unknown>,
  ) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const item of items) await buildStatement(database.db, item);
  },
}));

import { db } from "@/db";
import {
  auditIssues,
  auditLinks,
  auditPages,
  audits,
  organization,
  projects,
} from "@/db/schema";
import { AuditRepository } from "@/server/features/audit/repositories/AuditRepository";

function isMigrationJournal(value: unknown): value is {
  entries: Array<{ tag: string }>;
} {
  if (typeof value !== "object" || value === null) return false;
  if (!("entries" in value)) return false;
  const entries: unknown = value.entries;
  return (
    Array.isArray(entries) &&
    entries.every(
      (entry: unknown) =>
        typeof entry === "object" &&
        entry !== null &&
        "tag" in entry &&
        typeof entry.tag === "string",
    )
  );
}

function migrationStatements(file: string): string[] {
  const withoutBlocks = readFileSync(
    resolve(process.cwd(), file),
    "utf8",
  ).replace(/\/\*[\s\S]*?\*\//g, "");
  return withoutBlocks
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
    .filter(Boolean);
}

function crawledPage(over: Partial<CrawledPageResult> = {}): CrawledPageResult {
  return {
    id: "page-1",
    url: "https://example.com/one",
    statusCode: 200,
    fetchClass: "ok",
    extractionState: "STATIC_COMPLETE",
    failureReason: null,
    retryAfter: null,
    redirectUrl: null,
    title: "Page",
    metaDescription: "",
    canonicalUrl: null,
    robotsMeta: null,
    xRobotsTag: null,
    headerCanonicalUrl: null,
    ogTitle: null,
    ogDescription: null,
    ogImage: null,
    h1Count: 1,
    h1Text: null,
    h2Count: 0,
    h3Count: 0,
    h4Count: 0,
    h5Count: 0,
    h6Count: 0,
    headingOrder: [1],
    wordCount: 40,
    contentHash: null,
    htmlBytes: 1024,
    isHtml: true,
    imagesTotal: 0,
    imagesMissingAlt: 0,
    images: [],
    links: [
      {
        targetUrl: "https://example.com/two",
        anchor: "Two",
        isInternal: true,
        isNofollow: false,
      },
    ],
    hasStructuredData: false,
    structuredDataJson: null,
    hreflangTags: [],
    isIndexable: true,
    responseTimeMs: 12,
    platform: null,
    platformConfidence: 0,
    pageType: null,
    pageTypeConfidence: null,
    sallaExtractionJson: null,
    crawlDepth: 0,
    inSitemap: false,
    ...over,
  };
}

const issue: DetectedIssue = {
  issueType: "missing-title",
  pageId: "page-1",
  pageUrl: "https://example.com/one",
};

describe("insertCrawledBatch idempotency", () => {
  beforeAll(async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    const journal: unknown = JSON.parse(
      readFileSync(
        resolve(process.cwd(), "drizzle/meta/_journal.json"),
        "utf8",
      ),
    );
    if (!isMigrationJournal(journal)) {
      throw new Error("drizzle journal has an unexpected shape");
    }
    for (const entry of journal.entries) {
      for (const statement of migrationStatements(`drizzle/${entry.tag}.sql`)) {
        await database.client.execute(statement);
      }
    }
  });

  beforeEach(async () => {
    if (!database.client) throw new Error("Test database was not initialized");
    await database.client.execute("DELETE FROM audit_issues");
    await database.client.execute("DELETE FROM audit_links");
    await database.client.execute("DELETE FROM audit_pages");
    await database.client.execute("DELETE FROM audits");
    await database.client.execute("DELETE FROM projects");
    await database.client.execute("DELETE FROM organization");
    await db.insert(organization).values({
      id: "organization-1",
      name: "Org",
      slug: "org",
      createdAt: new Date(),
    });
    await db.insert(projects).values({
      id: "project-1",
      organizationId: "organization-1",
      name: "Project",
    });
    await db.insert(audits).values({
      id: "audit-1",
      projectId: "project-1",
      startedByUserId: "user-1",
      startUrl: "https://example.com/",
      status: "running",
      config: "{}",
    });
  });

  it("writes one page, one link and one issue when the batch replays", async () => {
    const page = crawledPage();

    await AuditRepository.insertCrawledBatch("audit-1", [page], [issue]);
    // Same deterministic ids: this is what a step retry after a restart
    // looks like.
    await AuditRepository.insertCrawledBatch("audit-1", [page], [issue]);

    const pages = await db.select().from(auditPages);
    const links = await db.select().from(auditLinks);
    const issues = await db.select().from(auditIssues);

    expect(pages).toHaveLength(1);
    expect(links).toHaveLength(1);
    expect(issues).toHaveLength(1);
  });

  it("lets the last attempt win for a re-fetched page", async () => {
    await AuditRepository.insertCrawledBatch(
      "audit-1",
      [crawledPage({ title: "First" })],
      [],
    );
    await AuditRepository.insertCrawledBatch(
      "audit-1",
      [crawledPage({ title: "Second" })],
      [],
    );

    const pages = await db.select().from(auditPages);
    expect(pages).toHaveLength(1);
    expect(pages[0]?.title).toBe("Second");
  });
});
