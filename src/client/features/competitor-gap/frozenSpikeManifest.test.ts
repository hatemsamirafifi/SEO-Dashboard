import { describe, expect, it } from "vitest";
import { FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST } from "./frozenSpikeManifest";
import { isMaintainerSurfaceEnabled } from "./maintainerAccess";

describe("FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST", () => {
  it("matches frozen manifest values exactly", () => {
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.projectId).toBe(
      "bb267736-5e5e-9f5f-7d78260abbde",
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.sampleDomains).toEqual([
      "emtyiaz.com",
      "manaraa.com",
      "bahthy.com",
    ]);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.keywordSetRef).toBe(
      "gsc-top-queries-2026-10-09",
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.market).toEqual({
      locationCode: 2784,
      languageCode: "ar",
    });
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.budgetCapCredits).toBe(500);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.timeBoxHours).toBe(4);
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds).toEqual({
      minKeywordCoverageRatio: 0.5,
      minFirstPartyCoverageRatio: 0.5,
      maxCostPerAnalysisCredits: 100,
      repeatCacheHitRate: 1.0,
      identityCollisionsAllowed: 0,
    });
  });

  it("is deeply frozen and immutable at runtime", () => {
    expect(Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST)).toBe(true);
    expect(
      Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.sampleDomains),
    ).toBe(true);
    expect(Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.market)).toBe(
      true,
    );
    expect(
      Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST.thresholds),
    ).toBe(true);
  });
});

describe("isMaintainerSurfaceEnabled", () => {
  it("enables via search parameter ?maintainer=1", () => {
    const params = new URLSearchParams("maintainer=1");
    expect(isMaintainerSurfaceEnabled({ searchParams: params })).toBe(true);
  });

  it("enables via storage flag", () => {
    const mockStorage = {
      getItem: (key: string) =>
        key === "openseo:maintainer_mode" ? "true" : null,
    };
    expect(isMaintainerSurfaceEnabled({ storage: mockStorage })).toBe(true);
  });

  it("disables when neither flag is set and not in dev/env mode", () => {
    const params = new URLSearchParams();
    const mockStorage = { getItem: () => null };
    expect(
      isMaintainerSurfaceEnabled({
        searchParams: params,
        storage: mockStorage,
        isDev: false,
      }),
    ).toBe(false);
  });
});
