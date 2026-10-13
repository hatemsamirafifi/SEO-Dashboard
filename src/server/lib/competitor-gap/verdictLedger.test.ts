// Spec 014 US1 tests (T009/T010): deterministic verdict evaluation + the
// append-only verdict ledger. In-memory libsql with the full migration
// journal (autopilotTestDb pattern) so `competitor_gap_verdicts` exists with
// real constraints. No provider access — evidence fixtures are pinned.

import type { Client } from "@libsql/client";
import { beforeAll, describe, expect, it, vi } from "vitest";

const database = vi.hoisted(() => ({
  client: null as Client | null,
  db: null as unknown,
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", async () => {
  const [{ createClient: makeClient }, { drizzle }, schema] =
    await Promise.all([
      import("@libsql/client"),
      import("drizzle-orm/libsql"),
      import("@/db/schema"),
    ]);
  database.client = makeClient({ url: "file::memory:" });
  database.db = drizzle(database.client, { schema });
  return {
    db: database.db,
    withPgClient: async (fn: () => Promise<unknown>) => fn(),
  };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => unknown[]) => {
    if (!database.db) throw new Error("Test database was not initialized");
    for (const statement of build(database.db)) await statement;
  },
  executeInBatches: async () => {
    throw new Error("not used in these tests");
  },
}));

import {
  competitorGapGateState,
  evaluateVerdict,
  latestVerdict,
  recordVerdict,
} from "./verdictLedger";
import type {
  CompetitorGapSpikeEvidence,
  CompetitorGapSpikeManifest,
  CompetitorGapSpikeThresholds,
} from "@/shared/competitorGap";

// Full-migration harness (mirrors autopilotTestDb): every journal entry is
// applied so FK targets and the verdict table exist.

const THRESHOLDS: CompetitorGapSpikeThresholds = {
  minKeywordCoverageRatio: 0.5,
  minFirstPartyCoverageRatio: 0.5,
  maxCostPerAnalysisCredits: 100,
  repeatCacheHitRate: 1.0,
  identityCollisionsAllowed: 0,
};

const MANIFEST: CompetitorGapSpikeManifest = {
  organizationId: "org-1",
  projectId: "project-1",
  sampleDomains: ["competitor-a.com", "competitor-b.com"],
  keywordSetRef: "kw-set-1",
  market: { locationCode: 2840, languageCode: "en" },
  budgetCapCredits: 500,
  timeBoxHours: 4,
  thresholds: THRESHOLDS,
};

/** All-measured, all-passing evidence. */
function passingEvidence(): CompetitorGapSpikeEvidence {
  return {
    quality: {
      status: "measured",
      value: { keywordCoverageRatio: 0.9, requiredFieldMissingRate: 0.01 },
    },
    coverage: {
      status: "measured",
      value: {
        firstPartyCoverageRatio: 0.9,
        window: { from: "2026-09-11", to: "2026-10-09" },
      },
    },
    cost: {
      status: "measured",
      value: { measuredCreditsPerAnalysis: 50, extrapolatedMonthlyPerProject: 200 },
    },
    identity: {
      status: "measured",
      value: { collisionsObserved: 0, nonDeterministicMappings: 0 },
    },
    cache: {
      status: "measured",
      value: { repeatAnalysisPaidCalls: 0, repeatCacheHitRate: 1 },
    },
  };
}

/** Flip exactly one field inside an evidence dimension. */
function patchEvidence(
  evidence: CompetitorGapSpikeEvidence,
  dimension: keyof CompetitorGapSpikeEvidence,
  patch: Record<string, number>,
): CompetitorGapSpikeEvidence {
  const dimensionResult = evidence[dimension];
  if (dimensionResult.status !== "measured") {
    throw new Error("fixture must be measured");
  }
  return {
    ...evidence,
    [dimension]: {
      status: "measured",
      value: { ...dimensionResult.value, ...patch },
    },
  };
}

function unavailableEvidence(
  dimension: keyof CompetitorGapSpikeEvidence,
  reason: string,
): CompetitorGapSpikeEvidence {
  return { ...passingEvidence(), [dimension]: { status: "unavailable", reason } };
}

/** Validate the drizzle journal shape without a narrowing cast. */
function journalEntries(journal: unknown): Array<{ tag: string }> {
  if (typeof journal !== "object" || journal === null) {
    throw new Error("Migration journal has an unexpected shape");
  }
  if (!("entries" in journal)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  const entries: unknown = journal.entries;
  if (!Array.isArray(entries)) {
    throw new Error("Migration journal has an unexpected shape");
  }
  return entries.map((entry: unknown) => {
    if (typeof entry !== "object" || entry === null) {
      throw new Error("Migration journal has an unexpected shape");
    }
    if (!("tag" in entry) || typeof entry.tag !== "string") {
      throw new Error("Migration journal has an unexpected shape");
    }
    return { tag: entry.tag };
  });
}

/** Migrate + seed the client the @/db mock factory created (one shared
 *  in-memory database — the module under test and the raw-client assertions
 *  both hit it). */
async function setupTestDb(): Promise<void> {
  const client = database.client;
  if (!client) throw new Error("Test client was not initialized");
  await client.execute("PRAGMA foreign_keys = OFF");
  const journal: unknown = JSON.parse(
    (await import("node:fs")).readFileSync(
      "drizzle/meta/_journal.json",
      "utf8",
    ),
  );
  const nodeFs = await import("node:fs");
  const nodePath = await import("node:path");
  for (const entry of journalEntries(journal)) {
    const withoutBlocks = nodeFs.readFileSync(
      nodePath.resolve(process.cwd(), `drizzle/${entry.tag}.sql`),
      "utf8",
    ).replace(/\/\*[\s\S]*?\*\//g, "");
    const statements = withoutBlocks
      .split("--> statement-breakpoint")
      .map((part) => part.replace(/--[^\n]*(\n|$)/g, "\n").trim())
      .filter(Boolean);
    for (const statement of statements) {
      await client.execute(statement);
    }
  }
  await client.execute(
    `CREATE TABLE IF NOT EXISTS projects (
       id TEXT PRIMARY KEY NOT NULL,
       organization_id TEXT NOT NULL,
       name TEXT NOT NULL
     )`,
  );
  await client.execute("PRAGMA foreign_keys = ON");
  await client.execute(
    "DELETE FROM competitor_gap_verdicts",
  );
  await client.execute(
    "INSERT OR IGNORE INTO organization (id, name, slug, created_at) VALUES ('org-1', 'Org', 'org', 0)",
  );
  await client.execute(
    "INSERT OR IGNORE INTO projects (id, organization_id, name) VALUES ('project-1', 'org-1', 'Test')",
  );
}

describe("evaluateVerdict (T009 — deterministic evaluation)", () => {
  it("returns READY when every dimension passes every threshold", () => {
    const verdict = evaluateVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
    });
    expect(verdict).toBe("COMPETITOR_GAP_READY");
  });

  it("boundary equality passes (strict < and > only)", () => {
    const atBoundary = patchEvidence(passingEvidence(), "quality", {
      keywordCoverageRatio: THRESHOLDS.minKeywordCoverageRatio,
    });
    expect(
      evaluateVerdict({ evidence: atBoundary, thresholds: THRESHOLDS }),
    ).toBe("COMPETITOR_GAP_READY");
  });

  it("BLOCKED when identity collisions exceed the allowance", () => {
    const evidence = patchEvidence(passingEvidence(), "identity", {
      collisionsObserved: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when identity is non-deterministic at all", () => {
    const evidence = patchEvidence(passingEvidence(), "identity", {
      nonDeterministicMappings: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when repeat cache hit rate is below the required rate", () => {
    const evidence = patchEvidence(passingEvidence(), "cache", {
      repeatCacheHitRate: 0.5,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when the repeat analysis made any paid calls", () => {
    const evidence = patchEvidence(passingEvidence(), "cache", {
      repeatAnalysisPaidCalls: 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when measured credits exceed the cap", () => {
    const evidence = patchEvidence(passingEvidence(), "cost", {
      measuredCreditsPerAnalysis: THRESHOLDS.maxCostPerAnalysisCredits + 1,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when keyword coverage is below the minimum", () => {
    const evidence = patchEvidence(passingEvidence(), "quality", {
      keywordCoverageRatio: THRESHOLDS.minKeywordCoverageRatio - 0.01,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when first-party coverage is below the minimum", () => {
    const evidence = patchEvidence(passingEvidence(), "coverage", {
      firstPartyCoverageRatio: THRESHOLDS.minFirstPartyCoverageRatio - 0.01,
    });
    expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
      "COMPETITOR_GAP_BLOCKED",
    );
  });

  it("BLOCKED when ANY dimension is unavailable — failure is never data (P8/P9)", () => {
    for (const dimension of [
      "quality",
      "coverage",
      "cost",
      "identity",
      "cache",
    ] as const) {
      const evidence = unavailableEvidence(
        dimension,
        "provider failure during measurement",
      );
      expect(evaluateVerdict({ evidence, thresholds: THRESHOLDS })).toBe(
        "COMPETITOR_GAP_BLOCKED",
      );
    }
  });
});

describe("verdict ledger (T010 — append-only persistence + gate)", () => {
  beforeAll(async () => {
    await setupTestDb();
  });

  it("recordVerdict appends exactly one row with the evaluated verdict", async () => {
    const row = await recordVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
      manifest: MANIFEST,
      recordedAt: "2026-10-09T00:00:00.000Z",
    });

    expect(row.verdict).toBe("COMPETITOR_GAP_READY");
    const latest = await latestVerdict({
      organizationId: MANIFEST.organizationId,
      projectId: MANIFEST.projectId,
    });
    expect(latest?.id).toBe(row.id);
    expect(latest?.verdict).toBe("COMPETITOR_GAP_READY");
    expect(latest?.inputManifest).toEqual(MANIFEST);
    expect(latest?.thresholds).toEqual(THRESHOLDS);
  });

  it("re-running the same manifest appends a new row without mutating the first (FR-003)", async () => {
    const first = await recordVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
      manifest: MANIFEST,
      recordedAt: "2026-10-09T00:10:00.000Z",
    });
    const second = await recordVerdict({
      evidence: unavailableEvidence("cost", "provider failure"),
      thresholds: THRESHOLDS,
      manifest: MANIFEST,
      recordedAt: "2026-10-09T01:00:00.000Z",
    });

    expect(second.id).not.toBe(first.id);
    const firstStill = await latestVerdict({
      organizationId: MANIFEST.organizationId,
      projectId: MANIFEST.projectId,
    });
    // Latest wins: the second (later recordedAt) row is authoritative.
    expect(firstStill?.id).toBe(second.id);

    const client = database.client;
    if (!client) throw new Error("no client");
    // Rows for THIS manifest's scope only (the shared table also carries
    // other tests' scoped rows).
    const all = await client.execute({
      sql: "SELECT id, verdict FROM competitor_gap_verdicts WHERE project_id = ? ORDER BY recorded_at",
      args: [MANIFEST.projectId],
    });
    const ids = all.rows.map((row) => row.id);
    expect(ids).toContain(first.id);
    expect(ids).toContain(second.id);
  });

  it("latestVerdict is project-scoped — no cross-project leakage (P39)", async () => {
    await recordVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
      manifest: MANIFEST,
      recordedAt: "2026-10-09T00:20:00.000Z",
    });

    const otherProject = await latestVerdict({
      organizationId: MANIFEST.organizationId,
      projectId: "project-other",
    });
    expect(otherProject).toBeNull();

    const otherOrg = await latestVerdict({
      organizationId: "org-other",
      projectId: MANIFEST.projectId,
    });
    expect(otherOrg).toBeNull();
  });

  it("corrupt JSON evidence reads as a miss, never a fake verdict", async () => {
    const client = database.client;
    if (!client) throw new Error("no client");
    // Insert a corrupt row with the NEWEST recorded_at so latestVerdict
    // selects it — and must then reject it (miss), never return a fake READY.
    await client.execute(
      `INSERT INTO competitor_gap_verdicts
         (id, organization_id, project_id, verdict, evidence, thresholds, input_manifest, recorded_at)
       VALUES ('corrupt', 'org-1', 'project-1', 'COMPETITOR_GAP_READY',
               '{not json', '{}', '{}', '2026-10-09T23:00:00.000Z')`,
    );
    const latest = await latestVerdict({
      organizationId: "org-1",
      projectId: "project-1",
    });
    expect(latest).toBeNull();
  });

  it("gate state maps NO_VERDICT / BLOCKED / READY per the runtime gate contract", async () => {
    // A project with no spike rows at all: NO_VERDICT.
    const noVerdict = await competitorGapGateState({
      organizationId: MANIFEST.organizationId,
      projectId: "project-fresh",
    });
    expect(noVerdict.state).toBe("NO_VERDICT");
    expect(noVerdict.verdictRow).toBeNull();

    // First spike for a scoped project: BLOCKED. (project-gate is seeded to
    // satisfy the project FK — FKs are ON in this harness.)
    const scoped: CompetitorGapSpikeManifest = {
      ...MANIFEST,
      projectId: "project-gate",
    };
    const client = database.client;
    if (!client) throw new Error("no client");
    await client.execute(
      "INSERT OR IGNORE INTO projects (id, organization_id, name) VALUES ('project-gate', 'org-1', 'Gate')",
    );
    await recordVerdict({
      evidence: unavailableEvidence("cache", "repeat fetch failed"),
      thresholds: THRESHOLDS,
      manifest: scoped,
      recordedAt: "2026-10-09T00:00:00.000Z",
    });
    const blocked = await competitorGapGateState({
      organizationId: scoped.organizationId,
      projectId: scoped.projectId,
    });
    expect(blocked.state).toBe("BLOCKED");
    expect(blocked.verdictRow?.verdict).toBe("COMPETITOR_GAP_BLOCKED");

    // A later READY row for the same scope opens the gate.
    await recordVerdict({
      evidence: passingEvidence(),
      thresholds: THRESHOLDS,
      manifest: scoped,
      recordedAt: "2026-10-09T02:00:00.000Z",
    });
    const ready = await competitorGapGateState({
      organizationId: scoped.organizationId,
      projectId: scoped.projectId,
    });
    expect(ready.state).toBe("READY");
    expect(ready.verdictRow?.verdict).toBe("COMPETITOR_GAP_READY");
  });
});