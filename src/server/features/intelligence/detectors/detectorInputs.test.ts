/* eslint-disable max-lines */
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  // Widened: the drizzle handle carries the relational schema (db.query).
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

const routeMock = vi.hoisted(() =>
  vi.fn<(request: SeoDataModule.SEODataRequest) => Promise<unknown>>(),
);

vi.mock("@/server/lib/seo-data", async (importOriginal) => ({
  ...(await importOriginal<typeof SeoDataModule>()),
  getSeoDataRouter: () => ({ route: routeMock }),
}));

import { db } from "@/db";
import { audits, backlinkSnapshots } from "@/db/schema";
import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import { runDetectionStage } from "../services/detectionStage";
import { fetchDetectorInput } from "./inputs";
import { listDetectors } from "./registry";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { InsufficientCoverageError } from "./types";
import type { DetectorContext } from "./types";
import type * as SeoDataModule from "@/server/lib/seo-data";
import {
  seedAudit,
  seedBacklinksFresh,
  seedGa4Landing,
  seedGa4Summary,
  seedPageFacts,
  seedQueryFacts,
  seedQueryPageFacts,
  seedRank,
  seedSummaryFacts,
} from "./detectorTestSeeds";
import { isGa4ChangeInput } from "./ga4OrganicChange";
import { isDecayInput } from "./contentDecay";
import { isLostBacklinksInput } from "./lostBacklinks";
import { isTechnicalInput } from "./technicalOnImportantPage";
import { isStrikingDistanceInput } from "./strikingDistance";

function ctxFor(detectorKey: string): DetectorContext {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    periodFrom: "",
    periodTo: "",
    thresholds: defaultThresholdsFor(detectorKey),
    thresholdVersion: 2,
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
  "intelligence_run_detectors",
  "intelligence_runs",
  "gsc_search_performance",
  "rank_snapshots",
  "rank_check_runs",
  "rank_tracking_configs",
  "audit_issues",
  "audits",
  "backlink_snapshots",
  "ga4_daily_summary",
  "ga4_daily_landing_pages",
  "ga4_sync_coverage",
  "ga4_connections",
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

describe("fetchDetectorInput dispatcher", () => {
  it("returns null for unknown keys (no-fetcher skip preserved)", async () => {
    await expect(
      fetchDetectorInput(
        "no_such_detector",
        "project-1",
        ctxFor("low_ctr_query"),
      ),
    ).resolves.toBeNull();
  });

  it("throws InsufficientCoverage for traffic with no facts", async () => {
    await expect(
      fetchDetectorInput(
        "organic_traffic_change",
        "project-1",
        ctxFor("organic_traffic_change"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws for ranking with fewer than two qualifying runs", async () => {
    await seedRank();
    await database.client?.execute(
      "DELETE FROM rank_snapshots WHERE run_id = 'run-1'",
    );
    await database.client?.execute(
      "UPDATE rank_check_runs SET status = 'failed' WHERE id = 'run-1'",
    );
    await expect(
      fetchDetectorInput("ranking_drop", "project-1", ctxFor("ranking_drop")),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws for technical without a completed audit", async () => {
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
        "technical_on_important_page",
        "project-1",
        ctxFor("technical_on_important_page"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("throws for backlinks with a single snapshot", async () => {
    await db.insert(backlinkSnapshots).values({
      projectId: "project-1",
      domain: "example.com",
      referringDomains: 118,
      capturedAt: new Date().toISOString(),
    });
    await expect(
      fetchDetectorInput(
        "backlink_change",
        "project-1",
        ctxFor("backlink_change"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  describe("lost_backlinks input (spec 008)", () => {
    async function seedLossSnapshots(lostReferringDomains: number | null) {
      const now = Date.now();
      await db.insert(backlinkSnapshots).values([
        {
          projectId: "project-1",
          domain: "example.com",
          backlinks: 1000,
          referringDomains: 120,
          capturedAt: new Date(now - 12 * 86_400_000).toISOString(),
        },
        {
          projectId: "project-1",
          domain: "example.com",
          backlinks: 990,
          referringDomains: 112,
          lostBacklinks: 3,
          lostReferringDomains,
          capturedAt: new Date(now - 5 * 86_400_000).toISOString(),
        },
      ]);
    }

    function mockLostRows(rows: Array<Record<string, unknown>>, fail = false) {
      routeMock.mockImplementation(async () => {
        if (fail) throw new Error("provider unavailable");
        return {
          dataType: "backlinks",
          provider: "dataforseo",
          data: { items: rows, totalCount: rows.length },
          fromCache: false,
          durationMs: 1,
        };
      });
    }

    it("resolves named lost domains only when the floor is met", async () => {
      await seedLossSnapshots(5);
      mockLostRows([
        { domain_from: "Gone-A.com", is_lost: true },
        { domain_from: "gone-a.com", is_lost: true },
        { domain_from: "WWW.GONE-B.COM", is_lost: true },
        { domain_from: "blog.example.com", is_lost: true },
        { domain_from: "", is_lost: true },
        { domain_from: null, is_lost: true },
      ]);
      const input: unknown = await fetchDetectorInput(
        "lost_backlinks",
        "project-1",
        ctxFor("lost_backlinks"),
      );
      if (!isLostBacklinksInput(input)) {
        throw new Error("expected lost-backlinks input");
      }
      // Case/alias folds collapse; other subdomains stay distinct.
      expect(input.lostDomains).toEqual([
        "gone-a.com",
        "gone-b.com",
        "blog.example.com",
      ]);
      expect(input.thresholds).toMatchObject({ minReferringDomains: 3 });
      // Bounded single-page paid call through the router (never N+1).
      const calls = routeMock.mock.calls.map(([request]) => request);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.dataType).toBe("backlinks");
      expect(calls[0]?.constraints).toMatchObject({
        backlinkCall: "rows",
        limit: 100,
      });
    });

    it("skips name resolution below the floor (zero paid calls)", async () => {
      await seedLossSnapshots(2);
      mockLostRows([{ domain_from: "gone-a.com", is_lost: true }]);
      const input: unknown = await fetchDetectorInput(
        "lost_backlinks",
        "project-1",
        ctxFor("lost_backlinks"),
      );
      if (!isLostBacklinksInput(input)) {
        throw new Error("expected lost-backlinks input");
      }
      expect(input.lostDomains).toEqual([]);
      expect(routeMock).not.toHaveBeenCalled();
    });

    it("throws for lost-backlinks with a single snapshot", async () => {
      await db.insert(backlinkSnapshots).values({
        projectId: "project-1",
        domain: "example.com",
        referringDomains: 118,
        capturedAt: new Date().toISOString(),
      });
      await expect(
        fetchDetectorInput(
          "lost_backlinks",
          "project-1",
          ctxFor("lost_backlinks"),
        ),
      ).rejects.toBeInstanceOf(InsufficientCoverageError);
    });

    it("throws for lost-backlinks with a stale newest snapshot", async () => {
      const now = Date.now();
      await db.insert(backlinkSnapshots).values([
        {
          projectId: "project-1",
          domain: "example.com",
          capturedAt: new Date(now - 60 * 86_400_000).toISOString(),
        },
        {
          projectId: "project-1",
          domain: "example.com",
          lostReferringDomains: 9,
          capturedAt: new Date(now - 45 * 86_400_000).toISOString(),
        },
      ]);
      await expect(
        fetchDetectorInput(
          "lost_backlinks",
          "project-1",
          ctxFor("lost_backlinks"),
        ),
      ).rejects.toBeInstanceOf(InsufficientCoverageError);
    });

    it("throws (never a loss) when name resolution fails", async () => {
      await seedLossSnapshots(6);
      mockLostRows([], true);
      await expect(
        fetchDetectorInput(
          "lost_backlinks",
          "project-1",
          ctxFor("lost_backlinks"),
        ),
      ).rejects.toBeInstanceOf(InsufficientCoverageError);
    });
  });

  it("throws for GA4 change without a connection (absent-GA4 degradation)", async () => {
    await expect(
      fetchDetectorInput(
        "ga4_organic_change",
        "project-1",
        ctxFor("ga4_organic_change"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });

  it("aggregates GA4 sessions across covered windows", async () => {
    await seedGa4Summary();
    const input: unknown = await fetchDetectorInput(
      "ga4_organic_change",
      "project-1",
      ctxFor("ga4_organic_change"),
    );
    if (!isGa4ChangeInput(input)) throw new Error("expected ga4 input");
    expect(input).toMatchObject({
      periodFrom: "2026-01-08",
      periodTo: "2026-01-14",
      previousFrom: "2026-01-01",
      previousTo: "2026-01-07",
      propertyId: "properties/123",
    });
    expect(input.previous.sessions).toBe(700);
    expect(input.current.sessions).toBe(420);
  });

  it("resolves decay GA4 agreement without rank witnesses", async () => {
    await seedPageFacts();
    await seedGa4Landing();
    const input: unknown = await fetchDetectorInput(
      "content_decay",
      "project-1",
      ctxFor("content_decay"),
    );
    if (!isDecayInput(input)) throw new Error("expected decay input");
    expect(input.ga4Available).toBe(true);
    expect(input.ga4AgreementByUrl["https://example.com/guide"]).toBe(true);
    expect(input.rankAvailable).toBe(false);
  });

  it("degrades decay gracefully without any GA4 rows", async () => {
    await seedPageFacts();
    const input: unknown = await fetchDetectorInput(
      "content_decay",
      "project-1",
      ctxFor("content_decay"),
    );
    if (!isDecayInput(input)) throw new Error("expected decay input");
    expect(input.ga4Available).toBe(false);
    expect(input.ga4AgreementByUrl).toEqual({});
  });

  it("casts the GA4 second vote on important pages", async () => {
    await seedAudit();
    await seedPageFacts();
    await seedGa4Landing();
    const input: unknown = await fetchDetectorInput(
      "technical_on_important_page",
      "project-1",
      ctxFor("technical_on_important_page"),
    );
    if (!isTechnicalInput(input)) throw new Error("expected technical input");
    expect(input.ga4Available).toBe(true);
    const pricing = input.issues.find((issue) =>
      issue.pageUrl.includes("pricing"),
    );
    expect(pricing?.ga4Vote).toBe(true);
  });

  it("keeps the technical vote pending without GA4", async () => {
    await seedAudit();
    await seedPageFacts();
    const input: unknown = await fetchDetectorInput(
      "technical_on_important_page",
      "project-1",
      ctxFor("technical_on_important_page"),
    );
    if (!isTechnicalInput(input)) throw new Error("expected technical input");
    expect(input.ga4Available).toBe(false);
    expect(input.issues).toHaveLength(1);
    expect(input.issues[0]?.ga4Vote).toBe(false);
  });

  it("assembles striking-distance input from query facts with echoed band", async () => {
    await seedQueryFacts();
    const input: unknown = await fetchDetectorInput(
      "striking_distance",
      "project-1",
      ctxFor("striking_distance"),
    );
    if (!isStrikingDistanceInput(input)) {
      throw new Error("expected striking-distance input");
    }
    expect(input.thresholds.minPosition).toBe(11);
    expect(input.thresholds.maxPosition).toBe(20);
    expect(input.rows).toHaveLength(1);
    // Seed: 8.5 position — out of band; the pure detector skips it but the
    // fetcher must still surface the row with its movement evidence.
    expect(input.rows[0]?.position).toBeCloseTo(8.5, 5);
    expect(input.rows[0]?.previousPosition).toBeCloseTo(8.5, 5);
  });

  it("throws for striking distance with no query facts", async () => {
    await expect(
      fetchDetectorInput(
        "striking_distance",
        "project-1",
        ctxFor("striking_distance"),
      ),
    ).rejects.toBeInstanceOf(InsufficientCoverageError);
  });
});

describe("full-scan integration over seeded sources", () => {
  it("completes all ten detectors with one finding each (except below-floor lost_backlinks)", async () => {
    await seedSummaryFacts();
    await seedQueryFacts();
    await seedPageFacts();
    await seedQueryPageFacts();
    await seedRank();
    await seedAudit();
    await seedBacklinksFresh();
    await seedGa4Summary();
    await seedGa4Landing();
    // The striking-distance detector needs an in-band query; the shared
    // query seed (8.5) is out of band, so add one 11–20 query day set.
    await insertInBandQueryFacts();

    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "manual",
    });
    const findings = await runDetectionStage({
      projectId: "project-1",
      organizationId: "org-1",
      runId: run.id,
      state: {
        versions: {
          gsc: "sync-1",
          ga4: "ga4sync-1",
          rank: "run-2",
          audit: "audit-1",
          backlinks: "backlinks:2",
        },
        sourceSet: ["audit", "backlinks", "ga4", "gsc", "rank"],
        detectorVersions: {},
        thresholdVersion: 2,
        activeMutations: {
          gsc: { isMutating: false, activeRunIds: [] },
          ga4: { isMutating: false, activeRunIds: [] },
          rank: { isMutating: false, activeRunIds: [] },
          audit: { isMutating: false, activeRunIds: [] },
          backlinks: { isMutating: false, activeRunIds: [] },
        },
      },
      detectors: listDetectors(),
      fetchInput: (detectorKey, ctx) =>
        fetchDetectorInput(detectorKey, "project-1", ctx),
    });

    expect(findings).toHaveLength(9);
    const byDetector = Object.fromEntries(
      findings.map((finding) => [finding.detectorKey, finding]),
    );
    expect(byDetector.ga4_organic_change?.entityKey).toBe("site");
    expect(byDetector.ga4_organic_change?.evidence.sources).toEqual(["ga4"]);
    expect(byDetector.organic_traffic_change?.entityKey).toBe("site");
    expect(byDetector.content_decay?.evidence.sources).toEqual(["gsc", "ga4"]);
    expect(byDetector.low_ctr_query?.entityKey).toBe("best running shoes");
    expect(byDetector.content_decay?.entityKey).toBe(
      "https://example.com/guide",
    );
    expect(byDetector.ranking_drop?.entityKey).toBe(
      "rank:best running shoes:desktop:2840",
    );
    expect(byDetector.cannibalization?.entityKey).toBe(
      "cannibalization:espresso:https://example.com/a:https://example.com/b",
    );
    expect(byDetector.technical_on_important_page?.entityKey).toBe(
      "technical:missing_title:https://example.com/pricing",
    );
    expect(byDetector.backlink_change?.entityKey).toBe("backlinks:example.com");
    expect(byDetector.striking_distance?.entityKey).toBe("in-band quick win");
    for (const finding of findings) {
      expect(finding.explanationFact.length).toBeGreaterThan(0);
      expect(finding.confidenceScore).toBeGreaterThanOrEqual(40);
    }
    const outcomes = await ScanLedgerRepository.getDetectorOutcomes(run.id);
    expect(outcomes).toHaveLength(10);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("completed");
    }
    // The lost-backlinks detector ran and completed but correctly emitted
    // nothing: the fixture's single lost referring domain is below the floor.
    expect(byDetector.lost_backlinks).toBeUndefined();
  });
});

/** 56 query days for an in-band 11–20 keyword (position 15, 300/day):
 *  qualifies above the 100-impression floor. */
async function insertInBandQueryFacts() {
  const { gscSearchPerformance } = await import("@/db/schema");
  const day = 86_400_000;
  const rows = [];
  for (let i = 0; i < 56; i += 1) {
    const date = new Date(Date.parse("2025-11-20T00:00:00Z") + i * day)
      .toISOString()
      .slice(0, 10);
    rows.push({
      id: `q-inband-${date}`,
      projectId: "project-1",
      property: "sc-domain:example.com",
      date,
      grain: "query",
      grainKey: "in-band quick win",
      query: "In-Band Quick Win",
      clicks: 3,
      impressions: 300,
      ctr: 0.01,
      position: 15,
    });
  }
  await db.insert(gscSearchPerformance).values(rows);
}
