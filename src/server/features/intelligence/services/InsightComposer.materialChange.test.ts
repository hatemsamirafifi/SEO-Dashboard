import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({
  env: {
    R2: {
      get: async () => null,
      head: async () => null,
      put: async () => {},
    },
  },
  waitUntil: vi.fn(),
}));

vi.mock("@/db", async () => {
  const [{ createClient }, { drizzle }] = await Promise.all([
    import("@libsql/client"),
    import("drizzle-orm/libsql"),
  ]);
  return { db: drizzle(createClient({ url: "file::memory:" })) };
});

vi.mock("@/db/runBatch", () => ({
  runBatch: async (build: (tx: unknown) => Promise<unknown>[] | unknown[]) => {
    for (const statement of build(undefined)) await statement;
  },
  executeInBatches: async () => {},
}));

vi.mock("@/server/lib/posthog", () => ({
  captureServerEvent: vi.fn(),
}));

import { isMaterialChange } from "./InsightComposer";

describe("isMaterialChange", () => {
  const prev = {
    severity: "high",
    recommendation: "Review SERPs.",
    entityRefsJson: JSON.stringify(["a", "b", "c", "d", "e"]),
    findingKeysJson: JSON.stringify(["k1"]),
    opportunityIdsJson: JSON.stringify(["o1"]),
    metricsJson: JSON.stringify({ a: 1000, b: 500 }),
  };
  const next = {
    severity: "high",
    recommendation: "Review SERPs.",
    entityRefs: ["a", "b", "c", "d", "e"],
    findingKeys: ["k1"],
    opportunityIds: ["o1"],
    metrics: { a: 1000, b: 500 },
  };

  it("ignores identical content (period rollover never material)", () => {
    expect(isMaterialChange(prev, next).material).toBe(false);
  });

  it("fires on severity, entity, recommendation, and linkage changes", () => {
    expect(
      isMaterialChange(prev, { ...next, severity: "critical" }).reasons,
    ).toContain("severity");
    expect(
      isMaterialChange(prev, { ...next, entityRefs: ["x", "y"] }).reasons,
    ).toContain("entities");
    expect(
      isMaterialChange(prev, { ...next, recommendation: "Do other." }).reasons,
    ).toContain("recommendation-class");
    expect(
      isMaterialChange(prev, { ...next, findingKeys: ["k1", "k2"] }).reasons,
    ).toContain("linkage");
  });

  it("fires on metric drift ≥25% with absolute floor 50", () => {
    // 30% drift, +300 absolute → material.
    expect(
      isMaterialChange(prev, {
        ...next,
        metrics: { a: 1300, b: 500 },
      }).material,
    ).toBe(true);
    // 30% drift but +15 absolute → below the floor, not material.
    expect(
      isMaterialChange(
        { ...prev, metricsJson: JSON.stringify({ a: 50 }) },
        { ...next, metrics: { a: 65 } },
      ).material,
    ).toBe(false);
    // 10% drift → not material.
    expect(
      isMaterialChange(prev, { ...next, metrics: { a: 1100, b: 500 } })
        .material,
    ).toBe(false);
  });
});
