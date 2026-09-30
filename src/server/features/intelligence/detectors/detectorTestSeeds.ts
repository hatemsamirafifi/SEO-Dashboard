import { db } from "@/db";
import {
  audits,
  auditIssues,
  backlinkSnapshots,
  ga4Connections,
  ga4DailyLandingPages,
  ga4DailySummary,
  ga4SyncCoverage,
  gscSearchPerformance,
  rankCheckRuns,
  rankSnapshots,
  rankTrackingConfigs,
} from "@/db/schema";

/**
 * Shared seeds for detector input/fetch tests (final-plan §19 fixtures).
 * Dates are fixed in January 2026 so windowed detectors anchor
 * deterministically; backlink freshness anchors at wall clock (the fetcher
 * compares snapshot age against now).
 */

export function addDays(base: string, delta: number): string {
  const ms = Date.parse(`${base}T00:00:00Z`) + delta * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

async function insertGscFacts(
  rows: Array<typeof gscSearchPerformance.$inferInsert>,
) {
  for (let i = 0; i < rows.length; i += 30) {
    await db.insert(gscSearchPerformance).values(rows.slice(i, i + 30));
  }
}

/** 14 summary days: previous week 100 clicks/day, current week 60/day. */
export async function seedSummaryFacts() {
  const rows = [];
  for (let i = 0; i < 14; i += 1) {
    const date = addDays("2026-01-01", i);
    rows.push({
      id: `sum-${date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date,
      grain: "summary",
      grainKey: "",
      clicks: i < 7 ? 100 : 60,
      impressions: 1000,
      ctr: 0.1,
      position: 5,
    });
  }
  await insertGscFacts(rows);
}

/** 56 query days (full 2×28d coverage): high impressions, sub-floor CTR. */
export async function seedQueryFacts() {
  const rows = [];
  for (let i = 0; i < 56; i += 1) {
    const date = addDays("2025-11-20", i);
    rows.push({
      id: `q-${date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date,
      grain: "query",
      grainKey: "best running shoes",
      query: "Best Running Shoes",
      clicks: i < 28 ? 3 : 1,
      impressions: 300,
      ctr: 0.005,
      position: 8.5,
    });
  }
  await insertGscFacts(rows);
}

/**
 * 84 page days for the decay guide (400/320/176 per 28d window) plus a
 * heavy current-window pricing page (top-importance witness).
 */
export async function seedPageFacts() {
  const rows = [];
  for (let i = 0; i < 84; i += 1) {
    const date = addDays("2025-10-23", i);
    const windowIndex = Math.floor(i / 28);
    const totals = [400, 320, 176][windowIndex] ?? 0;
    rows.push({
      id: `pg-guide-${date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date,
      grain: "page",
      grainKey: "https://example.com/guide",
      page: "https://example.com/guide",
      clicks: Math.round((totals / 28) * 10) / 10,
      impressions: 2000,
      ctr: 0.05,
      position: 6,
    });
  }
  for (let i = 56; i < 84; i += 1) {
    const date = addDays("2025-10-23", i);
    rows.push({
      id: `pg-pricing-${date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date,
      grain: "page",
      grainKey: "https://example.com/pricing",
      page: "https://example.com/pricing",
      clicks: 50,
      impressions: 1200,
      ctr: 0.04,
      position: 4,
    });
  }
  await insertGscFacts(rows);
}

/** 28 days, one query × two pages (cannibalization pair). */
export async function seedQueryPageFacts() {
  const rows = [];
  for (let i = 0; i < 28; i += 1) {
    const date = addDays("2025-12-18", i);
    for (const [page, id] of [
      ["https://example.com/a", `qp-a-${date}`],
      ["https://example.com/b", `qp-b-${date}`],
    ] as const) {
      rows.push({
        id,
        projectId: "project-1",
        property: "sc-domain:example.com",
        date,
        grain: "query_page",
        grainKey: `espresso::${page}`,
        query: "espresso",
        page,
        clicks: 5,
        impressions: 30,
        ctr: 0.16,
        position: 7,
      });
    }
  }
  await insertGscFacts(rows);
}

/** One config, two completed runs; kw-1 drops 8 → 15, kw-2 holds. */
export async function seedRank() {
  await db.insert(rankTrackingConfigs).values({
    id: "cfg-1",
    projectId: "project-1",
    domain: "example.com",
    serpDepth: 20,
  });
  await db.insert(rankCheckRuns).values([
    {
      id: "run-1",
      configId: "cfg-1",
      projectId: "project-1",
      status: "completed",
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: "2026-01-01T01:00:00.000Z",
    },
    {
      id: "run-2",
      configId: "cfg-1",
      projectId: "project-1",
      status: "completed",
      startedAt: "2026-01-08T00:00:00.000Z",
      completedAt: "2026-01-08T01:00:00.000Z",
    },
  ]);
  await db.insert(rankSnapshots).values([
    {
      runId: "run-1",
      trackingKeywordId: "kw-1",
      keyword: "Best Running Shoes",
      device: "desktop",
      position: 8,
      rankingStatus: "RANKED",
      url: "https://example.com/shoes",
      checkedAt: "2026-01-01T00:30:00.000Z",
    },
    {
      runId: "run-2",
      trackingKeywordId: "kw-1",
      keyword: "Best Running Shoes",
      device: "desktop",
      position: 15,
      rankingStatus: "RANKED",
      url: "https://example.com/shoes",
      checkedAt: "2026-01-08T00:30:00.000Z",
    },
    {
      runId: "run-1",
      trackingKeywordId: "kw-2",
      keyword: "Trail Socks",
      device: "desktop",
      position: 5,
      rankingStatus: "RANKED",
      url: "https://example.com/socks",
      checkedAt: "2026-01-01T00:30:00.000Z",
    },
    {
      runId: "run-2",
      trackingKeywordId: "kw-2",
      keyword: "Trail Socks",
      device: "desktop",
      position: 6,
      rankingStatus: "RANKED",
      url: "https://example.com/socks",
      checkedAt: "2026-01-08T00:30:00.000Z",
    },
  ]);
}

/** Completed audit with one critical issue on the pricing page. */
export async function seedAudit() {
  await db.insert(audits).values({
    id: "audit-1",
    projectId: "project-1",
    startedByUserId: "user-1",
    startUrl: "https://example.com/",
    status: "completed",
    startedAt: "2026-01-05T00:00:00.000Z",
    completedAt: "2026-01-05T01:00:00.000Z",
  });
  await db.insert(auditIssues).values({
    id: "issue-1",
    auditId: "audit-1",
    pageUrl: "https://example.com/pricing",
    issueType: "missing_title",
    severity: "critical",
  });
}

/** GA4 connection (idempotent — summary and landing seeds share it). */
export async function seedGa4Connection() {
  await db
    .insert(ga4Connections)
    .values({
      id: "ga4-conn-1",
      projectId: "project-1",
      organizationId: "org-1",
      propertyId: "properties/123",
      propertyDisplayName: "Test property",
      connectedByUserId: "user-1",
      ga4AccountId: "accounts/1",
    })
    .onConflictDoNothing();
}

async function seedGa4Coverage(
  propertyId: string,
  grain: string,
  from: string,
  days: number,
) {
  const rows = [];
  for (let i = 0; i < days; i += 1) {
    const date = addDays(from, i);
    rows.push({
      id: `cov-${grain}-${date}`,
      projectId: "project-1",
      propertyId,
      date,
      grain,
      status: "success_with_data",
    });
  }
  for (let i = 0; i < rows.length; i += 30) {
    await db.insert(ga4SyncCoverage).values(rows.slice(i, i + 30));
  }
}

export async function seedGa4Summary() {
  await seedGa4Connection();
  const rows = [];
  for (let i = 0; i < 14; i += 1) {
    const date = addDays("2026-01-01", i);
    rows.push({
      id: `ga4sum-${date}`,
      projectId: "project-1",
      propertyId: "properties/123",
      date,
      sessions: i < 7 ? 100 : 60,
    });
  }
  await db.insert(ga4DailySummary).values(rows);
  await seedGa4Coverage("properties/123", "summary", "2026-01-01", 14);
}

/**
 * 56 landing days for the decay guide (previous 90/d, current 50/d) and a
 * flat pricing page (importance vote). Full-URL landing rows so canonical
 * keys align with the GSC/rank witnesses (documented join divergence).
 */
export async function seedGa4Landing() {
  await seedGa4Connection();
  const rows = [];
  for (let i = 0; i < 56; i += 1) {
    const date = addDays("2025-11-20", i);
    rows.push({
      id: `ga4lp-guide-${date}`,
      projectId: "project-1",
      propertyId: "properties/123",
      date,
      landingPage: "https://example.com/guide",
      sessions: i < 28 ? 90 : 50,
    });
    rows.push({
      id: `ga4lp-pricing-${date}`,
      projectId: "project-1",
      propertyId: "properties/123",
      date,
      landingPage: "https://example.com/pricing",
      sessions: 40,
    });
  }
  for (let i = 0; i < rows.length; i += 30) {
    await db.insert(ga4DailyLandingPages).values(rows.slice(i, i + 30));
  }
  await seedGa4Coverage("properties/123", "landing_pages", "2025-11-20", 56);
}

/** Two snapshots inside the freshness window with a notable loss
 *  (lost referring domains at/above the lost_backlinks floor). */
export async function seedBacklinksLoss() {
  const now = Date.now();
  const daysAgo = (days: number) =>
    new Date(now - days * 86_400_000).toISOString();
  await db.insert(backlinkSnapshots).values([
    {
      projectId: "project-1",
      domain: "example.com",
      backlinks: 1000,
      referringDomains: 120,
      capturedAt: daysAgo(12),
    },
    {
      projectId: "project-1",
      domain: "example.com",
      backlinks: 960,
      referringDomains: 112,
      newBacklinks: 2,
      lostBacklinks: 9,
      newReferringDomains: 0,
      lostReferringDomains: 8,
      capturedAt: daysAgo(5),
    },
  ]);
}

/** Two snapshots inside the freshness window with net movement. */
export async function seedBacklinksFresh() {
  const now = Date.now();
  const daysAgo = (days: number) =>
    new Date(now - days * 86_400_000).toISOString();
  await db.insert(backlinkSnapshots).values([
    {
      projectId: "project-1",
      domain: "example.com",
      backlinks: 980,
      referringDomains: 118,
      capturedAt: daysAgo(12),
    },
    {
      projectId: "project-1",
      domain: "example.com",
      backlinks: 1000,
      referringDomains: 120,
      newBacklinks: 10,
      lostBacklinks: 4,
      newReferringDomains: 3,
      lostReferringDomains: 1,
      capturedAt: daysAgo(5),
    },
  ]);
}
