import type { Client } from "@libsql/client";
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as LibSQLDatabase | undefined,
}));

vi.mock("cloudflare:workers", () => ({ env: {}, waitUntil: vi.fn() }));

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

import {
  InsightRepository,
  type InsightInsert,
} from "../repositories/InsightRepository";
import { ScanLedgerRepository } from "../repositories/ScanLedgerRepository";
import { InsightService } from "./InsightService";

function insightRow(
  overrides: Partial<InsightInsert> = {},
): InsightInsert {
  return {
    id: `ins-${Math.random().toString(36).slice(2)}`,
    projectId: "project-1",
    organizationId: "org-1",
    insightKey: "dashboard:ranking_drop",
    composerKey: "dashboard",
    type: "ranking_drop",
    detectorKey: "ranking_drop",
    severity: "high",
    title: "2 important keywords lost rankings",
    explanationFact: "Observed during the same period.",
    evidenceSummary: "Observed during the same period.",
    scanId: "run-1",
    detectedAt: "2026-01-01T00:00:00.000Z",
    lastSeenAt: "2026-01-01T00:00:00.000Z",
    contentVersion: 1,
    contentHash: "h",
    ...overrides,
  };
}

async function seed(row: InsightInsert): Promise<string> {
  const created = await InsightRepository.insertRow(row);
  return created.id;
}

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  for (const file of [
    "drizzle/0053_minor_korath.sql",
    "drizzle/0055_certain_infant_terrible.sql",
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
  for (const table of [
    "insight_user_preferences",
    "dashboard_insights",
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

function baseInput(overrides = {}) {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
    ga4Connected: false,
    ...overrides,
  };
}

describe("InsightService.getDashboardInsights", () => {
  it("hides resolved and dismissed rows, counts dismissals", async () => {
    await seed(insightRow({ id: "ins-1", insightKey: "dashboard:ranking_drop" }));
    await seed(
      insightRow({
        id: "ins-2",
        insightKey: "dashboard:low_ctr_query",
        type: "low_ctr_query",
        detectorKey: "low_ctr_query",
        resolvedAt: "2026-01-02T00:00:00.000Z",
        resolveReason: "absent in scan run-2",
      }),
    );
    await InsightRepository.upsertPreference({
      userId: "user-1",
      projectId: "project-1",
      insightKey: "dashboard:ranking_drop",
      dismissedContentVersion: 1,
      snoozedUntil: null,
      hash: "pref-hash",
    });

    const result = await InsightService.getDashboardInsights(baseInput());

    expect(result.insights).toHaveLength(0);
    expect(result.dismissedCount).toBe(1);
    expect(result.banner.hasSuccessfulScan).toBe(false);
    expect(result.banner.stale).toBe(true);
    expect(result.banner.ga4Connected).toBe(false);
  });

  it("re-surfaces bumped rows with an updated flag", async () => {
    await seed(insightRow({ id: "ins-1" }));
    await InsightRepository.upsertPreference({
      userId: "user-1",
      projectId: "project-1",
      insightKey: "dashboard:ranking_drop",
      dismissedContentVersion: 1,
      snoozedUntil: null,
      hash: "pref-hash",
    });
    await InsightRepository.updateById("ins-1", { contentVersion: 2 });

    const result = await InsightService.getDashboardInsights(baseInput());

    expect(result.insights).toHaveLength(1);
    expect(result.insights[0]?.updatedSinceDismiss).toBe(true);
    expect(result.dismissedCount).toBe(0);
  });

  it("hides snoozed rows until expiry, per user", async () => {
    await seed(insightRow({ id: "ins-1" }));
    const future = new Date(Date.now() + 86_400_000).toISOString();
    await InsightRepository.upsertPreference({
      userId: "user-1",
      projectId: "project-1",
      insightKey: "dashboard:ranking_drop",
      dismissedContentVersion: 0,
      snoozedUntil: future,
      hash: "pref-hash",
    });

    const snoozed = await InsightService.getDashboardInsights(baseInput());
    expect(snoozed.insights).toHaveLength(0);

    const other = await InsightService.getDashboardInsights(
      baseInput({ userId: "user-2" }),
    );
    expect(other.insights).toHaveLength(1);
  });

  it("assembles skip/fail banners from the latest run", async () => {
    const run = await ScanLedgerRepository.createRun({
      projectId: "project-1",
      organizationId: "org-1",
      triggeredBy: "cron",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "detecting",
      toStatus: "detecting",
    });
    await ScanLedgerRepository.recordDetectorOutcome({
      runId: run.id,
      detectorKey: "low_ctr_query",
      status: "skipped",
      skipReason: "no GSC facts",
    });
    await ScanLedgerRepository.recordDetectorOutcome({
      runId: run.id,
      detectorKey: "ranking_drop",
      status: "failed",
      error: "boom",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "materializing",
      toStatus: "materializing",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "composing",
      toStatus: "composing",
    });
    await ScanLedgerRepository.transitionStage({
      id: run.id,
      toStage: "composing",
      toStatus: "completed",
    });
    await database.client?.execute(
      `UPDATE intelligence_runs SET input_hash = '${"a".repeat(64)}' WHERE id = '${run.id}'`,
    );

    const result = await InsightService.getDashboardInsights(
      baseInput({ ga4Connected: true }),
    );

    expect(result.banner.skipped).toEqual([
      { detectorKey: "low_ctr_query", reason: "no GSC facts" },
    ]);
    expect(result.banner.failed).toEqual([
      { detectorKey: "ranking_drop", error: "boom" },
    ]);
    expect(result.banner.hasSuccessfulScan).toBe(true);
    expect(result.banner.stale).toBe(false);
    expect(result.banner.lastCompletedAt).not.toBeNull();
    expect(result.banner.ga4Connected).toBe(true);
  });
});

describe("InsightService.dismissInsight", () => {
  it("records the current version and clears on new input", async () => {
    await seed(insightRow({ id: "ins-1" }));
    const result = await InsightService.dismissInsight({
      projectId: "project-1",
      organizationId: "org-1",
      userId: "user-1",
      insightKey: "dashboard:ranking_drop",
      snoozedUntil: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(result).toEqual({ ok: true });
    const pref = await InsightRepository.getPreference(
      "user-1",
      "project-1",
      "dashboard:ranking_drop",
    );
    expect(pref?.dismissedContentVersion).toBe(1);
    expect(pref?.snoozedUntil).not.toBeNull();
  });

  it("rejects missing rows, resolved rows, and bad dates", async () => {
    await expect(
      InsightService.dismissInsight({
        projectId: "project-1",
        organizationId: "org-1",
        userId: "user-1",
        insightKey: "dashboard:nope",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await seed(
      insightRow({
        id: "ins-resolved",
        insightKey: "dashboard:resolved",
        resolvedAt: "2026-01-02T00:00:00.000Z",
      }),
    );
    await expect(
      InsightService.dismissInsight({
        projectId: "project-1",
        organizationId: "org-1",
        userId: "user-1",
        insightKey: "dashboard:resolved",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    await seed(insightRow({ id: "ins-1" }));
    await expect(
      InsightService.dismissInsight({
        projectId: "project-1",
        organizationId: "org-1",
        userId: "user-1",
        insightKey: "dashboard:ranking_drop",
        snoozedUntil: "not-a-date",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
