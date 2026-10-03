/* eslint-disable max-lines, max-lines-per-function -- lifecycle suites grow per detector type */
import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

const r2 = vi.hoisted(() => ({
  objects: new Map<string, string>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => {
        const body = r2.objects.get(key);
        if (body === undefined) return null;
        return { text: async () => body };
      },
      head: async (key: string) => (r2.objects.has(key) ? { key } : null),
      put: async (key: string, body: string) => {
        r2.objects.set(key, body);
      },
    },
  },
  waitUntil: vi.fn(),
}));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  database.client = createClient({ url: "file::memory:" });
  database.db = drizzle(database.client);
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

import { OpportunityRepository } from "../repositories/OpportunityRepository";
import { materializeFinding } from "./materializeFinding";
import { ctrFinding } from "./materializerTestFixtures";
import type { Finding } from "@/shared/intelligence";

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  for (const file of [
    "drizzle/0053_minor_korath.sql",
    "drizzle/0054_mighty_mole_man.sql",
  ]) {
    const migration = readFileSync(resolve(process.cwd(), file), "utf8");
    for (const statement of migration
      .split("--> statement-breakpoint")
      .map((part) => part.trim())
      .filter(Boolean)) {
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

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  r2.objects.clear();
  vi.restoreAllMocks();
  for (const table of [
    "opportunity_events",
    "opportunities",
    "intelligence_run_detectors",
    "intelligence_runs",
    "projects",
  ]) {
    await database.client.execute(`DELETE FROM ${table}`);
  }
  await database.client.execute(
    "INSERT INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
});

describe("materializeFinding", () => {
  it("creates an occurrence with scores, copy, refs, and a detected event", async () => {
    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") return;
    const row = await OpportunityRepository.getById(result.id);
    expect(row?.logicalKey).toBe("low_ctr_query:best shoes");
    expect(row?.status).toBe("open");
    expect(row?.occurrenceNumber).toBe(1);
    expect(row?.type).toBe("ctr");
    expect(row?.keyword).toBe("best shoes");
    expect(row?.recommendation.length).toBeGreaterThan(0);
    // impact = round(100 × (30×logScale(5000) + 25×proximity(8.5)) / 55)
    expect(row?.impactScore).toBeGreaterThan(0);
    expect(row?.priority).toBe("High");
    expect(JSON.parse(row?.impactFactorsJson ?? "{}")).toMatchObject({
      businessIntent: null,
      conversionSignal: null,
    });
    const events = await OpportunityRepository.listEventsByOccurrence(
      result.id,
    );
    expect(events.map((e) => e.type)).toEqual(["detected"]);
  });

  it("updates in place on redetection, preserving status and clearing stale", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");
    await OpportunityRepository.updateById(first.id, {
      status: "in_progress",
      stale: true,
      staleAt: "2026-01-02T00:00:00.000Z",
      consecutiveMisses: 2,
      lastDetectedAt: "2025-12-01T00:00:00.000Z",
    });

    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("updated");
    const row = await OpportunityRepository.getById(first.id);
    expect(row?.status).toBe("in_progress");
    expect(row?.consecutiveMisses).toBe(0);
    expect(row?.stale).toBe(false);
    const events = await OpportunityRepository.listEventsByOccurrence(first.id);
    const types = events.map((e) => e.type);
    expect(types).toContain("redetected");
    expect(types).toContain("stale_cleared");
  });

  it("emits rescored only on a ≥10 impact delta", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");

    // Same evidence one hour later: no thresholds trip, no new events.
    await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });
    let events = await OpportunityRepository.listEventsByOccurrence(first.id);
    expect(events.map((e) => e.type)).toEqual(["detected"]);

    // Collapsed impressions rescore past the delta.
    await materializeFinding({
      finding: ctrFinding({
        evidence: {
          metrics: { impressions: 120, clicks: 0, ctr: 0, position: 8.5 },
          sources: ["gsc"],
          thresholdsApplied: { minImpressions: 100, ctrFloor: 0.01 },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: {},
        },
      }),
      scanId: "run-3",
      projectId: "project-1",
      organizationId: "org-1",
    });
    events = await OpportunityRepository.listEventsByOccurrence(first.id);
    expect(events.map((e) => e.type)).toContain("rescored");
  });

  it("recurs after terminal states without touching history", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");
    await OpportunityRepository.updateById(first.id, {
      status: "completed",
      completedAt: "2026-01-02T00:00:00.000Z",
    });

    const result = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-3",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("recurred");
    if (result.outcome !== "recurred") return;
    const row = await OpportunityRepository.getById(result.id);
    expect(row?.occurrenceNumber).toBe(2);
    expect(row?.recurrenceOfId).toBe(first.id);
    expect(row?.status).toBe("open");
    const old = await OpportunityRepository.getById(first.id);
    expect(old?.status).toBe("completed");
    const events = await OpportunityRepository.listEventsByOccurrence(
      result.id,
    );
    expect(events.map((e) => e.type)).toEqual(["detected", "recurred"]);
  });

  it("supersedes across detector versions", async () => {
    const first = await materializeFinding({
      finding: ctrFinding(),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    if (first.outcome !== "created") throw new Error("setup failed");

    const result = await materializeFinding({
      finding: ctrFinding({ detectorVersion: 2 }),
      scanId: "run-2",
      projectId: "project-1",
      organizationId: "org-1",
    });

    expect(result.outcome).toBe("superseded");
    if (result.outcome !== "superseded") return;
    const old = await OpportunityRepository.getById(first.id);
    expect(old?.status).toBe("dismissed");
    expect(old?.supersededById).toBe(result.id);
    const events = await OpportunityRepository.listEventsByOccurrence(first.id);
    expect(events.map((e) => e.type)).toContain("superseded");
  });

  it("skips findings without templates or factors", async () => {
    const result = await materializeFinding({
      finding: ctrFinding({ detectorKey: "future_detector" }),
      scanId: "run-1",
      projectId: "project-1",
      organizationId: "org-1",
    });
    expect(result).toMatchObject({ outcome: "skipped" });
    expect(
      await OpportunityRepository.listActiveByProject("project-1"),
    ).toHaveLength(0);
  });

  describe("striking_distance lifecycle (spec 004)", () => {
    function strikingFinding(overrides: Partial<Finding> = {}): Finding {
      return ctrFinding({
        detectorKey: "striking_distance",
        entityKey: "quick win query",
        entity: { query: "quick win query" },
        explanationFact:
          'Query "quick win query" shows potential at position 15.0 with 5000 impressions over 2026-01-01..2026-01-28.',
        evidence: {
          metrics: {
            impressions: 8000,
            clicks: 25,
            position: 15,
            previousPosition: 22,
          },
          periods: { from: "2026-01-01", to: "2026-01-28" },
          sources: ["gsc"],
          sourceRefs: { gscFactIds: ["fact-1"] },
          thresholdsApplied: {
            minWindowDays: 28,
            minImpressions: 100,
            minPosition: 11,
            maxPosition: 20,
          },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: { coverageDays: 28, impressionMultiple: 80 },
        },
        ...overrides,
      });
    }

    it("creates an open occurrence with type, keyword, and both impact factors", async () => {
      const result = await materializeFinding({
        finding: strikingFinding(),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(result.outcome).toBe("created");
      if (result.outcome !== "created") return;
      const row = await OpportunityRepository.getById(result.id);
      expect(row?.logicalKey).toBe("striking_distance:quick win query");
      expect(row?.type).toBe("striking_distance");
      expect(row?.keyword).toBe("quick win query");
      expect(row?.recommendation).toContain("internal links");
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test-only JSON shape assertion; values asserted numerically below
      const factors = JSON.parse(row?.impactFactorsJson ?? "{}") as {
        proximity: number;
        trafficPotential: number;
      };
      expect(factors.proximity).toBeCloseTo(1 - (15 - 1) / 20, 5);
      expect(factors.trafficPotential).toBeCloseTo(
        Math.min(1, Math.log10(1 + 8000) / 5),
        5,
      );
      const events = await OpportunityRepository.listEventsByOccurrence(
        result.id,
      );
      expect(events.map((e) => e.type)).toEqual(["detected"]);
    });

    it("updates in place on redetection, preserving status and terminal rows", async () => {
      const first = await materializeFinding({
        finding: strikingFinding(),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      if (first.outcome !== "created") throw new Error("setup failed");
      await OpportunityRepository.updateById(first.id, {
        status: "in_progress",
        stale: true,
        lastDetectedAt: "2025-12-01T00:00:00.000Z",
      });

      const result = await materializeFinding({
        finding: strikingFinding(),
        scanId: "run-2",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(result.outcome).toBe("updated");
      const row = await OpportunityRepository.getById(first.id);
      expect(row?.status).toBe("in_progress");
      expect(row?.stale).toBe(false);
      const events = await OpportunityRepository.listEventsByOccurrence(
        first.id,
      );
      const types = events.map((e) => e.type);
      expect(types).toContain("redetected");
      expect(types).toContain("stale_cleared");
    });

    it("supersedes across detector versions and never reopens history", async () => {
      const first = await materializeFinding({
        finding: strikingFinding(),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      if (first.outcome !== "created") throw new Error("setup failed");

      const result = await materializeFinding({
        finding: strikingFinding({ detectorVersion: 2 }),
        scanId: "run-2",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(result.outcome).toBe("superseded");
      const old = await OpportunityRepository.getById(first.id);
      expect(old?.status).toBe("dismissed");
      expect(old?.supersededById).toBe(
        "id" in result && typeof result.id === "string" ? result.id : null,
      );
      const events = await OpportunityRepository.listEventsByOccurrence(
        first.id,
      );
      expect(events.map((e) => e.type)).toContain("superseded");
    });
  });

  describe("canonical identity re-keying (spec 006)", () => {
    function technicalFinding(entityKey: string): Finding {
      return ctrFinding({
        detectorKey: "technical_on_important_page",
        entityKey,
        entity: {
          issueType: "missing_title",
          page: "https://example.com/Blog/Post/",
        },
        explanationFact:
          "Page https://example.com/Blog/Post/ has a missing title.",
        evidence: {
          metrics: { pageClicks: 500 },
          periods: { from: "2026-01-01", to: "2026-01-28" },
          sources: ["gsc"],
          sourceRefs: {},
          thresholdsApplied: {},
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: { coverageDays: 28 },
        },
      });
    }

    it("creates under the new identity without colliding with the old-key row", async () => {
      const oldRow = await materializeFinding({
        finding: technicalFinding("technical:missing_title:/Blog/Post/"),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(oldRow.outcome).toBe("created");
      if (oldRow.outcome !== "created") return;

      const next = await materializeFinding({
        finding: technicalFinding(
          "technical:missing_title:https://example.com/Blog/Post",
        ),
        scanId: "run-2",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(next.outcome).toBe("created");
      if (next.outcome !== "created") return;
      expect(next.id).not.toBe(oldRow.id);

      const oldStored = await OpportunityRepository.getById(oldRow.id);
      const newStored = await OpportunityRepository.getById(next.id);
      expect(oldStored?.logicalKey).toBe(
        "technical_on_important_page:technical:missing_title:/Blog/Post/",
      );
      expect(newStored?.logicalKey).toBe(
        "technical_on_important_page:technical:missing_title:https://example.com/Blog/Post",
      );
      // The old-key row is untouched (still active, pending the normal
      // miss/stale lifecycle in Stage 2) — the new identity neither
      // overwrites history nor duplicates its own key on re-emission.
      expect(oldStored?.status).toBe("open");

      const repeat = await materializeFinding({
        finding: technicalFinding(
          "technical:missing_title:https://example.com/Blog/Post",
        ),
        scanId: "run-3",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(repeat.outcome).toBe("updated");
      const active =
        await OpportunityRepository.listActiveByProject("project-1");
      expect(active).toHaveLength(2);
    });
  });

  describe("conversion_drop lifecycle (spec 010)", () => {
    function conversionFinding(overrides: Partial<Finding> = {}): Finding {
      return ctrFinding({
        detectorKey: "conversion_drop",
        entityKey: "goal:goal-1",
        entity: {
          scope: "goal",
          goalId: "goal-1",
          goalName: "Newsletter signup",
          eventName: "signup_completed",
          propertyId: "properties/123",
        },
        explanationFact:
          'Conversions for goal "Newsletter signup" fell 70.0% (40 → 12) from 2026-01-04..2026-01-31 to 2026-02-01..2026-02-28.',
        evidence: {
          metrics: {
            goalName: "Newsletter signup",
            goalId: "goal-1",
            eventName: "signup_completed",
            conversionsBefore: 40,
            conversionsAfter: 12,
            changeRatio: -0.7,
            windowDays: 28,
          },
          periods: { from: "2026-02-01", to: "2026-02-28" },
          sources: ["ga4"],
          sourceRefs: {
            ga4Keys: [
              "ga4:properties/123:events:signup_completed:2026-01-04..2026-02-28",
            ],
          },
          thresholdsApplied: {
            minWindowDays: 28,
            minEventsPerWindow: 10,
            declineRatio: 0.3,
          },
          correlations: [],
          evidenceType: "observational",
          partialData: [],
          confidenceInputs: { coverageCurrent: 1, coveragePrevious: 1 },
        },
        confidenceScore: 70,
        ...overrides,
      });
    }

    it("creates with a goal logical key, separate scores, and frozen evidence", async () => {
      const first = await materializeFinding({
        finding: conversionFinding(),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(first.outcome).toBe("created");
      if (first.outcome !== "created") return;
      const row = await OpportunityRepository.getById(first.id);
      expect(row?.logicalKey).toBe("conversion_drop:goal:goal-1");
      expect(row?.type).toBe("ga4_conversion");
      expect(row?.keyword).toBeNull();
      expect(row?.page).toBeNull();
      // Frozen evidence keeps the goal name snapshot.
      expect(row?.evidenceJson).toContain("Newsletter signup");
      // Separate impact/confidence columns (P26).
      expect(row?.impactScore).toBeGreaterThan(0);
      expect(row?.confidenceScore).toBe(70);

      // Re-scan over identical windows: idempotent, zero duplicates.
      const repeat = await materializeFinding({
        finding: conversionFinding(),
        scanId: "run-2",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(repeat.outcome).toBe("updated");
      const active =
        await OpportunityRepository.listActiveByProject("project-1");
      expect(active).toHaveLength(1);
      const events = await OpportunityRepository.listEventsByOccurrence(
        first.id,
      );
      // Exactly one detected event: the re-scan records redetected, never a
      // second detected event for the same logical occurrence.
      expect(
        events.filter((event) => event.type === "detected"),
      ).toHaveLength(1);
    });
  });

  describe("lost_backlinks lifecycle (spec 008)", () => {
    function lostFinding(overrides: Partial<Finding> = {}): Finding {
      return ctrFinding({
        detectorKey: "lost_backlinks",
        entityKey: "backlinks:example.com",
        entity: { domain: "example.com", lostDomains: "gone-a.com" },
        explanationFact:
          "Heuristic (two snapshots): 5 referring domains stopped linking to example.com.",
        evidence: {
          metrics: {
            lostReferringDomains: 5,
            namedLostDomains: 1,
            lostBacklinks: 9,
            referringDomainsBefore: 120,
            referringDomainsAfter: 112,
          },
          periods: { from: "2026-09-10", to: "2026-09-20" },
          sources: ["backlinks"],
          thresholdsApplied: { minReferringDomains: 3 },
          correlations: [],
          evidenceType: "observational",
          partialData: ["two_point_heuristic"],
          confidenceInputs: { snapshotCount: 2, lostReferringDomains: 5 },
        },
        confidenceScore: 50,
        ...overrides,
      });
    }

    it("creates with its own logical key and updates idempotently on rescan", async () => {
      const first = await materializeFinding({
        finding: lostFinding(),
        scanId: "run-1",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(first.outcome).toBe("created");
      if (first.outcome !== "created") return;
      const row = await OpportunityRepository.getById(first.id);
      expect(row?.logicalKey).toBe("lost_backlinks:backlinks:example.com");
      expect(row?.type).toBe("lost_backlinks");

      const repeat = await materializeFinding({
        finding: lostFinding(),
        scanId: "run-2",
        projectId: "project-1",
        organizationId: "org-1",
      });
      expect(repeat.outcome).toBe("updated");
      const active =
        await OpportunityRepository.listActiveByProject("project-1");
      expect(active).toHaveLength(1);
    });
  });
});
