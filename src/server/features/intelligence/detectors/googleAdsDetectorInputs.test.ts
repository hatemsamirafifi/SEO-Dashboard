/* eslint-disable max-lines */
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

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

const routeMock = vi.hoisted(() => vi.fn(async () => ({})));

vi.mock("@/server/lib/seo-data", async (importOriginal) => ({
  ...(await importOriginal<typeof SeoDataModule>()),
  getSeoDataRouter: () => ({ route: routeMock }),
}));

import { db } from "@/db";
import {
  audits,
  ga4Connections,
  ga4DailyLandingPages,
  ga4SyncCoverage,
  gscSearchPerformance,
  googleAdsAccounts,
  googleAdsConnections,
  googleAdsAnalyticsUnits,
  googleAdsDailyLandingPage,
  googleAdsDailySearchTerm,
} from "@/db/schema";
import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import { fetchDetectorInput } from "./inputs";
import { InsufficientCoverageError, type DetectorContext } from "./types";
import { addDays, seedAudit } from "./detectorTestSeeds";
import type * as SeoDataModule from "@/server/lib/seo-data";

const CUSTOMER = "1234567890";

function inputUnitIds(input: unknown): string[] {
  const value: unknown =
    input !== null && typeof input === "object"
      ? Reflect.get(input, "googleAdsUnitIds")
      : undefined;
  return Array.isArray(value) ? value.map(String) : [];
}
const GENERATION = "gen-1";
const SOURCE_FETCHED_AT = "2026-01-15T00:00:00.000Z";
const WINDOW_START = "2025-12-18";
const ANCHOR = "2026-01-14";
const WINDOW_DATES = Array.from({ length: 28 }, (_, i) =>
  addDays(WINDOW_START, i),
);

function ctxFor(detectorKey: string): DetectorContext {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    periodFrom: "",
    periodTo: "",
    thresholds: defaultThresholdsFor(detectorKey),
    thresholdVersion: 5,
  };
}

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

const TABLES = [
  "google_ads_daily_search_term",
  "google_ads_daily_landing_page",
  "google_ads_analytics_units",
  "google_ads_accounts",
  "google_ads_connections",
  "google_ads_sync_runs",
  "ga4_daily_landing_pages",
  "ga4_sync_coverage",
  "ga4_connections",
  "gsc_search_performance",
  "audit_issues",
  "audits",
  "projects",
  "organization",
];

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
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
  vi.restoreAllMocks();
  for (const table of TABLES) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    `INSERT INTO projects (id, organization_id, name)
     VALUES ('project-1', 'org-1', 'Test')`,
  );
});

async function seedAdsConnection() {
  await db.insert(googleAdsConnections).values({
    id: "ads-conn-1",
    projectId: "project-1",
    organizationId: "org-1",
    customerId: CUSTOMER,
    grantAccountId: "grant-1",
    connectedByUserId: "user-1",
  });
  await db.insert(googleAdsAccounts).values({
    id: "ads-acc-1",
    projectId: "project-1",
    organizationId: "org-1",
    customerId: CUSTOMER,
    descriptiveName: "Ads account",
    currencyCode: "EUR",
    timeZone: "Europe/Berlin",
    isTestAccount: false,
    sourceFetchedAt: SOURCE_FETCHED_AT,
  });
}

type UnitSeedRow = typeof googleAdsAnalyticsUnits.$inferInsert;

async function publishUnits(
  grain: string,
  dates: readonly string[],
  overrides: Partial<Omit<UnitSeedRow, "id">> = {},
) {
  await db.insert(googleAdsAnalyticsUnits).values(
    dates.map<UnitSeedRow>((date) => ({
      id: `unit-${grain}-${date}`,
      projectId: "project-1",
      organizationId: "org-1",
      customerId: CUSTOMER,
      date,
      grain,
      publishedGenerationId: GENERATION,
      status: "success_with_data",
      rowCount: 1,
      sourceFetchedAt: SOURCE_FETCHED_AT,
      currencyCode: "EUR",
      metricDateBasis: "interaction_date",
      publishedAt: SOURCE_FETCHED_AT,
      ...overrides,
    })),
  );
}

async function seedSearchTermWindows(
  dates: readonly string[],
  terms: Array<{
    text: string;
    costMicros: number;
    conversions?: number | null;
  }>,
) {
  const rows: Array<typeof googleAdsDailySearchTerm.$inferInsert> = [];
  for (const date of dates) {
    for (const term of terms) {
      rows.push({
        id: `st-${term.text}-${date}`,
        projectId: "project-1",
        customerId: CUSTOMER,
        date,
        generationId: GENERATION,
        campaignResourceId: `customers/${CUSTOMER}/campaigns/1`,
        adGroupResourceId: `customers/${CUSTOMER}/campaigns/1/adgroups/1`,
        searchText: term.text,
        impressions: 10,
        clicks: 3,
        costMicros: term.costMicros,
        conversions: term.conversions ?? null,
      });
    }
  }
  for (let i = 0; i < rows.length; i += 30) {
    await db.insert(googleAdsDailySearchTerm).values(rows.slice(i, i + 30));
  }
}

async function seedGscQueryFacts(
  queries: Array<{
    query: string;
    date: string;
    impressions: number;
    position: number;
  }>,
) {
  await db.insert(gscSearchPerformance).values(
    queries.map((entry, i) => ({
      id: `gsc-q-${i}-${entry.date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date: entry.date,
      grain: "query",
      grainKey: entry.query.toLowerCase(),
      query: entry.query,
      clicks: 0,
      impressions: entry.impressions,
      ctr: 0,
      position: entry.position,
    })),
  );
}

describe("paid_organic_query_gap fetch (google ads stored evidence)", () => {
  it("throws without GSC query facts (cheap gate first)", async () => {
    await seedAdsConnection();
    await expect(
      fetchDetectorInput(
        "paid_organic_query_gap",
        "project-1",
        ctxFor("paid_organic_query_gap"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws without an Ads connection", async () => {
    await seedGscQueryFacts([
      { query: "erp software", date: ANCHOR, impressions: 500, position: 15 },
    ]);
    await expect(
      fetchDetectorInput(
        "paid_organic_query_gap",
        "project-1",
        ctxFor("paid_organic_query_gap"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws when no succeeded search-term units exist", async () => {
    await seedAdsConnection();
    await seedGscQueryFacts([
      { query: "erp software", date: ANCHOR, impressions: 500, position: 15 },
    ]);
    await expect(
      fetchDetectorInput(
        "paid_organic_query_gap",
        "project-1",
        ctxFor("paid_organic_query_gap"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws when covered days fall below the ratio threshold", async () => {
    await seedAdsConnection();
    await seedGscQueryFacts([
      { query: "erp software", date: ANCHOR, impressions: 500, position: 15 },
    ]);
    await publishUnits("search_term", WINDOW_DATES.slice(0, 10));
    await seedSearchTermWindows(WINDOW_DATES.slice(0, 10), [
      { text: "erp software", costMicros: 100_000, conversions: 0.5 },
    ]);
    await expect(
      fetchDetectorInput(
        "paid_organic_query_gap",
        "project-1",
        ctxFor("paid_organic_query_gap"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("emits weak-organic paid terms and keeps strong organic out", async () => {
    await seedAdsConnection();
    await seedGscQueryFacts([
      { query: "erp software", date: ANCHOR, impressions: 50, position: 15 },
      {
        query: "Best Running Shoes",
        date: ANCHOR,
        impressions: 300,
        position: 8.5,
      },
    ]);
    await publishUnits("search_term", WINDOW_DATES);
    await seedSearchTermWindows(WINDOW_DATES, [
      { text: "erp software", costMicros: 100_000, conversions: 0.5 },
      { text: "Best Running Shoes", costMicros: 100_000, conversions: 0.5 },
    ]);
    const input: unknown = await fetchDetectorInput(
      "paid_organic_query_gap",
      "project-1",
      ctxFor("paid_organic_query_gap"),
    );
    expect(input).toMatchObject({
      periodFrom: WINDOW_START,
      periodTo: ANCHOR,
      currencyCode: "EUR",
      metricDateBasis: "interaction_date",
    });
    if (
      typeof input !== "object" ||
      input === null ||
      !("terms" in input) ||
      !Array.isArray(input.terms)
    ) {
      throw new Error("expected paid query-gap input");
    }
    // Only the weak-organic term is emitted; the strong organic
    // "best running shoes" (position 8.5, 300 impressions) stays out.
    expect(input.terms).toHaveLength(1);
    expect(input.terms[0]).toMatchObject({
      query: "erp software",
      paidCostMicros: 100_000 * WINDOW_DATES.length,
      paidClicks: 3 * WINDOW_DATES.length,
      organicImpressions: 50,
      organicAvgPosition: 15,
      hasOrganicFacts: true,
    });
    // Stored-evidence unit refs are surfaced for the full window.
    const refs = inputUnitIds(input).join(",");
    expect(refs).toContain(`${CUSTOMER}:${ANCHOR}:search_term`);
    expect(refs).not.toContain(":keyword");
  });
});

describe("paid_landing_page_technical_issue fetch (google ads stored evidence)", () => {
  it("throws without a completed audit", async () => {
    await seedAdsConnection();
    await db.insert(audits).values({
      id: "audit-running",
      projectId: "project-1",
      startedByUserId: "user-1",
      startUrl: "https://example.com/",
      status: "running",
      startedAt: "2026-01-05T00:00:00.000Z",
    });
    await expect(
      fetchDetectorInput(
        "paid_landing_page_technical_issue",
        "project-1",
        ctxFor("paid_landing_page_technical_issue"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("anchors on the ads window and pairs audit issues with paid pages", async () => {
    await seedAudit();
    await seedAdsConnection();
    await publishUnits("landing_page", WINDOW_DATES);
    const rows: Array<typeof googleAdsDailyLandingPage.$inferInsert> = [];
    for (const date of WINDOW_DATES) {
      rows.push({
        id: `lp-pricing-${date}`,
        projectId: "project-1",
        customerId: CUSTOMER,
        date,
        generationId: GENERATION,
        campaignResourceId: `customers/${CUSTOMER}/campaigns/1`,
        landingPageUrl: "https://example.com/pricing",
        impressions: 100,
        clicks: 2,
        costMicros: 150_000,
      });
    }
    for (let i = 0; i < rows.length; i += 30) {
      await db.insert(googleAdsDailyLandingPage).values(rows.slice(i, i + 30));
    }
    const input: unknown = await fetchDetectorInput(
      "paid_landing_page_technical_issue",
      "project-1",
      ctxFor("paid_landing_page_technical_issue"),
    );
    expect(input).toMatchObject({
      periodFrom: WINDOW_START,
      periodTo: ANCHOR,
      auditId: "audit-1",
      currencyCode: "EUR",
      metricDateBasis: "interaction_date",
    });
    if (
      typeof input !== "object" ||
      input === null ||
      !("pages" in input) ||
      !Array.isArray(input.pages)
    ) {
      throw new Error("expected paid landing-page input");
    }
    expect(input.pages).toHaveLength(1);
    expect(input.pages[0]).toMatchObject({
      issueType: "missing_title",
      page: "https://example.com/pricing",
      paidCostMicros: 150_000 * WINDOW_DATES.length,
      paidClicks: 2 * WINDOW_DATES.length,
      auditIssuePresent: true,
      ga4EngagementRate: null,
      ga4Weak: false,
    });
    const refs = inputUnitIds(input).join(",");
    expect(refs).toContain(`${CUSTOMER}:${ANCHOR}:landing_page`);
  });

  it("emits weak_engagement with a covered GA4 witness", async () => {
    await seedAudit();
    await seedAdsConnection();
    await db.insert(ga4Connections).values({
      id: "ga4-conn-1",
      projectId: "project-1",
      organizationId: "org-1",
      propertyId: "properties/123",
      propertyDisplayName: "Test property",
      connectedByUserId: "user-1",
      ga4AccountId: "accounts/1",
    });
    await publishUnits("landing_page", WINDOW_DATES);
    const adsRows: Array<typeof googleAdsDailyLandingPage.$inferInsert> = [];
    const ga4Rows: Array<typeof ga4DailyLandingPages.$inferInsert> = [];
    const coverage: Array<typeof ga4SyncCoverage.$inferInsert> = [];
    for (const date of WINDOW_DATES) {
      adsRows.push({
        id: `lp-guide-${date}`,
        projectId: "project-1",
        customerId: CUSTOMER,
        date,
        generationId: GENERATION,
        campaignResourceId: `customers/${CUSTOMER}/campaigns/1`,
        landingPageUrl: "https://example.com/landing",
        impressions: 80,
        clicks: 2,
        costMicros: 60_000,
      });
      ga4Rows.push({
        id: `ga4lp-${date}`,
        projectId: "project-1",
        propertyId: "properties/123",
        date,
        landingPage: "https://example.com/landing",
        sessions: 10,
        engagedSessions: 2,
      });
      coverage.push({
        id: `cov-${date}`,
        projectId: "project-1",
        propertyId: "properties/123",
        date,
        grain: "landing_pages",
        status: "success_with_data",
      });
    }
    for (let i = 0; i < adsRows.length; i += 30) {
      await db
        .insert(googleAdsDailyLandingPage)
        .values(adsRows.slice(i, i + 30));
    }
    for (let i = 0; i < ga4Rows.length; i += 30) {
      await db.insert(ga4DailyLandingPages).values(ga4Rows.slice(i, i + 30));
    }
    for (let i = 0; i < coverage.length; i += 30) {
      await db.insert(ga4SyncCoverage).values(coverage.slice(i, i + 30));
    }
    const input: unknown = await fetchDetectorInput(
      "paid_landing_page_technical_issue",
      "project-1",
      ctxFor("paid_landing_page_technical_issue"),
    );
    if (
      typeof input !== "object" ||
      input === null ||
      !("pages" in input) ||
      !Array.isArray(input.pages)
    ) {
      throw new Error("expected paid landing-page input");
    }
    expect(input.pages).toHaveLength(1);
    expect(input.pages[0]).toMatchObject({
      issueType: "weak_engagement",
      page: "https://example.com/landing",
      auditIssuePresent: false,
      ga4EngagementRate: 0.2,
      ga4Weak: true,
    });
  });

  it("keeps low-spend pages out of the pairings", async () => {
    await seedAudit();
    await seedAdsConnection();
    await publishUnits("landing_page", WINDOW_DATES.slice(0, 25));
    const rows: Array<typeof googleAdsDailyLandingPage.$inferInsert> = [];
    for (const date of WINDOW_DATES.slice(0, 25)) {
      rows.push({
        id: `lp-low-${date}`,
        projectId: "project-1",
        customerId: CUSTOMER,
        date,
        generationId: GENERATION,
        campaignResourceId: `customers/${CUSTOMER}/campaigns/1`,
        landingPageUrl: "https://example.com/pricing",
        impressions: 5,
        clicks: 0,
        costMicros: 1_000,
      });
    }
    for (let i = 0; i < rows.length; i += 30) {
      await db.insert(googleAdsDailyLandingPage).values(rows.slice(i, i + 30));
    }
    const input: unknown = await fetchDetectorInput(
      "paid_landing_page_technical_issue",
      "project-1",
      ctxFor("paid_landing_page_technical_issue"),
    );
    if (
      typeof input !== "object" ||
      input === null ||
      !("pages" in input) ||
      !Array.isArray(input.pages)
    ) {
      throw new Error("expected paid landing-page input");
    }
    expect(input.pages).toHaveLength(0);
  });
});
