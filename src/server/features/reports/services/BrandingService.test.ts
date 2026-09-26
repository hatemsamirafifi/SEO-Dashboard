import type { Client } from "@libsql/client";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const r2Mocks = vi.hoisted(() => ({
  put: vi.fn(),
  delete: vi.fn(),
}));

const database = vi.hoisted(() => ({
  client: undefined as Client | undefined,
  // Widened: the drizzle handle carries the relational schema (db.query).
  db: undefined as unknown,
}));

vi.mock("cloudflare:workers", () => ({
  env: { R2: { put: r2Mocks.put, delete: r2Mocks.delete } },
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
import { BrandingService } from "./BrandingService";

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

function pngDataUrl(width: number, height: number): string {
  const bytes = new Uint8Array(33);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `data:image/png;base64,${btoa(binary)}`;
}

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
  vi.restoreAllMocks();
  vi.spyOn(SourceTokens, "assembleDetectionSourceState").mockResolvedValue(
    sourceState(),
  );
});

describe("organization branding", () => {
  it("returns null when unset and upserts validated fields", async () => {
    expect(
      await BrandingService.getOrganizationBranding({
        organizationId: "org-1",
      }),
    ).toBeNull();
    const row = await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Acme SEO",
      accentColor: "#1a2b3c",
      footerText: "Prepared by Acme",
    });
    expect(row.agencyName).toBe("Acme SEO");
    expect(row.agencyLogoR2Key).toBeNull();
    const snapshot = await BrandingService.resolveBrandingSnapshot({
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(snapshot.agency).toMatchObject({ name: "Acme SEO" });
    expect(snapshot.client).toBeNull();
  });

  it("rejects blank names, bad colors, and long footers", async () => {
    await expect(
      BrandingService.setOrganizationBranding({
        organizationId: "org-1",
        agencyName: "  ",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      BrandingService.setOrganizationBranding({
        organizationId: "org-1",
        agencyName: "Acme",
        accentColor: "red",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      BrandingService.setOrganizationBranding({
        organizationId: "org-1",
        agencyName: "Acme",
        footerText: "x".repeat(501),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("stores logos in R2 and deletes replacements", async () => {
    const first = await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Acme",
      logoDataUrl: pngDataUrl(100, 50),
    });
    expect(first.agencyLogoR2Key).toMatch(
      /^branding\/org-1\/[0-9a-f]{64}\.png$/,
    );
    expect(r2Mocks.put).toHaveBeenCalledTimes(1);
    const second = await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Acme",
      logoDataUrl: pngDataUrl(200, 100),
    });
    expect(second.agencyLogoR2Key).not.toBe(first.agencyLogoR2Key);
    expect(r2Mocks.delete).toHaveBeenCalledWith(first.agencyLogoR2Key);
    await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Acme",
      removeLogo: true,
    });
    expect(
      (
        await BrandingService.getOrganizationBranding({
          organizationId: "org-1",
        })
      )?.agencyLogoR2Key,
    ).toBeNull();
  });
});

describe("client profiles", () => {
  it("upserts client data but never freezes notes", async () => {
    const row = await BrandingService.setClientProfile({
      projectId: "project-1",
      clientName: "Client Co",
      reportTitleOverride: "Q1 Review",
      notes: "Internal: difficult stakeholder.",
    });
    expect(row.clientName).toBe("Client Co");
    await expect(
      BrandingService.setClientProfile({
        projectId: "project-1",
        clientName: "Client Co",
        reportTitleOverride: "x".repeat(121),
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    const snapshot = await BrandingService.resolveBrandingSnapshot({
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(snapshot.client).toEqual({
      name: "Client Co",
      logoR2Key: null,
      titleOverride: "Q1 Review",
    });
    expect(JSON.stringify(snapshot).includes("stakeholder")).toBe(false);
  });
});

describe("generation freeze", () => {
  it("freezes the combination at generation and ignores later edits", async () => {
    await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Acme",
    });
    await BrandingService.setClientProfile({
      projectId: "project-1",
      clientName: "Client Co",
    });
    const row = await generateReport({
      projectId: "project-1",
      organizationId: "org-1",
      domain: null,
      type: "overview",
      period: { from: "2026-01-01", to: "2026-01-14" },
    });
    await BrandingService.setOrganizationBranding({
      organizationId: "org-1",
      agencyName: "Renamed Agency",
    });
    const { parseStoredBrandingSnapshot } = await import("./ShareService");
    const frozen = parseStoredBrandingSnapshot(row.brandingSnapshotJson);
    expect(frozen?.agency?.name).toBe("Acme");
    expect(frozen?.client?.name).toBe("Client Co");
    const live = await BrandingService.resolveBrandingSnapshot({
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(live.agency?.name).toBe("Renamed Agency");
  });
});
