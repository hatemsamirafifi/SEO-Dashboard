import { describe, expect, it, vi } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("pure detector tests must not touch the database");
      },
    },
  ),
}));
vi.mock("@/server/lib/seo-data", () => ({
  getSeoDataRouter: vi.fn(() => {
    throw new Error("pure detector tests must not route provider calls");
  }),
}));

// oxlint-disable-next-line import/first -- mocks must load before the detector under test
import { defaultThresholdsFor } from "@/shared/intelligence-thresholds";
import {
  detectLostBacklinks,
  isLostBacklinksInput,
  lostBacklinksDetector,
  normalizeLostDomain,
  type LostBacklinksInput,
} from "./lostBacklinks";
import type { BacklinkTotals } from "./backlinkChange";
import type { DetectorContext } from "./types";

function ctx(): DetectorContext {
  return {
    projectId: "project-1",
    organizationId: "org-1",
    periodFrom: "",
    periodTo: "",
    thresholds: defaultThresholdsFor("lost_backlinks"),
    thresholdVersion: 2,
  };
}

const BASE_TOTALS: BacklinkTotals = {
  backlinks: 1000,
  referringDomains: 120,
  brokenBacklinks: 5,
  newBacklinks: 2,
  lostBacklinks: 1,
  newReferringDomains: 1,
  lostReferringDomains: 0,
};

function lostInput(
  overrides: Partial<LostBacklinksInput> = {},
): LostBacklinksInput {
  return {
    domain: "example.com",
    before: { ...BASE_TOTALS },
    after: { ...BASE_TOTALS, lostBacklinks: 3, lostReferringDomains: 8 },
    beforeCapturedAt: "2026-09-10T00:00:00.000Z",
    afterCapturedAt: "2026-09-20T00:00:00.000Z",
    lostDomains: ["gone-a.com", "gone-b.com", "gone-c.com"],
    thresholds: { minSnapshots: 2, freshnessDays: 30, minReferringDomains: 3 },
    ...overrides,
  };
}

describe("lost_backlinks floor (spec 008)", () => {
  it.each([0, 1, 2])(
    "emits nothing below the floor (%i lost domains)",
    (lost) => {
      const findings = detectLostBacklinks(
        ctx(),
        lostInput({
          after: { ...BASE_TOTALS, lostReferringDomains: lost },
          lostDomains: [],
        }),
      );
      expect(findings).toHaveLength(0);
    },
  );

  it("emits exactly at the floor of 3", () => {
    const findings = detectLostBacklinks(
      ctx(),
      lostInput({
        after: { ...BASE_TOTALS, lostReferringDomains: 3 },
        lostDomains: ["gone-a.com", "gone-b.com", "gone-c.com"],
      }),
    );
    expect(findings).toHaveLength(1);
  });

  it("emits above the floor", () => {
    const findings = detectLostBacklinks(ctx(), lostInput());
    expect(findings).toHaveLength(1);
  });

  it("emits nothing for unknown totals (unknown is not zero)", () => {
    const findings = detectLostBacklinks(
      ctx(),
      lostInput({
        after: { ...BASE_TOTALS, lostReferringDomains: null },
        lostDomains: [],
      }),
    );
    expect(findings).toHaveLength(0);
  });

  it("emits nothing when no domains could be named", () => {
    const findings = detectLostBacklinks(ctx(), lostInput({ lostDomains: [] }));
    expect(findings).toHaveLength(0);
  });

  it("rejects mistyped inputs", () => {
    expect(isLostBacklinksInput(null)).toBe(false);
    expect(isLostBacklinksInput({ domain: "example.com" })).toBe(false);
    expect(isLostBacklinksInput(lostInput())).toBe(true);
    expect(() =>
      lostBacklinksDetector.detect(ctx(), { domain: "example.com" }),
    ).toThrow("lost_backlinks: mistyped input");
  });
});

describe("lost_backlinks domain normalization (spec 008)", () => {
  it.each([
    ["Gone-A.com", "gone-a.com"],
    ["WWW.GONE-B.COM", "gone-b.com"],
    ["https://Shop.Example.com/path", "shop.example.com"],
    ["blog.example.com", "blog.example.com"],
  ])("normalizes %s to %s", (input, expected) => {
    expect(normalizeLostDomain(input)).toBe(expected);
  });

  it.each([null, undefined, 42, "", "   ", "https://"])(
    "drops unusable values (%s)",
    (input) => {
      expect(normalizeLostDomain(input)).toBeNull();
    },
  );
});

describe("lost_backlinks evidence (spec 008)", () => {
  it("freezes named domains, counts, and snapshot timestamps", () => {
    const [finding] = detectLostBacklinks(ctx(), lostInput());
    expect(finding?.entityKey).toBe("backlinks:example.com");
    expect(finding?.entity).toMatchObject({ domain: "example.com" });
    expect(finding?.evidence.metrics).toMatchObject({
      lostReferringDomains: 8,
      namedLostDomains: 3,
    });
    expect(finding?.evidence.periods).toEqual({
      from: "2026-09-10",
      to: "2026-09-20",
    });
    expect(finding?.evidence.sources).toEqual(["backlinks"]);
    expect(finding?.evidence.thresholdsApplied).toMatchObject({
      minReferringDomains: 3,
    });
    expect(finding?.evidence.evidenceType).toBe("observational");
    expect(finding?.evidence.partialData).toContain("two_point_heuristic");
    // Heuristic two-point baseline: confidence capped like its sibling.
    expect(finding?.confidenceScore).toBeLessThanOrEqual(69);
    expect(finding?.confidenceScore).toBeGreaterThanOrEqual(40);
  });

  it("states facts without recommendations or causal verbs", () => {
    const [finding] = detectLostBacklinks(ctx(), lostInput());
    expect(finding?.explanationFact).toContain("gone-a.com");
    expect(finding?.explanationFact).not.toMatch(
      /\b(should|recover|fix|because of|due to|caused)\b/i,
    );
  });
});
