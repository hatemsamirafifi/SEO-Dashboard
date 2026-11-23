import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));

import {
  confirmSelectiveSeRankingSync,
  previewSelectiveSeRankingSync,
  type SelectiveSyncStore,
  type SelectiveSyncTransport,
  type SeRankingSelectiveSyncDeps,
} from "./seRankingSelectiveSyncService";
import { SeRankingRateLimitError } from "@/server/lib/seranking/errors";
import { AppError } from "@/server/lib/errors";
import type { ProjectApiAccessReport } from "@/server/lib/seranking/projectAccess";
import type {
  SeRankingProjectKeyword,
  SeRankingSiteEngine,
} from "@/server/lib/seranking";

const SITE_ID = 13188608;
const DESKTOP = 539194;
const MOBILE = 545914;
const THIRD_ENGINE = 999888;
const KEYWORD_LIMIT = 1000;

interface RemoteKeywordState {
  id: string;
  keyword: string;
  engines: number[];
}

interface HarnessOptions {
  configFound?: boolean;
  configDevices?: "desktop" | "mobile" | "both";
  accountActive?: boolean;
  projectBindingFound?: boolean;
  keywords?: Array<{ id: string; keyword: string }>;
  assignments?: Record<string, string[]>;
  mappings?: Array<{
    id: string;
    trackingKeywordId: string;
    remoteKeywordId: string;
    status: string;
    createdAt: string;
  }>;
  remote?: RemoteKeywordState[];
  remoteEngines?: number[];
  failEngineListingFor?: number[];
  failFullListing?: boolean;
  failAddAfterCommit?: boolean;
  failAddBeforeCommit?: boolean;
  failUpdateFor?: string[];
  quotaRemaining?: number;
  quotaBlocked?: boolean;
}

interface Harness {
  deps: SeRankingSelectiveSyncDeps;
  store: SelectiveSyncStore & {
    mappingWrites: unknown[];
    mappings: FixtureMapping[];
  };
  transport: SelectiveSyncTransport & {
    calls: Array<{ method: string; detail: string }>;
    addKeywordsCalls: number;
    updateKeywordCalls: number;
    remote: RemoteKeywordState[];
  };
  /** Mutable failure injection: tests flip these between confirm calls. */
  behavior: {
    failUpdateFor?: string[];
  };
}

type FixtureMapping = HarnessOptions["mappings"] extends (infer T)[] | undefined
  ? T
  : never;

function makeHarness(options: HarnessOptions = {}): Harness {
  const keywords = options.keywords ?? [];
  const assignments = options.assignments ?? {};
  const mappings: FixtureMapping[] = [...(options.mappings ?? [])];
  const mappingWrites: unknown[] = [];
  const remote: RemoteKeywordState[] = [...(options.remote ?? [])];
  const remoteEngines = options.remoteEngines ?? [DESKTOP, MOBILE];
  let nextRemoteId = 5000;

  const store: SelectiveSyncStore & {
    mappingWrites: unknown[];
    mappings: FixtureMapping[];
  } = {
    mappingWrites,
    mappings,
    async getConfig(configId) {
      if (options.configFound === false) return null;
      return {
        id: configId,
        domain: "sports-ms.com",
        devices: options.configDevices ?? "both",
      };
    },
    async getLocalKeywords() {
      return keywords;
    },
    async getTargets() {
      return [
        { id: "target-desktop", device: "desktop" },
        { id: "target-mobile", device: "mobile" },
      ];
    },
    async getKeywordTargetAssignments() {
      return assignments;
    },
    async getProjectBinding() {
      return options.projectBindingFound === false
        ? null
        : {
            id: "binding-1",
            remoteSiteId: SITE_ID,
            status: "connected",
            lastSuccessfulSync: "2026-11-20T00:00:00Z",
          };
    },
    async getEngineBindings() {
      return [
        { trackingTargetId: "target-desktop", remoteSiteEngineId: DESKTOP },
        { trackingTargetId: "target-mobile", remoteSiteEngineId: MOBILE },
      ];
    },
    async getKeywordMappings() {
      return mappings.map((m) => ({ ...m }));
    },
    async upsertKeywordMappings(rows) {
      mappingWrites.push(rows);
      for (const row of rows) {
        const existing = mappings.find(
          (m) => m.trackingKeywordId === row.trackingKeywordId,
        );
        if (existing) {
          existing.remoteKeywordId = row.remoteKeywordId;
          existing.status = row.status;
        } else {
          mappings.push({
            id: row.id,
            trackingKeywordId: row.trackingKeywordId,
            remoteKeywordId: row.remoteKeywordId,
            status: row.status,
            createdAt: row.createdAt,
          });
        }
      }
    },
  };

  const calls: Array<{ method: string; detail: string }> = [];
  let addKeywordsCalls = 0;
  let updateKeywordCalls = 0;
  const behavior = { failUpdateFor: options.failUpdateFor };

  const transport: SelectiveSyncTransport & {
    calls: typeof calls;
    addKeywordsCalls: number;
    updateKeywordCalls: number;
    remote: RemoteKeywordState[];
  } = {
    calls,
    addKeywordsCalls: 0,
    updateKeywordCalls: 0,
    remote,
    async validateAccessAndQuota() {
      calls.push({ method: "quota", detail: "validateAccessAndQuota" });
      const used = remote.length;
      const remaining =
        options.quotaRemaining ?? Math.max(0, KEYWORD_LIMIT - used);
      const report = {
        sites: [
          {
            id: SITE_ID,
            title: "sports-ms.com",
            url: "sports-ms.com",
            depth: 100,
            keywordCount: used,
            checkFrequency: "manual",
            status: "active",
          },
        ],
        apiAuth: { status: "ok", source: "sites_list" },
        projectApi: { accessible: true, status: "ok" },
        projectSubscription: { status: "active" },
        projectCapacity: {
          status: "ok",
          limit: KEYWORD_LIMIT,
          used,
          remaining,
          source: "provider_reported",
        },
        trackedKeywordCapacity: {
          status: options.quotaBlocked
            ? "blocked"
            : remaining <= 0
              ? "blocked"
              : "ok",
          limit: KEYWORD_LIMIT,
          used,
          remaining,
          source: "provider_reported",
        },
        deviceLocationAllocations: {
          status: "ok",
          verifiedEngineCount: remoteEngines.length,
        },
        recheckRestrictions: { status: "unknown" },
      };
      return report as ProjectApiAccessReport;
    },
    async listKeywords() {
      calls.push({ method: "listKeywords", detail: "full" });
      if (options.failFullListing) throw new Error("upstream read failure");
      return remote.map<SeRankingProjectKeyword>((k) => ({
        id: k.id,
        keyword: k.keyword,
        siteEngineIds: [...k.engines],
      }));
    },
    async listKeywordsForEngine(_siteId, engineId) {
      calls.push({
        method: "listKeywordsForEngine",
        detail: String(engineId),
      });
      if (options.failEngineListingFor?.includes(engineId)) {
        throw new Error("engine listing failed");
      }
      return remote
        .filter((k) => k.engines.includes(engineId))
        .map<SeRankingProjectKeyword>((k) => ({
          id: k.id,
          keyword: k.keyword,
          siteEngineIds: [...k.engines],
        }));
    },
    async listSiteSearchEngines() {
      calls.push({ method: "listSiteSearchEngines", detail: "engines" });
      return remoteEngines.map<SeRankingSiteEngine>((id) => ({
        siteEngineId: id,
        searchEngineId: 481,
        name: `Engine ${id}`,
        regionId: 0,
        regionName: "",
        langCode: "ar",
        device: id === MOBILE ? "mobile" : "desktop",
      }));
    },
    async addKeywordsOnce(_siteId, batch) {
      addKeywordsCalls++;
      transport.addKeywordsCalls = addKeywordsCalls;
      calls.push({
        method: "addKeywordsOnce",
        detail: batch.map((k) => k.keyword).join("|"),
      });
      if (options.failAddBeforeCommit) {
        throw new SeRankingRateLimitError("429 too many requests");
      }
      const ids: string[] = [];
      for (const kw of batch) {
        const id = String(nextRemoteId++);
        remote.push({
          id,
          keyword: kw.keyword,
          engines: [...kw.siteEngineIds],
        });
        ids.push(id);
      }
      if (options.failAddAfterCommit) {
        // Simulates a committed write whose response was lost (timeout).
        throw new Error("SE Ranking request timed out after 30000ms");
      }
      return { ok: true, added: batch.length, ids };
    },
    async updateKeyword(params) {
      updateKeywordCalls++;
      transport.updateKeywordCalls = updateKeywordCalls;
      calls.push({
        method: "updateKeyword",
        detail: `${params.keywordId}: [${params.siteEngineIds.join(",")}]`,
      });
      if (behavior.failUpdateFor?.includes(params.keywordId)) {
        throw new SeRankingRateLimitError("429 too many requests");
      }
      const target = remote.find((k) => k.id === params.keywordId);
      if (target) {
        target.engines = [
          ...new Set([...target.engines, ...params.siteEngineIds]),
        ].toSorted((a, b) => a - b);
      }
    },
  };

  const deps: SeRankingSelectiveSyncDeps = {
    store,
    resolveAccount: async () => ({
      status: options.accountActive === false ? "account_inactive" : "linked",
      accountBindingId: "account-1",
      apiKey: "test-key",
    }),
    makeTransport: () => transport,
  };

  return { deps, store, transport, behavior };
}

const BASE = {
  organizationId: "org-1",
  projectId: "proj-1",
  configId: "cfg-1",
};

const ARABIC_SYNCED = "إنشاء ملاعب كرة قدم";
const ARABIC_SYNCED_VARIANT = "  إنشاء ملاعب كرة قدم  "; // whitespace differs
const ARABIC_DISTINCT = "انشاء ملاعب كرة قدم"; // no hamza: distinct keyword

describe("Selective SE Ranking sync — preview", () => {
  it("is strictly read-only: no POST/PATCH and no local writes", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: ARABIC_SYNCED }],
      remote: [
        { id: "r1", keyword: ARABIC_SYNCED, engines: [DESKTOP, MOBILE] },
      ],
      mappings: [],
    });

    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, keywordIds: ["kw-1"] },
      h.deps,
    );

    expect(preview.linked).toBe(true);
    expect(preview.selectedCount).toBe(1);
    expect(
      h.transport.calls.filter((c) => c.method === "addKeywordsOnce"),
    ).toHaveLength(0);
    expect(
      h.transport.calls.filter((c) => c.method === "updateKeyword"),
    ).toHaveLength(0);
    expect(h.store.mappingWrites).toHaveLength(0);
    expect(h.store.mappings).toHaveLength(0);
  });

  it("reports remote project, counts, quota warnings and approved set", async () => {
    const h = makeHarness({
      keywords: [
        { id: "kw-1", keyword: ARABIC_SYNCED },
        { id: "kw-2", keyword: "brand new keyword" },
      ],
      remote: [
        { id: "r1", keyword: ARABIC_SYNCED, engines: [DESKTOP, MOBILE] },
      ],
      mappings: [
        {
          id: "m1",
          trackingKeywordId: "kw-1",
          remoteKeywordId: "r1",
          status: "synced",
          createdAt: "2026-11-01T00:00:00Z",
        },
      ],
      quotaRemaining: 1,
    });

    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, syncAllMissing: true },
      h.deps,
    );

    expect(preview.remoteProject).toEqual({
      siteId: SITE_ID,
      title: "sports-ms.com",
    });
    expect(preview.counts?.selected).toBe(2);
    expect(preview.counts?.alreadyRemote).toBe(1);
    expect(preview.counts?.alreadyMappedLocally).toBe(1);
    expect(preview.counts?.missingRemote).toBe(1);
    expect(preview.counts?.fullySynced).toBe(1);
    expect(preview.approvedKeywordIds).toEqual(["kw-2"]);
    // 2 engine slots for the new keyword exceed the reported remaining 1.
    expect(
      preview.quota?.warnings.some((w) => w.includes("exceed the reported")),
    ).toBe(true);
  });

  it("returns linked:false without a binding instead of throwing", async () => {
    const h = makeHarness({ projectBindingFound: false });
    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, syncAllMissing: true },
      h.deps,
    );
    expect(preview.linked).toBe(false);
    expect(preview.reason).toContain("not linked");
  });

  it("fails closed with unknown statuses when the inventory cannot be read", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "x" }],
      failFullListing: true,
    });
    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, keywordIds: ["kw-1"] },
      h.deps,
    );
    expect(preview.linked).toBe(true);
    expect(preview.inventory?.status).toBe("unknown");
    expect(preview.counts?.unknown).toBe(1);
    expect(preview.approvedKeywordIds).toEqual([]); // nothing actionable
  });

  it("rejects a preview with no scope", async () => {
    const h = makeHarness();
    await expect(
      previewSelectiveSeRankingSync({ ...BASE }, h.deps),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });

  it("is tenant isolated: a config outside the project is not found", async () => {
    const h = makeHarness({ configFound: false });
    await expect(
      previewSelectiveSeRankingSync({ ...BASE, syncAllMissing: true }, h.deps),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(h.transport.calls).toHaveLength(0);
  });
});

describe("Selective SE Ranking sync — confirmation scope", () => {
  it("uploads only the selected keywords, never the rest of the config", async () => {
    const h = makeHarness({
      keywords: [
        { id: "kw-a", keyword: "selected one" },
        { id: "kw-b", keyword: "selected two" },
        { id: "kw-c", keyword: "NOT selected" },
      ],
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-a", "kw-b"],
        approvedKeywordIds: ["kw-a", "kw-b"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.ok).toBe(true);
    expect(result.addedCount).toBe(2);
    expect(result.addedKeywordIds).toContain("kw-a");
    expect(result.addedKeywordIds).toContain("kw-b");
    expect(result.addedKeywordIds).not.toContain("kw-c");
    expect(h.transport.remote.map((k) => k.keyword)).toEqual(
      expect.arrayContaining(["selected one", "selected two"]),
    );
    expect(h.transport.remote.some((k) => k.keyword === "NOT selected")).toBe(
      false,
    );
  });

  it("uploads one canonical Arabic identity and maps both selected rows", async () => {
    const keyword = "إنشاء ملاعب";
    const h = makeHarness({
      keywords: [
        { id: "a", keyword },
        { id: "b", keyword: keyword.normalize("NFD") },
      ],
      assignments: { a: ["target-desktop"], b: ["target-mobile"] },
    });
    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, keywordIds: ["a", "b"] },
      h.deps,
    );
    expect(preview.counts).toMatchObject({
      missingDesktopAssignments: 1,
      missingMobileAssignments: 1,
      estimatedAdditionalEngineSlots: 2,
    });
    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["a", "b"],
        approvedKeywordIds: ["a", "b"],
        engineMode: "assignments",
      },
      h.deps,
    );
    expect(result.addedCount).toBe(1);
    expect(h.transport.remote).toMatchObject([
      { keyword, engines: [DESKTOP, MOBILE] },
    ]);
    expect(h.store.mappings.map((m) => m.remoteKeywordId)).toEqual([
      h.transport.remote[0].id,
      h.transport.remote[0].id,
    ]);
  });

  it("requires a fresh preview when an approved engine changes", async () => {
    const h = makeHarness({ keywords: [{ id: "a", keyword: "padel" }] });
    await expect(
      confirmSelectiveSeRankingSync(
        {
          ...BASE,
          keywordIds: ["a"],
          approvedKeywordIds: ["a"],
          engineMode: "both",
          expectedSiteId: SITE_ID,
          expectedKeywords: {
            a: { engineIds: [DESKTOP], remoteKeywordId: null },
          },
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(h.transport.remote).toEqual([]);
    expect(h.store.mappings).toEqual([]);
  });

  it("confirms only the approved (displayed) set even for sync-all scope", async () => {
    const h = makeHarness({
      keywords: [
        { id: "kw-a", keyword: "missing one" },
        { id: "kw-b", keyword: "missing two" },
        { id: "kw-c", keyword: "missing three" },
      ],
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        syncAllMissing: true,
        // The user saw and approved only two of the three missing keywords.
        approvedKeywordIds: ["kw-a", "kw-b"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.addedCount).toBe(2);
    expect(h.transport.remote.some((k) => k.keyword === "missing three")).toBe(
      false,
    );
  });

  it("reports locally deleted keywords as stale instead of syncing them", async () => {
    const h = makeHarness({ keywords: [{ id: "kw-a", keyword: "kept" }] });
    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-a", "kw-deleted"],
        approvedKeywordIds: ["kw-a", "kw-deleted"],
        engineMode: "both",
      },
      h.deps,
    );
    expect(result.staleApprovedKeywordIds).toEqual(["kw-deleted"]);
    expect(result.addedCount).toBe(1);
  });
});

describe("Selective SE Ranking sync — identity and duplicates", () => {
  it("matches Arabic keywords by exact normalized identity and does not re-add them", async () => {
    const h = makeHarness({
      keywords: [
        { id: "kw-1", keyword: ARABIC_SYNCED_VARIANT },
        { id: "kw-2", keyword: ARABIC_DISTINCT },
      ],
      remote: [
        { id: "r1", keyword: ARABIC_SYNCED, engines: [DESKTOP, MOBILE] },
      ],
      assignments: {},
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1", "kw-2"],
        approvedKeywordIds: ["kw-1", "kw-2"],
        engineMode: "both",
      },
      h.deps,
    );

    // kw-1 matched the existing remote keyword (trim/NFC identity) and only
    // had its mapping repaired; kw-2 (no hamza) is distinct and was added.
    expect(result.addedCount).toBe(1);
    expect(result.addedKeywordIds).toEqual(["kw-2"]);
    expect(result.mappingsRepairedCount).toBe(1);
    expect(
      h.transport.remote.filter((k) => k.keyword === ARABIC_SYNCED).length,
    ).toBe(1);
    expect(h.transport.remote.some((k) => k.keyword === ARABIC_DISTINCT)).toBe(
      true,
    );
  });

  it("prevents duplicate uploads when confirming twice", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "first run" }],
    });

    const first = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );
    expect(first.addedCount).toBe(1);

    const second = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );
    expect(second.addedCount).toBe(0);
    expect(second.skippedExistingCount).toBe(1);
    expect(h.transport.addKeywordsCalls).toBe(1);
    expect(h.transport.remote).toHaveLength(1);
  });

  it("blocks concurrent confirmations for the same project binding", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "slow keyword" }],
      // The remote listing stalls so the first confirm stays in flight.
      remote: [],
    });
    const listing: { release: () => void } = {
      release: () => {
        throw new Error("Listing gate was not initialized");
      },
    };
    const listingGate = new Promise<void>((resolve) => {
      listing.release = resolve;
    });
    let listingStarted = false;
    const originalList = h.transport.listKeywords.bind(h.transport);
    h.transport.listKeywords = async (siteId) => {
      if (!listingStarted) {
        listingStarted = true;
        await listingGate;
      }
      return originalList(siteId);
    };

    const first = confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    await expect(
      confirmSelectiveSeRankingSync(
        {
          ...BASE,
          keywordIds: ["kw-1"],
          approvedKeywordIds: ["kw-1"],
          engineMode: "both",
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    listing.release();
    const result = await first;
    expect(result.addedCount).toBe(1);
    expect(h.transport.addKeywordsCalls).toBe(1);
  });
});

describe("Selective SE Ranking sync — engine assignments", () => {
  it("adds new keywords with explicit desktop and mobile engine ids", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "new keyword" }],
    });

    await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    const addedCall = h.transport.calls.find(
      (c) => c.method === "addKeywordsOnce",
    );
    expect(addedCall).toBeDefined();
    expect(h.transport.remote[0].engines).toEqual([DESKTOP, MOBILE]);
  });

  it("respects per-keyword target assignments in the default mode", async () => {
    const h = makeHarness({
      keywords: [
        { id: "kw-desk", keyword: "desktop only keyword" },
        { id: "kw-unassigned", keyword: "unassigned keyword" },
      ],
      assignments: {
        "kw-desk": ["target-desktop"],
      },
      configDevices: "both",
    });

    await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-desk", "kw-unassigned"],
        approvedKeywordIds: ["kw-desk", "kw-unassigned"],
        engineMode: "assignments",
      },
      h.deps,
    );

    const byKeyword = new Map(h.transport.remote.map((k) => [k.keyword, k]));
    expect(byKeyword.get("desktop only keyword")?.engines).toEqual([DESKTOP]);
    // Unassigned keywords use the config's explicit device choice (both).
    expect(byKeyword.get("unassigned keyword")?.engines).toEqual([
      DESKTOP,
      MOBILE,
    ]);
  });

  it("patches existing keywords with a union that preserves a third unrelated engine", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "existing keyword" }],
      remote: [
        {
          id: "r1",
          keyword: "existing keyword",
          engines: [DESKTOP, THIRD_ENGINE],
        },
      ],
      remoteEngines: [DESKTOP, MOBILE, THIRD_ENGINE],
      mappings: [
        {
          id: "m1",
          trackingKeywordId: "kw-1",
          remoteKeywordId: "r1",
          status: "synced",
          createdAt: "2026-11-01T00:00:00Z",
        },
      ],
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.engineAssignmentsUpdatedCount).toBe(1);
    const patchCall = h.transport.calls.find(
      (c) => c.method === "updateKeyword",
    );
    expect(patchCall?.detail).toBe(
      `r1: [${[DESKTOP, MOBILE, THIRD_ENGINE].join(",")}]`,
    );
    expect(h.transport.remote[0].engines).toEqual([
      DESKTOP,
      MOBILE,
      THIRD_ENGINE,
    ]);
    expect(result.failed).toHaveLength(0);
  });

  it("never patches when engine membership could not be fully verified", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "existing keyword" }],
      remote: [{ id: "r1", keyword: "existing keyword", engines: [DESKTOP] }],
      remoteEngines: [DESKTOP, MOBILE, THIRD_ENGINE],
      failEngineListingFor: [THIRD_ENGINE],
      mappings: [
        {
          id: "m1",
          trackingKeywordId: "kw-1",
          remoteKeywordId: "r1",
          status: "synced",
          createdAt: "2026-11-01T00:00:00Z",
        },
      ],
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.engineAssignmentsUpdatedCount).toBe(0);
    expect(h.transport.updateKeywordCalls).toBe(0);
    expect(result.blocked.length).toBe(1);
    // Mapping status stays honest: partially verified, not "synced".
    expect(h.store.mappings[0].status).toBe("partial");
  });
});

describe("Selective SE Ranking sync — reconciliation and recovery", () => {
  it("repairs the local mapping for an existing remote keyword without uploading", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "already remote" }],
      remote: [
        { id: "r9", keyword: "already remote", engines: [DESKTOP, MOBILE] },
      ],
      mappings: [],
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.addedCount).toBe(0);
    expect(h.transport.addKeywordsCalls).toBe(0);
    expect(result.mappingsRepairedCount + result.mappingsCreatedCount).toBe(1);
    expect(h.store.mappings[0]).toMatchObject({
      trackingKeywordId: "kw-1",
      remoteKeywordId: "r9",
      status: "synced",
    });
  });

  it("preserves progress when an engine PATCH fails and recovers on retry", async () => {
    // First keyword is fully addable; second keyword exists remotely but its
    // engine PATCH fails — the added keyword must not be rolled back.
    const h = makeHarness({
      keywords: [
        { id: "kw-new", keyword: "fresh keyword" },
        { id: "kw-old", keyword: "old keyword" },
      ],
      remote: [{ id: "r-old", keyword: "old keyword", engines: [DESKTOP] }],
      mappings: [
        {
          id: "m-old",
          trackingKeywordId: "kw-old",
          remoteKeywordId: "r-old",
          status: "synced",
          createdAt: "2026-11-01T00:00:00Z",
        },
      ],
      failUpdateFor: ["r-old"],
    });

    const first = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-new", "kw-old"],
        approvedKeywordIds: ["kw-new", "kw-old"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(first.addedCount).toBe(1);
    expect(first.engineAssignmentsUpdatedCount).toBe(0);
    expect(first.failed).toHaveLength(1);
    expect(first.failed[0].stage).toBe("engines");
    // The newly added keyword is mapped as synced despite the other failure.
    expect(
      h.store.mappings.find((m) => m.trackingKeywordId === "kw-new")?.status,
    ).toBe("synced");
    expect(
      h.store.mappings.find((m) => m.trackingKeywordId === "kw-old")?.status,
    ).toBe("partial");

    // Safe retry: no duplicate upload, the engine PATCH now succeeds.
    h.behavior.failUpdateFor = undefined;
    const second = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-new", "kw-old"],
        approvedKeywordIds: ["kw-new", "kw-old"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(second.addedCount).toBe(0); // already added — not duplicated
    expect(second.engineAssignmentsUpdatedCount).toBe(1);
    expect(second.failed).toHaveLength(0);
    expect(
      h.transport.remote.filter((k) => k.keyword === "fresh keyword").length,
    ).toBe(1);
  });
});

describe("Selective SE Ranking sync — provider failures", () => {
  it("does not replay a possibly committed POST via the generic retry loop", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "timeout keyword" }],
      failAddBeforeCommit: true,
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    expect(result.ok).toBe(false);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0].stage).toBe("add");
    // Single POST attempt — no blind retry.
    expect(h.transport.addKeywordsCalls).toBe(1);
    expect(result.finalStatuses["kw-1"]).toBe("failed");

    // A later retry (state now healthy) succeeds without duplicates.
    const second = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      { ...h.deps, makeTransport: () => makeHarness().transport },
    );
    expect(second.failed).toHaveLength(0);
    expect(second.finalStatuses["kw-1"]).toBe("synced");
  });

  it("recognizes a POST that committed despite a lost response", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "committed keyword" }],
      failAddAfterCommit: true,
    });

    const result = await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    // The fresh reconcile shows the keyword actually landed with engines.
    expect(result.addedCount).toBe(1);
    expect(result.failed).toHaveLength(0);
    expect(h.store.mappings[0]).toMatchObject({
      trackingKeywordId: "kw-1",
      status: "synced",
    });
    expect(h.transport.addKeywordsCalls).toBe(1);
  });

  it("aborts before upload when the provider reports blocked keyword capacity", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "over quota keyword" }],
      quotaBlocked: true,
      quotaRemaining: 0,
    });

    await expect(
      confirmSelectiveSeRankingSync(
        {
          ...BASE,
          keywordIds: ["kw-1"],
          approvedKeywordIds: ["kw-1"],
          engineMode: "both",
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "PAYMENT_REQUIRED" });

    expect(h.transport.addKeywordsCalls).toBe(0);
  });

  it("uploads nothing when the pre-write inventory is unreadable", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "x" }],
      failFullListing: true,
    });

    await expect(
      confirmSelectiveSeRankingSync(
        {
          ...BASE,
          keywordIds: ["kw-1"],
          approvedKeywordIds: ["kw-1"],
          engineMode: "both",
        },
        h.deps,
      ),
    ).rejects.toBeInstanceOf(Error);

    expect(h.transport.addKeywordsCalls).toBe(0);
    expect(h.store.mappingWrites).toHaveLength(0);
  });

  it("classifies quota validation failures as warnings, not hard preview errors", async () => {
    const h = makeHarness({ keywords: [{ id: "kw-1", keyword: "x" }] });
    const originalQuota = h.transport.validateAccessAndQuota.bind(h.transport);
    h.transport.validateAccessAndQuota = async () => {
      throw new AppError("UPSTREAM_UNAVAILABLE", "quota endpoint down");
    };
    void originalQuota;

    const preview = await previewSelectiveSeRankingSync(
      { ...BASE, keywordIds: ["kw-1"] },
      h.deps,
    );
    expect(preview.linked).toBe(true);
    expect(
      preview.quota?.warnings.some((w) => w.includes("could not be verified")),
    ).toBe(true);
  });
});

describe("Selective SE Ranking sync — safety invariants", () => {
  it("never touches recheck or positions endpoints", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "safety keyword" }],
      remote: [{ id: "r1", keyword: "existing remote", engines: [DESKTOP] }],
      mappings: [],
    });

    await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        syncAllMissing: true,
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    const paths = h.transport.calls.map((c) => c.method).join(" ");
    expect(paths).not.toContain("recheck");
    expect(paths).not.toContain("positions");
    expect(paths).not.toContain("getCheckDates");
  });

  it("only writes keyword mappings locally (historical data untouched)", async () => {
    const h = makeHarness({
      keywords: [{ id: "kw-1", keyword: "history keyword" }],
    });

    await confirmSelectiveSeRankingSync(
      {
        ...BASE,
        keywordIds: ["kw-1"],
        approvedKeywordIds: ["kw-1"],
        engineMode: "both",
      },
      h.deps,
    );

    // The only store write method available on the boundary is
    // upsertKeywordMappings; everything else is a read. No snapshot,
    // keyword, or config tables can be reached through this flow.
    expect(h.store.mappingWrites).toHaveLength(1);
    expect(h.store.mappings).toHaveLength(1);
  });

  it("rejects confirmation when the project is not linked", async () => {
    const h = makeHarness({ projectBindingFound: false });
    await expect(
      confirmSelectiveSeRankingSync(
        {
          ...BASE,
          keywordIds: ["kw-1"],
          approvedKeywordIds: ["kw-1"],
          engineMode: "both",
        },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
    expect(h.transport.addKeywordsCalls).toBe(0);
  });

  it("rejects confirmation with an empty approved set", async () => {
    const h = makeHarness();
    await expect(
      confirmSelectiveSeRankingSync(
        { ...BASE, approvedKeywordIds: [], engineMode: "both" },
        h.deps,
      ),
    ).rejects.toMatchObject({ code: "VALIDATION_ERROR" });
  });
});
