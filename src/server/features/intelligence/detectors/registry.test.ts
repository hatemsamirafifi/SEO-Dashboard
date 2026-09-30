import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";

// Registry pulls detector modules → repositories → `@/db` → workers.
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: new Proxy(
    {},
    {
      get: () => {
        throw new Error("registry tests must not touch the database");
      },
    },
  ),
}));

import { detectorVersions, getDetector, listDetectors } from "./registry";

describe("detector registry", () => {
  it("ships as an explicit list with no auto-glob", () => {
    const content = readFileSync(
      resolve(
        process.cwd(),
        "src/server/features/intelligence/detectors/registry.ts",
      ),
      "utf8",
    );
    expect(content).not.toMatch(/readdir|require\.context|import\.meta\.glob/);
  });

  it("exposes one entry per detectorKey", () => {
    const detectors = listDetectors();
    const keys = detectors.map((detector) => detector.detectorKey);
    expect(new Set(keys).size).toBe(keys.length);
    expect(detectorVersions()).toEqual(
      Object.fromEntries(
        detectors.map((detector) => [detector.detectorKey, detector.version]),
      ),
    );
  });

  it("returns null for unknown keys", () => {
    expect(getDetector("no_such_detector")).toBeNull();
  });

  it("pins integer versions for every registered detector", () => {
    for (const detector of listDetectors()) {
      expect(Number.isInteger(detector.version)).toBe(true);
      expect(detector.version).toBeGreaterThanOrEqual(1);
      expect(detector.minConfidenceToEmit).toBeGreaterThanOrEqual(0);
    }
  });

  it("registers exactly the PR7 detectors plus the GA4 change detector", () => {
    const keys = listDetectors()
      .map((detector) => detector.detectorKey)
      .toSorted();
    expect(keys).toEqual([
      "backlink_change",
      "cannibalization",
      "content_decay",
      "ga4_organic_change",
      "lost_backlinks",
      "low_ctr_query",
      "organic_traffic_change",
      "ranking_drop",
      "striking_distance",
      "technical_on_important_page",
    ]);
    // Stable snake_case keys (part of finding identity).
    for (const key of keys) {
      expect(key).toMatch(/^[a-z][a-z0-9_]*$/);
    }
  });

  it("gives every detector a non-empty coverage contract", () => {
    for (const detector of listDetectors()) {
      expect(detector.coverage.length).toBeGreaterThan(0);
      for (const requirement of detector.coverage) {
        expect(requirement.grains.length).toBeGreaterThan(0);
        expect(requirement.minCoverageRatio).toBeGreaterThan(0);
      }
    }
  });
});
