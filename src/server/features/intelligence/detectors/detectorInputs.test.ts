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

import { db } from "@/db";
import { audits, backlinkSnapshots } from "@/db/schema";
import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import { runDetectionStage } from "../services/detectionStage";
import { fetchDetectorInput } from "./inputs";
import { listDetectors } from "./registry";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { InsufficientCoverageError } from "./types";
import type { DetectorContext } from "./types";
import {
  seedAudit,
  seedBacklinksFresh,
  seedPageFacts,
  seedQueryFacts,
  seedQueryPageFacts,
  seedRank,
  seedSummaryFacts,
} from "./detectorTestSeeds";

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
});

describe("full-scan integration over seeded sources", () => {
  it("completes all seven detectors with one finding each", async () => {
    await seedSummaryFacts();
    await seedQueryFacts();
    await seedPageFacts();
    await seedQueryPageFacts();
    await seedRank();
    await seedAudit();
    await seedBacklinksFresh();

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
          ga4: null,
          rank: "run-2",
          audit: "audit-1",
          backlinks: "backlinks:2",
        },
        sourceSet: ["gsc", "rank", "audit", "backlinks"],
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

    expect(findings).toHaveLength(7);
    const byDetector = Object.fromEntries(
      findings.map((finding) => [finding.detectorKey, finding]),
    );
    expect(byDetector.organic_traffic_change?.entityKey).toBe("site");
    expect(byDetector.low_ctr_query?.entityKey).toBe("best running shoes");
    expect(byDetector.content_decay?.entityKey).toBe(
      "/https://example.com/guide",
    );
    expect(byDetector.ranking_drop?.entityKey).toBe(
      "rank:best running shoes:desktop:2840",
    );
    expect(byDetector.cannibalization?.entityKey).toBe(
      "cannibalization:espresso:/https://example.com/a:/https://example.com/b",
    );
    expect(byDetector.technical_on_important_page?.entityKey).toBe(
      "technical:missing_title:/https://example.com/pricing",
    );
    expect(byDetector.backlink_change?.entityKey).toBe("backlinks:example.com");
    for (const finding of findings) {
      expect(finding.explanationFact.length).toBeGreaterThan(0);
      expect(finding.confidenceScore).toBeGreaterThanOrEqual(40);
    }
    const outcomes = await ScanLedgerRepository.getDetectorOutcomes(run.id);
    expect(outcomes).toHaveLength(7);
    for (const outcome of outcomes) {
      expect(outcome.status).toBe("completed");
    }
  });
});
