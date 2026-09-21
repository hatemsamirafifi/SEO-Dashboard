import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  detectorVersions,
  getDetector,
  listDetectors,
} from "./registry";

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
});
