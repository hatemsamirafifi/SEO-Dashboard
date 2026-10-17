import { describe, expect, it } from "vitest";
import {
  FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST,
  FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1,
  FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2,
} from "./frozenSpikeManifest";
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

describe("FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1 & R2", () => {
  it("preserves R1 frozen manifest immutably", () => {
    expect(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.evaluationId,
    ).toBeUndefined();
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.projectId).toBe(
      "bb267736-5e5e-9f5f-7d78260abbde",
    );
  });

  it("defines R2 with distinct evaluationId and strictly unweakened inputs", () => {
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.evaluationId).toBe(
      "competitor-gap-g5-r2",
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.projectId).toBe(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.projectId,
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.sampleDomains).toEqual(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.sampleDomains,
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.keywordSetRef).toBe(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.keywordSetRef,
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.market).toEqual(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.market,
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.budgetCapCredits).toBe(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.budgetCapCredits,
    );
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.timeBoxHours).toBe(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.timeBoxHours,
    );
    // Unweakened thresholds
    expect(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2.thresholds).toEqual(
      FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R1.thresholds,
    );
    expect(Object.isFrozen(FROZEN_COMPETITOR_GAP_SPIKE_MANIFEST_R2)).toBe(true);
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
