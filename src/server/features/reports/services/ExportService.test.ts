import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const waited = vi.hoisted(() => ({ promises: [] as Promise<unknown>[] }));

const r2Store = vi.hoisted(() => ({ objects: new Map<string, string>() }));

const r2Mocks = vi.hoisted(() => ({
  put: vi.fn(async (key: string, body: string) => {
    r2Store.objects.set(key, body);
  }),
  get: vi.fn(async (key: string) =>
    r2Store.objects.has(key)
      ? { text: async () => r2Store.objects.get(key), body: "stream" }
      : null,
  ),
  head: vi.fn(async (key: string) =>
    r2Store.objects.has(key)
      ? { size: r2Store.objects.get(key)?.length ?? 0 }
      : null,
  ),
}));

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  // Widened: the drizzle handle carries the relational schema (db.query).
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: { put: r2Mocks.put, get: r2Mocks.get, head: r2Mocks.head } },
  waitUntil: (promise: Promise<unknown>) => {
    waited.promises.push(promise);
  },
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
import { captureServerEvent } from "@/server/lib/posthog";
import { db } from "@/db";
import { reports } from "@/db/schema";
import { eq } from "drizzle-orm";
import { generateReport } from "./ReportService";
import { SharingRepository } from "../repositories/SharingRepository";
import { ExportService } from "./ExportService";

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
  r2Store.objects.clear();
  waited.promises.length = 0;
  vi.restoreAllMocks();
  vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
    sourceState(),
  );
});

async function seedReport(): Promise<string> {
  const row = await generateReport({
    projectId: "project-1",
    organizationId: "org-1",
    domain: null,
    type: "overview",
    period: PERIOD,
  });
  return row.id;
}

async function flushExports(): Promise<void> {
  // The queue also collects waitUntil(undefined) calls from mocked telemetry;
  // only real promises belong to the export flow.
  const pending = waited.promises
    .splice(0)
    .filter((entry): entry is Promise<unknown> => entry instanceof Promise);
  await Promise.all(pending);
}

describe("requestExport", () => {
  it("renders PDF asynchronously and records the event", async () => {
    const reportId = await seedReport();
    const first = await ExportService.requestExport({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      userId: "user-1",
      format: "pdf",
    });
    expect(first).toEqual({ status: "pending" });
    await flushExports();
    const status = await ExportService.getExportStatus({
      reportId,
      projectId: "project-1",
      format: "pdf",
    });
    expect(status.status).toBe("ready");
    if (status.status !== "ready") throw new Error("Export did not complete");
    expect(status.r2Key).toMatch(
      /^report-exports\/.+\/report-overview-2026-01-01-2026-01-14-[0-9a-f]{16}\.pdf$/,
    );
    const stored = r2Store.objects.get(status.r2Key) ?? "";
    expect(stored.startsWith("%PDF-1.4\n")).toBe(true);
    expect(stored).toContain("OpenSEO - 2026-01-01");
    const events = await SharingRepository.listEventsByReport(reportId);
    expect(events.map((event) => event.type)).toContain("exported_pdf");
    const mocked = vi.mocked(captureServerEvent);
    const exportCalls = mocked.mock.calls.filter(
      (call) =>
        typeof call[0] === "object" &&
        call[0] !== null &&
        "event" in call[0] &&
        call[0].event === "report:export_pdf",
    );
    expect(exportCalls).toHaveLength(1);
    expect(exportCalls[0]?.[0]).toMatchObject({
      properties: { format: "pdf" },
    });
  });

  it("renders the print-HTML fallback through the same flow", async () => {
    const reportId = await seedReport();
    await ExportService.requestExport({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      format: "html",
    });
    await flushExports();
    const status = await ExportService.getExportStatus({
      reportId,
      projectId: "project-1",
      format: "html",
    });
    expect(status.status).toBe("ready");
    if (status.status !== "ready") throw new Error("Export did not complete");
    const stored = r2Store.objects.get(status.r2Key) ?? "";
    expect(stored.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(stored).not.toContain("<script");
  });

  it("dedupes unchanged snapshots without duplicate work", async () => {
    const reportId = await seedReport();
    const input = {
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      format: "pdf" as const,
    };
    await ExportService.requestExport(input);
    await flushExports();
    const putsAfterFirst = r2Mocks.put.mock.calls.length;
    const second = await ExportService.requestExport(input);
    expect(second.status).toBe("ready");
    expect(r2Mocks.put.mock.calls.length).toBe(putsAfterFirst);
    const events = await SharingRepository.listEventsByReport(reportId);
    expect(
      events.filter((event) => event.type === "exported_pdf"),
    ).toHaveLength(1);
  });

  it("fails closed on corrupt payloads with code-only errors", async () => {
    const reportId = await seedReport();
    await db
      .update(reports)
      .set({ payloadSnapshotJson: "{nope" })
      .where(eq(reports.id, reportId));
    await ExportService.requestExport({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      format: "pdf",
    });
    await flushExports();
    const status = await ExportService.getExportStatus({
      reportId,
      projectId: "project-1",
      format: "pdf",
    });
    expect(status).toEqual({ status: "failed", error: "INTERNAL_ERROR" });
    const events = await SharingRepository.listEventsByReport(reportId);
    expect(
      events.some((event) => event.type === "exported_pdf"),
    ).toBe(false);
  });

  it("rejects wrong-project access on every entry point", async () => {
    const reportId = await seedReport();
    const input = {
      reportId,
      projectId: "other",
      organizationId: "org-1",
      format: "pdf" as const,
    };
    await expect(ExportService.requestExport(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(ExportService.getExportStatus(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect(
      await ExportService.downloadExport(input),
    ).toBeNull();
  });
});

describe("downloadExport", () => {
  it("streams ready bytes with filenames, null otherwise", async () => {
    const reportId = await seedReport();
    expect(
      await ExportService.downloadExport({
        reportId,
        projectId: "project-1",
        format: "pdf",
      }),
    ).toBeNull();
    await ExportService.requestExport({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      format: "pdf",
    });
    await flushExports();
    const ready = await ExportService.downloadExport({
      reportId,
      projectId: "project-1",
      format: "pdf",
    });
    expect(ready?.contentType).toBe("application/pdf");
    expect(ready?.fileName.endsWith(".pdf")).toBe(true);
    expect(ready?.body).toBe("stream");
  });
});
