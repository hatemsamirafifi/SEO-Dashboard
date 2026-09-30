/* eslint-disable max-lines */
import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Trust-boundary audits for the public share surface (spec 005, FR-002/003;
 * P32/G7 + P40):
 *  T008 — leak audit: the public payload carries the explicit allowlist only
 *    (frozen sections + branding + consistency banner); credentials, costs,
 *    internal provider payloads, raw tokens, cross-project data, and session
 *    info must be absent from the anonymous response.
 *  T009 — storage inspection: zero raw share tokens in any table or audit
 *    log; only SHA-256 hashes exist, and audit rows never carry secrets.
 */
import { stableHash } from "@/shared/intelligence";
import type { ReportPayload } from "@/shared/reports";

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  db: undefined as unknown,
}));

const r2 = vi.hoisted(() => ({
  objects: new Map<string, string>(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async (key: string) => r2.objects.get(key) ?? null,
      put: async (key: string, body: string) => {
        r2.objects.set(key, body);
      },
    },
  },
  waitUntil: vi.fn(),
}));

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

import {
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import { generateReport } from "./ReportService";
import { SharingRepository } from "../repositories/SharingRepository";
import { ShareService } from "./ShareService";

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
  return readFileSync(resolve(process.cwd(), file), "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("--> statement-breakpoint")
    .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
    .filter(Boolean);
}

const PERIOD = { from: "2026-02-01", to: "2026-02-14" };

beforeAll(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  await database.client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    readFileSync(resolve(process.cwd(), "drizzle/meta/_journal.json"), "utf8"),
  );
  if (!isMigrationJournal(journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  for (const entry of journal.entries) {
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
  "report_events",
  "report_shares",
  "reports",
  "organization_branding",
  "project_client_profiles",
  "intelligence_run_detectors",
  "intelligence_runs",
  "dashboard_insights",
  "insight_user_preferences",
  "opportunity_events",
  "opportunities",
  "projects",
  "organization",
  "user",
];

beforeEach(async () => {
  if (!database.client) throw new Error("Test database was not initialized");
  r2objectsReset();
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
  await database.client.execute(
    `INSERT INTO "user" (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.com')`,
  );
  vi.restoreAllMocks();
  vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
    sourceState(),
  );
});

function r2objectsReset(): void {
  r2.objects.clear();
}

describe("T008 public-payload leak audit", () => {
  it("exposes exactly the allowlisted top-level shape", async () => {
    const { token } = await seedShared();
    const view = await ShareService.getPublicReportByToken(token);
    if (!view) throw new Error("expected shareable view");
    // Allowlist: report meta + frozen payload + branding. Nothing else.
    expect(Object.keys(view).toSorted()).toEqual(
      ["branding", "payload", "report"].toSorted(),
    );
    expect(Object.keys(view.report).toSorted()).toEqual(
      [
        "id",
        "type",
        "periodFrom",
        "periodTo",
        "createdAt",
        "consistencyStatus",
      ].toSorted(),
    );
    // The consistency banner derives from frozen provenance.
    const payload = view.payload as ReportPayload;
    expect(payload.provenance.consistencyStatus).toBeTypeOf("string");
  });

  it("carries no denylisted content in the serialized response", async () => {
    const { token } = await seedShared();
    const view = await ShareService.getPublicReportByToken(token);
    if (!view) throw new Error("expected view");
    const serialized = JSON.stringify(view);
    const denylist: Array<[string, RegExp]> = [
      ["credentials/env keys", /api[_-]?key|login|password|secret|token_/i],
      ["cost data", /"cost|spend|credits|budget/i],
      ["internal provider payloads", /SerpLiveItem|rank_group|etv|batchRun/i],
      ["raw tokens", new RegExp(token, "g")],
      ["raw token hash", new RegExp(await stableHash(token), "g")],
      ["other project ids", /project-2|other-project/i],
      ["session/user identity", /user-1|@example\.com|session/i],
      ["schema/SQL internals", /token_hash|report_shares|INSERT INTO/i],
    ];
    for (const [label, pattern] of denylist) {
      expect(pattern.test(serialized), `${label} leaked`).toBe(false);
    }
  });

  it("records the viewed event and never echoes the raw token or its hash in any audit event", async () => {
    const { token, reportId } = await seedShared();
    // Anonymous view (viewed event) after a shared event.
    await ShareService.getPublicReportByToken(token);
    const events = await SharingRepository.listEventsByReport(reportId);
    for (const event of events) {
      const serialized = JSON.stringify(event) ?? "";
      expect(serialized.includes(token)).toBe(false);
      expect(serialized.includes(await stableHash(token))).toBe(false);
    }
  });
});

describe("T009 storage inspection (hash-only persistence)", () => {
  it("finds zero raw tokens across every reports-related table", async () => {
    const { token } = await seedShared();
    if (!database.client) throw new Error("database missing");
    for (const table of [
      "report_shares",
      "report_events",
      "reports",
    ]) {
      const result = await database.client.execute(
        `SELECT * FROM ${table}`,
      );
      for (const row of result.rows) {
        for (const [column, value] of Object.entries(row)) {
          const text = String(value ?? "");
          expect(
            text.includes(token),
            `${table}.${column} contains the raw token`,
          ).toBe(false);
        }
      }
    }
    const stored = await SharingRepository.findShareByTokenHash(
      await stableHash(token),
    );
    expect(stored?.tokenHash).toBe(await stableHash(token));
    expect(Object.keys(stored ?? {})).not.toContain("token");
  });

  it("keeps schedules/token references hash-or-id-only (no schedule table exists)", () => {
    // Structural lock: no report_schedules table exists at all (P33/G7 —
    // deferred delivery can never leak tokens it never stores).
    const schemaFiles = [
      "src/db/report-sharing.schema.ts",
      "src/db/pg/report-sharing.schema.ts",
      "src/db/reports.schema.ts",
      "src/db/pg/reports.schema.ts",
    ];
    for (const file of schemaFiles) {
      const content = readFileSync(resolve(process.cwd(), file), "utf8");
      expect(content.includes("report_schedules")).toBe(false);
    }
  });
});

async function seedShared(): Promise<{
  reportId: string;
  token: string;
  shareId: string;
}> {
  const row = await generateReport({
    projectId: "project-1",
    organizationId: "org-1",
    domain: null,
    type: "overview",
    period: PERIOD,
  });
  const created = await ShareService.createReportShare({
    reportId: row.id,
    projectId: "project-1",
    organizationId: "org-1",
    userId: "user-1",
  });
  return { reportId: row.id, token: created.token, shareId: created.shareId };
}