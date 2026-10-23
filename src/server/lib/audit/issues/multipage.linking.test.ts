import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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

import { db } from "@/db";
import {
  auditLinks,
  auditPages,
  audits,
  organization,
  projects,
} from "@/db/schema";
import { runMultipageChecks } from "@/server/lib/audit/issues/multipage";

function isMigrationJournal(
  value: unknown,
): value is { entries: Array<{ tag: string }> } {
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

function page(input: {
  id: string;
  url: string;
  statusCode?: number;
  isIndexable?: boolean;
  canonicalUrl?: string | null;
  crawlDepth?: number | null;
  inSitemap?: boolean;
  title?: string | null;
  h1Text?: string | null;
}) {
  return {
    id: input.id,
    auditId: "audit-1",
    url: input.url,
    statusCode: input.statusCode ?? 200,
    fetchClass: "ok" as const,
    extractionState: "STATIC_COMPLETE" as const,
    title: input.title ?? null,
    h1Text: input.h1Text ?? null,
    isIndexable: input.isIndexable ?? true,
    canonicalUrl: input.canonicalUrl ?? null,
    headerCanonicalUrl: null,
    crawlDepth: input.crawlDepth ?? 2,
    inSitemap: input.inSitemap ?? true,
  };
}

function link(input: {
  id: string;
  sourcePageId: string;
  sourceUrl: string;
  targetUrl: string;
  anchor?: string | null;
}) {
  return {
    id: input.id,
    auditId: "audit-1",
    sourcePageId: input.sourcePageId,
    sourceUrl: input.sourceUrl,
    targetUrl: input.targetUrl,
    anchor: input.anchor ?? null,
    isInternal: true,
    isNofollow: false,
  };
}

describe("runMultipageChecks internal linking findings", () => {
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
      status: "completed",
      config: "{}",
    });

    await db.insert(auditPages).values([
      page({
        id: "start",
        url: "https://example.com/",
        crawlDepth: 0,
        title: "Home",
      }),
      page({
        id: "guide",
        url: "https://example.com/guide",
        crawlDepth: 1,
        title: "Widget guide",
        h1Text: "Widget guide",
      }),
      page({
        id: "underlinked",
        url: "https://example.com/products/orphan-widget",
        crawlDepth: 3,
        title: "Orphan widget",
      }),
      page({ id: "orphan", url: "https://example.com/orphan" }),
      page({
        id: "noindex",
        url: "https://example.com/account/orders",
        isIndexable: false,
      }),
      page({
        id: "canonicalized",
        url: "https://example.com/old",
        canonicalUrl: "https://example.com/new",
      }),
      page({
        id: "broken",
        url: "https://example.com/missing",
        statusCode: 404,
      }),
      page({
        id: "deep",
        url: "https://example.com/deep",
        crawlDepth: 5,
        inSitemap: false,
      }),
      page({ id: "anchor", url: "https://example.com/anchor" }),
      page({ id: "a1", url: "https://example.com/a1" }),
      page({ id: "a2", url: "https://example.com/a2" }),
      page({ id: "a3", url: "https://example.com/a3" }),
    ]);

    await db.insert(auditLinks).values([
      link({
        id: "l-start-guide",
        sourcePageId: "start",
        sourceUrl: "https://example.com/",
        targetUrl: "https://example.com/guide",
      }),
      link({
        id: "l-guide-underlinked",
        sourcePageId: "guide",
        sourceUrl: "https://example.com/guide",
        targetUrl: "https://example.com/products/orphan-widget",
        anchor: "Orphan widget",
      }),
      link({
        id: "l-guide-noindex",
        sourcePageId: "guide",
        sourceUrl: "https://example.com/guide",
        targetUrl: "https://example.com/account/orders",
      }),
      link({
        id: "l-guide-canonicalized",
        sourcePageId: "guide",
        sourceUrl: "https://example.com/guide",
        targetUrl: "https://example.com/old",
      }),
      link({
        id: "l-guide-broken",
        sourcePageId: "guide",
        sourceUrl: "https://example.com/guide",
        targetUrl: "https://example.com/missing",
      }),
      link({
        id: "l-guide-deep",
        sourcePageId: "guide",
        sourceUrl: "https://example.com/guide",
        targetUrl: "https://example.com/deep",
      }),
      link({
        id: "l-a1-anchor",
        sourcePageId: "a1",
        sourceUrl: "https://example.com/a1",
        targetUrl: "https://example.com/anchor",
        anchor: "Read more",
      }),
      link({
        id: "l-a2-anchor",
        sourcePageId: "a2",
        sourceUrl: "https://example.com/a2",
        targetUrl: "https://example.com/anchor",
        anchor: "Read more",
      }),
      link({
        id: "l-a3-anchor",
        sourcePageId: "a3",
        sourceUrl: "https://example.com/a3",
        targetUrl: "https://example.com/anchor",
        anchor: "Read more",
      }),
    ]);
  });

  it("adds the new internal linking findings from persisted pages and links", async () => {
    const issues = await runMultipageChecks({
      auditId: "audit-1",
      startUrl: "https://example.com/",
      crawlCompleted: true,
    });

    const byType = (type: string) =>
      issues.filter((issue) => issue.issueType === type);

    expect(byType("orphan-page").map((issue) => issue.pageUrl)).toContain(
      "https://example.com/orphan",
    );
    expect(byType("underlinked-page").map((issue) => issue.pageUrl)).toContain(
      "https://example.com/products/orphan-widget",
    );
    expect(
      byType("broken-internal-link").map((issue) => issue.details?.targetUrl),
    ).toContain("https://example.com/missing");
    expect(
      byType("link-to-noindex-page").map((issue) => issue.details?.targetUrl),
    ).toEqual(
      expect.arrayContaining([
        "https://example.com/account/orders",
        "https://example.com/old",
      ]),
    );
    expect(
      byType("anchor-text-diversity").map((issue) => issue.pageUrl),
    ).toContain("https://example.com/anchor");
  });

  it("suppresses absence-based linking findings on a partial crawl", async () => {
    const issues = await runMultipageChecks({
      auditId: "audit-1",
      startUrl: "https://example.com/",
      crawlCompleted: false,
    });

    expect(issues.some((issue) => issue.issueType === "orphan-page")).toBe(
      false,
    );
    expect(issues.some((issue) => issue.issueType === "underlinked-page")).toBe(
      false,
    );
    expect(
      issues.some((issue) => issue.issueType === "anchor-text-diversity"),
    ).toBe(false);
    expect(
      issues.some((issue) => issue.issueType === "broken-internal-link"),
    ).toBe(true);
    expect(
      issues.some((issue) => issue.issueType === "link-to-noindex-page"),
    ).toBe(true);
  });
});
