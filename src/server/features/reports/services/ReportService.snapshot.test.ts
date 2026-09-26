import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase<any> | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }, schema] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
    import("@/db/schema"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  // Relational schema included: AuditRepository reads via db.query.
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

import { db } from "@/db";
import {
  ga4DailyEvents,
  ga4SyncCoverage,
  gscConnections,
} from "@/db/schema";
import { InsightRepository } from "@/server/features/intelligence/repositories/InsightRepository";
import { OpportunityRepository } from "@/server/features/intelligence/repositories/OpportunityRepository";
import {
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import {
  seedBacklinksFresh,
  seedGa4Summary,
  seedSummaryFacts,
} from "@/server/features/intelligence/detectors/detectorTestSeeds";
import { captureServerEvent } from "@/server/lib/posthog";
import { addDays } from "@/server/features/intelligence/detectors/detectorTestSeeds";
import { ReportService } from "./ReportService";

function sourceState(): DetectionSourceState {
  return {
    versions: { gsc: null, ga4: null, rank: null, audit: null, backlinks: null },
    sourceSet: [],
    detectorVersions: {},
    thresholdVersion: 2,
    activeMutations: {
      gsc: { isMutating: false, activeRunIds: [] },
      ga4: { isMutating: false, activeRunIds: [] },
      rank: { isMutating: false, activeRunIds: [] },
      audit: { isMutating: false, activeRunIds: [] },
      backlinks: { isMutating: false, activeRunIds: [] },
    },
  };
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

const PERIOD = { from: "2026-01-01", to: "2026-01-14" };

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (typeof journal !== "object" || journal === null || !("entries" in journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of (journal as { entries: Array<{ tag: string }> }).entries) {
    for (const statement of migrationStatements(`drizzle/${entry.tag}.sql`)) {
      await database.client.execute(statement);
    }
  }
  await database.client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL
     )`,
  );
});

const TABLES = [
  "reports",
  "intelligence_run_detectors",
  "intelligence_runs",
  "dashboard_insights",
  "insight_user_preferences",
  "opportunity_events",
  "opportunities",
  "gsc_search_performance",
  "gsc_search_performance_syncs",
  "gsc_connections",
  "ga4_daily_summary",
  "ga4_daily_events",
  "ga4_sync_coverage",
  "ga4_connections",
  "backlink_snapshots",
  "projects",
  "organization",
];

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  for (const table of TABLES) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    `INSERT INTO organization (id, name, slug, created_at)
     VALUES ('org-1', 'Org', 'org', 0)`,
  );
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
  vi.restoreAllMocks();
  vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
    sourceState(),
  );
});

async function seedSources() {
  await db.insert(gscConnections).values({
    id: "gsc-conn-1",
    projectId: "project-1",
    organizationId: "org-1",
    siteUrl: "sc-domain:example.com",
    connectedByUserId: "user-1",
  });
  await seedSummaryFacts();
  await seedGa4Summary();
  await seedBacklinksFresh();
}

async function seedInsight(key: string, severity = "high") {
  return InsightRepository.insertRow({
    id: `ins-${key}`,
    projectId: "project-1",
    organizationId: "org-1",
    insightKey: `dashboard:${key}`,
    type: key,
    detectorKey: key,
    severity,
    title: `Title ${key}`,
    explanationFact: "Observed during the same period.",
    evidenceSummary: "Observed during the same period.",
    contentHash: "h",
    scanId: "run-1",
    detectedAt: "2026-01-10T00:00:00.000Z",
    lastSeenAt: "2026-01-10T00:00:00.000Z",
  });
}

async function seedOpportunity(
  key: string,
  status: "open" | "in_progress" | "completed",
  priority = "High",
  completedAt: string | null = null,
) {
  await OpportunityRepository.insertIgnoreConflict({
    id: `opp-${key}`,
    projectId: "project-1",
    organizationId: "org-1",
    logicalKey: `ranking_drop:${key}`,
    type: "ranking",
    detectorKey: "ranking_drop",
    detectorVersion: 1,
    scoreVersion: 1,
    status,
    impactScore: 80,
    confidenceScore: 70,
    priority,
    title: `Title ${key}`,
    explanationFact: "Observed during the same period.",
    recommendation: "Act soon.",
    evidenceJson: "{}",
    firstDetectedAt: "2026-01-05T00:00:00.000Z",
    lastDetectedAt: "2026-01-10T00:00:00.000Z",
    completedAt,
  });
}

describe("metric aggregates", () => {
  it("freezes stored GSC/GA4/backlink numbers and marks gaps unavailable", async () => {
    await seedSources();
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: "example.com",
      type: "overview",
      period: PERIOD,
    });
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    const payload = found!.payload;
    expect(payload.searchVisibility.totals).toMatchObject({
      clicks: 1120,
      impressions: 14000,
      ctr: 0.08,
      position: 5,
    });
    expect(payload.traffic.totals).toMatchObject({ sessions: 1120 });
    // No events grain synced: conversions stay unavailable, never zero.
    expect(payload.conversions.status).toMatchObject({
      available: false,
      reason: "no_coverage",
    });
    expect(payload.backlinks).toMatchObject({
      status: { available: true, reason: null },
      referringDomains: 120,
    });
    expect(payload.rankings.status.reason).toBe("no_data");
    expect(payload.technical.status.reason).toBe("no_data");
  });

  it("reports key events once the events grain is covered", async () => {
    await seedSources();
    const rows = [];
    for (let i = 0; i < 14; i += 1) {
      const date = addDays("2026-01-01", i);
      rows.push({
        id: `cov-events-${date}`,
        projectId: "project-1",
        propertyId: "properties/123",
        date,
        grain: "events",
        status: "success_with_data",
      });
      await db.insert(ga4DailyEvents).values({
        id: `evt-${date}`,
        projectId: "project-1",
        propertyId: "properties/123",
        date,
        eventName: "purchase",
        eventCount: 5,
        isKeyEvent: true,
      });
    }
    await db.insert(ga4SyncCoverage).values(rows);
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: PERIOD,
    });
    const found = await ReportService.getReport({
      id: row.id,
      projectId: "project-1",
    });
    expect(found!.payload.conversions).toMatchObject({
      status: { available: true, reason: null },
      keyEvents: 70,
    });
  });

  it("marks unconnected sources without zeros", async () => {
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: PERIOD,
    });
    const payload = (
      await ReportService.getReport({ id: row.id, projectId: "project-1" })
    )!.payload;
    expect(payload.searchVisibility.status.reason).toBe("not_connected");
    expect(payload.searchVisibility.totals).toBeNull();
    expect(payload.traffic.status.reason).toBe("not_connected");
  });
});

describe("intelligence copies", () => {
  it("freezes insight and opportunity copies with caps and order", async () => {
    await seedInsight("ranking_drop", "critical");
    await seedInsight("low_ctr_query", "info");
    await seedOpportunity("active-critical", "open", "Critical");
    await seedOpportunity("active-medium", "in_progress", "Medium");
    for (let i = 0; i < 21; i += 1) {
      await seedOpportunity(
        `done-${i}`,
        "completed",
        "Low",
        `2026-01-${String(i + 1).padStart(2, "0")}T00:00:00.000Z`,
      );
    }
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: PERIOD,
    });
    const payload = (
      await ReportService.getReport({ id: row.id, projectId: "project-1" })
    )!.payload;
    expect(payload.insights.map((insight) => insight.insightKey)).toEqual([
      "dashboard:ranking_drop",
      "dashboard:low_ctr_query",
    ]);
    const opportunities = payload.opportunities;
    expect(opportunities).toHaveLength(22);
    expect(opportunities[0]?.logicalKey).toBe("ranking_drop:active-critical");
    expect(opportunities[1]?.logicalKey).toBe("ranking_drop:active-medium");
    const completed = opportunities.filter(
      (opportunity) => opportunity.status === "completed",
    );
    expect(completed).toHaveLength(20);
    expect(
      completed.some(
        (opportunity) => opportunity.logicalKey === "ranking_drop:done-0",
      ),
    ).toBe(false);
  });

  it("keeps snapshots immutable under later mutations", async () => {
    await seedInsight("ranking_drop");
    await seedOpportunity("active-critical", "open", "Critical");
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: PERIOD,
    });
    const before = (
      await ReportService.getReport({ id: row.id, projectId: "project-1" })
    )!.payload;
    await seedInsight("backlink_change", "medium");
    await seedOpportunity("late", "open", "High");
    const after = (
      await ReportService.getReport({ id: row.id, projectId: "project-1" })
    )!.payload;
    expect(after).toEqual(before);
  });

  it("emits the generate telemetry event", async () => {
    const row = await ReportService.generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: PERIOD,
    });
    expect(captureServerEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event: "report:generate",
        properties: expect.objectContaining({
          project_id: "project-1",
          report_id: row.id,
          report_type: "overview",
          consistency_status: "consistent",
        }),
      }),
    );
  });
});
