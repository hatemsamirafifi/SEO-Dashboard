import { describe, expect, it } from "vitest";
import {
  computeSelectiveSyncPlan,
  normalizeKeywordIdentity,
  resolveRequiredEngineIds,
  selectKeywordsWithWork,
  type SeRankingSelectiveSyncInventory,
} from "./seranking-selective-sync";

const DESKTOP = 539194;
const MOBILE = 545914;

const engineBindings = {
  desktop: DESKTOP,
  mobile: MOBILE,
  byTargetId: { "target-desktop": DESKTOP, "target-mobile": MOBILE },
};

function inventory(input: {
  remote?: Array<{ id: string; keyword: string }>;
  membership?: Record<number, string[]>;
  unknownEngines?: number[];
  status?: "ok" | "unknown";
}): SeRankingSelectiveSyncInventory {
  const byIdentity = new Map<string, { id: string; keyword: string }>();
  for (const kw of input.remote ?? []) {
    byIdentity.set(normalizeKeywordIdentity(kw.keyword), kw);
  }
  const engineMembership = new Map<number, Set<string>>();
  for (const [engineId, ids] of Object.entries(input.membership ?? {})) {
    engineMembership.set(Number(engineId), new Set(ids));
  }
  return {
    status: input.status ?? "ok",
    byIdentity,
    engineMembership,
    enginesWithUnknownMembership: input.unknownEngines ?? [],
  };
}

describe("normalizeKeywordIdentity", () => {
  it("matches keywords that differ only in whitespace and case", () => {
    expect(normalizeKeywordIdentity("  Padel Court ")).toBe(
      normalizeKeywordIdentity("padel court"),
    );
  });

  it("preserves Arabic letters, hamza and diacritics instead of stripping them", () => {
    const withHamza = "إنشاء ملاعب";
    const withoutHamza = "انشاء ملاعب";
    expect(normalizeKeywordIdentity(withHamza)).not.toBe(
      normalizeKeywordIdentity(withoutHamza),
    );

    const withTashkeel = "مَلاعب";
    const withoutTashkeel = "ملاعب";
    // Meaningful marks are never stripped: these stay distinct identities.
    expect(normalizeKeywordIdentity(withTashkeel)).not.toBe(
      normalizeKeywordIdentity(withoutTashkeel),
    );
  });

  it("normalizes Unicode composition so canonically identical text matches", () => {
    const decomposed = "ملاعب\u064B"; // isolated fathatan
    const composed = decomposed.normalize("NFC");
    expect(normalizeKeywordIdentity(decomposed)).toBe(
      normalizeKeywordIdentity(composed),
    );
  });
});

describe("resolveRequiredEngineIds", () => {
  it("uses explicit target assignments by default without broadening", () => {
    const result = resolveRequiredEngineIds(
      { id: "kw", keyword: "k", assignedTargetIds: ["target-desktop"] },
      "assignments",
      engineBindings,
      "both",
    );
    expect(result.engineIds).toEqual([DESKTOP]);
    expect(result.blockedReason).toBeNull();
  });

  it("falls back to the config's device choice only for unassigned keywords", () => {
    const result = resolveRequiredEngineIds(
      { id: "kw", keyword: "k", assignedTargetIds: [] },
      "assignments",
      engineBindings,
      "desktop",
    );
    expect(result.engineIds).toEqual([DESKTOP]);
  });

  it("blocks when an assigned target has no engine binding", () => {
    const result = resolveRequiredEngineIds(
      { id: "kw", keyword: "k", assignedTargetIds: ["target-other"] },
      "assignments",
      { desktop: DESKTOP, mobile: MOBILE, byTargetId: {} },
      "both",
    );
    expect(result.engineIds).toEqual([]);
    expect(result.blockedReason).toContain("no SE Ranking engine binding");
  });

  it.each([
    ["both without a mobile binding", "both", null, false],
    ["default with only disabled assignments", "assignments", MOBILE, true],
  ] as const)(
    "blocks %s",
    (_scenario, mode, mobile, hasExplicitAssignments) => {
      const result = resolveRequiredEngineIds(
        {
          id: "kw",
          keyword: "k",
          assignedTargetIds: [],
          hasExplicitAssignments,
        },
        mode,
        { ...engineBindings, mobile },
        "both",
      );
      expect(result.engineIds).toEqual([]);
      expect(result.blockedReason).toBeTruthy();
    },
  );

  it("supports explicit desktop/mobile/both selections", () => {
    expect(
      resolveRequiredEngineIds(
        { id: "kw", keyword: "k", assignedTargetIds: [] },
        "mobile",
        engineBindings,
        "both",
      ).engineIds,
    ).toEqual([MOBILE]);
    expect(
      resolveRequiredEngineIds(
        { id: "kw", keyword: "k", assignedTargetIds: [] },
        "both",
        engineBindings,
        "desktop",
      ).engineIds,
    ).toEqual([DESKTOP, MOBILE]);
  });
});

const kw = (id: string, keyword: string, assignedTargetIds: string[] = []) => ({
  id,
  keyword,
  assignedTargetIds,
});

describe("computeSelectiveSyncPlan", () => {
  it("classifies missing remote, fully synced, partial and unmapped keywords", () => {
    const plan = computeSelectiveSyncPlan({
      localKeywords: [
        kw("missing", "كلمة غير موجودة"),
        kw("synced", "موجودة كاملة", ["target-desktop", "target-mobile"]),
        kw("partial", "موجودة جزئيا"),
        kw("unmapped", "remote only"),
      ],
      inventory: inventory({
        remote: [
          { id: "r1", keyword: "موجودة كاملة" },
          { id: "r2", keyword: "موجودة جزئيا" },
          { id: "r3", keyword: "remote only" },
        ],
        membership: {
          [DESKTOP]: ["r1", "r2", "r3"],
          [MOBILE]: ["r1", "r3"],
        },
      }),
      mappings: new Map([
        ["synced", { remoteKeywordId: "r1", status: "synced" }],
        ["partial", { remoteKeywordId: "r2", status: "synced" }],
      ]),
      engineBindings,
      engineMode: "both",
      configDevices: "both",
    });

    const byId = new Map(plan.keywords.map((k) => [k.trackingKeywordId, k]));
    expect(byId.get("missing")?.classification).toBe("missing_remote");
    expect(byId.get("missing")?.action).toBe("add_remote");
    expect(byId.get("synced")?.classification).toBe("fully_synced");
    expect(byId.get("synced")?.action).toBe("none");
    expect(byId.get("partial")?.classification).toBe("partially_synced");
    expect(byId.get("partial")?.missingEngineIds).toEqual([MOBILE]);
    expect(byId.get("unmapped")?.classification).toBe("remote_unmapped");

    expect(plan.counts.missingRemote).toBe(1);
    expect(plan.counts.missingDesktopAssignments).toBe(1);
    expect(plan.counts.missingMobileAssignments).toBe(2);
    // 2 engines for the new keyword + 1 missing mobile slot for the partial one
    expect(plan.counts.estimatedAdditionalEngineSlots).toBe(3);
    expect(selectKeywordsWithWork(plan)).not.toContain("synced");
  });

  it("fails closed when engine membership listing failed", () => {
    const plan = computeSelectiveSyncPlan({
      localKeywords: [kw("existing", "existing kw"), kw("fresh", "fresh kw")],
      inventory: inventory({
        remote: [{ id: "r1", keyword: "existing kw" }],
        unknownEngines: [MOBILE],
      }),
      mappings: new Map(),
      engineBindings,
      engineMode: "both",
      configDevices: "both",
    });

    const byId = new Map(plan.keywords.map((k) => [k.trackingKeywordId, k]));
    // Existing remote keyword: engine work must be blocked, not patched blind.
    expect(byId.get("existing")?.action).toBe("blocked");
    expect(byId.get("existing")?.unverifiedEngineIds).toEqual([MOBILE]);
    // New keyword: adding against an unverifiable engine is also blocked.
    expect(byId.get("fresh")?.action).toBe("blocked");
    expect(plan.engineKnowledgeIncomplete).toBe(true);
  });

  it("marks everything unknown when the full inventory could not be read", () => {
    const plan = computeSelectiveSyncPlan({
      localKeywords: [kw("a", "a")],
      inventory: inventory({ status: "unknown" }),
      mappings: new Map(),
      engineBindings,
      engineMode: "both",
      configDevices: "both",
    });
    expect(plan.keywords[0].classification).toBe("unknown");
    expect(plan.counts.unknown).toBe(1);
  });

  it("reports unknown assignment counts when a required engine listing failed", () => {
    const plan = computeSelectiveSyncPlan({
      localKeywords: [kw("existing", "e")],
      inventory: inventory({
        remote: [{ id: "r1", keyword: "e" }],
        membership: { [DESKTOP]: ["r1"] },
        unknownEngines: [MOBILE],
      }),
      mappings: new Map(),
      engineBindings,
      engineMode: "both",
      configDevices: "both",
    });
    expect(plan.counts.missingDesktopAssignments).toBe(0);
    expect(plan.counts.missingMobileAssignments).toBeNull();
  });
});
