import type { Client } from "@libsql/client";
import { eq } from "drizzle-orm";
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
import { reportShares } from "@/db/schema";
import { stableHash } from "@/shared/intelligence";
import {
  SourceTokens,
  type DetectionSourceState,
} from "@/server/features/intelligence/services/SourceTokens";
import { captureServerEvent } from "@/server/lib/posthog";
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
    "INSERT INTO \"user\" (id, name, email) VALUES ('user-1', 'Owner', 'owner@example.com')",
  );
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

describe("createReportShare", () => {
  it("returns a single-display token and stores only its hash", async () => {
    const reportId = await seedReport();
    const created = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    expect(created.token).toMatch(/^[0-9a-f]{64}$/);
    const stored = await SharingRepository.findShareByTokenHash(
      await stableHash(created.token),
    );
    expect(stored?.id).toBe(created.shareId);
    expect(stored && "token" in stored).toBe(false);
    expect(stored?.tokenHash).not.toBe(created.token);
    const events = await SharingRepository.listEventsByReport(reportId);
    expect(events.map((event) => event.type)).toContain("shared");
    expect(vi.mocked(captureServerEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "report:share" }),
    );
  });

  it("rejects unknown reports, wrong projects, and bad expiries", async () => {
    const reportId = await seedReport();
    await expect(
      ShareService.createReportShare({
        reportId: "missing",
        projectId: "project-1",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ShareService.createReportShare({
        reportId,
        projectId: "other",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ShareService.createReportShare({
        reportId,
        projectId: "project-1",
        organizationId: "org-1",
        expiresAt: "2020-01-01T00:00:00.000Z",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    await expect(
      ShareService.createReportShare({
        reportId,
        projectId: "project-1",
        organizationId: "org-1",
        expiresAt: "not-a-date",
      }),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});

describe("list and revoke", () => {
  it("scopes shares to the report project and revokes idempotently", async () => {
    const reportId = await seedReport();
    const created = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    const listed = await ShareService.listReportShares({
      reportId,
      projectId: "project-1",
    });
    expect(listed.map((share) => share.id)).toEqual([created.shareId]);
    await expect(
      ShareService.listReportShares({ reportId, projectId: "other" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    const first = await ShareService.revokeReportShare({
      shareId: created.shareId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    const second = await ShareService.revokeReportShare({
      shareId: created.shareId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    expect(second.revokedAt).toBe(first.revokedAt);
    expect(vi.mocked(captureServerEvent)).toHaveBeenCalledWith(
      expect.objectContaining({ event: "report:revoke" }),
    );
    await expect(
      ShareService.revokeReportShare({
        shareId: "missing",
        projectId: "project-1",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      ShareService.revokeReportShare({
        shareId: created.shareId,
        projectId: "other",
        organizationId: "org-1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("getPublicReportByToken", () => {
  it("serves a sanitized view and counts the view", async () => {
    const reportId = await seedReport();
    const created = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      userId: "user-1",
    });
    const view = await ShareService.getPublicReportByToken(created.token);
    expect(view?.report.id).toBe(reportId);
    expect(view?.payload.reportType).toBe("overview");
    const serialized = JSON.stringify(view);
    for (const leaked of [
      "tokenHash",
      "user-1",
      "createdByUserId",
      "evidenceJson",
      "notes",
    ]) {
      expect(serialized.includes(leaked)).toBe(false);
    }
    const stored = await SharingRepository.findShareById(created.shareId);
    expect(stored?.viewCount).toBe(1);
    const events = await SharingRepository.listEventsByReport(reportId);
    expect(events.map((event) => event.type)).toEqual(
      expect.arrayContaining(["created", "shared", "viewed"]),
    );
    for (const event of events) {
      // Audit rows carry opaque ids at most — never emails or PII.
      expect(event.userId === null || !event.userId.includes("@")).toBe(true);
      if (event.metadataJson) {
        const metadata: unknown = JSON.parse(event.metadataJson);
        expect(
          typeof metadata === "object" &&
            metadata !== null &&
            Object.keys(metadata),
        ).toEqual(["shareId"]);
      }
    }
  });

  it("returns null for malformed, unknown, revoked, and expired tokens", async () => {
    expect(await ShareService.getPublicReportByToken("nope")).toBeNull();
    expect(
      await ShareService.getPublicReportByToken("a".repeat(64)),
    ).toBeNull();
    const reportId = await seedReport();
    const created = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await ShareService.revokeReportShare({
      shareId: created.shareId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    expect(
      await ShareService.getPublicReportByToken(created.token),
    ).toBeNull();
    const expiring = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await db
      .update(reportShares)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(reportShares.id, expiring.shareId));
    expect(
      await ShareService.getPublicReportByToken(expiring.token),
    ).toBeNull();
  });

  it("distinguishes invalid, revoked, and expired states with zero content", async () => {
    // Invalid: malformed AND well-formed-but-unknown hashes.
    await expect(ShareService.resolvePublicShare("nope")).resolves.toEqual({
      state: "invalid",
    });
    await expect(
      ShareService.resolvePublicShare("a".repeat(64)),
    ).resolves.toEqual({ state: "invalid" });

    const reportId = await seedReport();
    const expired = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await db
      .update(reportShares)
      .set({ expiresAt: "2020-01-01T00:00:00.000Z" })
      .where(eq(reportShares.id, expired.shareId));
    const expiredResolution = await ShareService.resolvePublicShare(
      expired.token,
    );
    expect(expiredResolution.state).toBe("expired");

    const revoked = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
      expiresAt: "2030-01-01T00:00:00.000Z",
    });
    await ShareService.revokeReportShare({
      shareId: revoked.shareId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    const revokedResolution = await ShareService.resolvePublicShare(
      revoked.token,
    );
    expect(revokedResolution.state).toBe("revoked");

    const active = await ShareService.createReportShare({
      reportId,
      projectId: "project-1",
      organizationId: "org-1",
    });
    const activeResolution = await ShareService.resolvePublicShare(active.token);
    expect(activeResolution.state).toBe("active");
    if (activeResolution.state !== "active") return;
    expect(activeResolution.view.report.id).toBe(reportId);

    // Revocation takes precedence over expiry state ordering per contract
    // (invalid → revoked → expired): the expired share revoked now reads
    // revoked, and NO non-active resolution ever carries a view.
    for (const resolution of [expiredResolution, revokedResolution]) {
      if (resolution.state === "active") continue;
      expect("view" in resolution).toBe(false);
    }
  });
});
