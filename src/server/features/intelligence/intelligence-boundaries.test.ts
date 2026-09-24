import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * final-plan §14 + Stage-1 structural locks. Stage-1 code (detection,
 * ledger, artifacts, scheduler, server functions) must never read source
 * tables directly: SourceTokens.ts is the single allowed importer of source
 * repositories, services never touch `env.DB`, and the frozen locks
 * (no rankScore, no causedBy, no finding_samples, no report_schedules) hold
 * across the intelligence surface.
 */

const STAGE_ONE_FILES = [
  "src/server/features/intelligence/services/FindingService.ts",
  "src/server/features/intelligence/services/detectionStage.ts",
  "src/server/features/intelligence/services/scheduledIntelligenceScan.ts",
  "src/server/features/intelligence/repositories/ScanLedgerRepository.ts",
  "src/server/features/intelligence/repositories/ArtifactStore.ts",
  "src/server/features/intelligence/detectors/types.ts",
  "src/server/features/intelligence/detectors/registry.ts",
  "src/serverFunctions/intelligence.ts",
];

// Detector implementations + inputs.ts legitimately import source
// repositories (Stage-1 detection reads): they are covered by the lock
// surface and the no-duplicate-logic test, NOT by the repository ban.
// SourceTokens.ts is the ONE listed file allowed source-repository imports.
const NO_SOURCE_IMPORT_FILES = STAGE_ONE_FILES.filter(
  (file) =>
    file !== "src/server/features/intelligence/services/SourceTokens.ts",
);

const DETECTOR_FILES = [
  "src/server/features/intelligence/detectors/inputs.ts",
  "src/server/features/intelligence/detectors/gscWindows.ts",
  "src/server/features/intelligence/detectors/organicTrafficChange.ts",
  "src/server/features/intelligence/detectors/lowCtrQuery.ts",
  "src/server/features/intelligence/detectors/contentDecay.ts",
  "src/server/features/intelligence/detectors/rankingDrop.ts",
  "src/server/features/intelligence/detectors/cannibalization.ts",
  "src/server/features/intelligence/detectors/technicalOnImportantPage.ts",
  "src/server/features/intelligence/detectors/backlinkChange.ts",
];

const SOURCE_REPOSITORY_IMPORTS = [
  /features\/ga4\/repositories/,
  /features\/gsc\/repositories/,
  /features\/rank-tracking\//,
  /features\/audit\//,
  /features\/backlink/,
  /ga4Syncs|gscSearchPerformanceSyncs|rankCheckRuns|rankSnapshots|rankTrackingConfigs|backlinkSnapshots/,
];

const LOCKED_TOKENS = [
  "rankScore",
  "causedBy",
  "finding_samples",
  "report_schedules",
];

function readSurface(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

describe("intelligence Stage-1 import ban", () => {
  it("only SourceTokens imports source repositories", () => {
    for (const file of NO_SOURCE_IMPORT_FILES) {
      const content = readSurface(file);
      for (const pattern of SOURCE_REPOSITORY_IMPORTS) {
        expect(
          pattern.test(content),
          `${file} must not import source repositories (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("SourceTokens is the single file that does", () => {
    const content = readSurface(
      "src/server/features/intelligence/services/SourceTokens.ts",
    );
    expect(
      SOURCE_REPOSITORY_IMPORTS.some((pattern) => pattern.test(content)),
      "SourceTokens.ts must import source repositories (it is the §7 gateway)",
    ).toBe(true);
  });

  it("services never touch env.DB directly", () => {
    for (const file of [
      "src/server/features/intelligence/services/FindingService.ts",
      "src/server/features/intelligence/services/detectionStage.ts",
      "src/server/features/intelligence/services/scheduledIntelligenceScan.ts",
    ]) {
      const content = readSurface(file);
      expect(
        /from ["']@\/db["']/.test(content),
        `${file} must not import the database handle (service → repository → Drizzle DB)`,
      ).toBe(false);
    }
  });
});

const BANNED_DETECTOR_IMPORTS = [
  "intelligence/detectors",
  "intelligence-thresholds",
  "opportunity-weights",
];

function sourceFilesRecursive(dir: string): string[] {
  const entries = readdirSync(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      files.push(...sourceFilesRecursive(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      files.push(full);
    }
  }
  return files;
}

function isExemptPath(relative: string): boolean {
  return (
    relative.startsWith("src/server/features/intelligence/") ||
    relative.endsWith(".test.ts") ||
    relative.endsWith(".test.tsx") ||
    relative === "src/routeTree.gen.ts"
  );
}

describe("no-duplicate-logic (final-plan §19)", () => {
  // Each SEO condition has exactly one detector. Dashboard/Reports/SAM
  // contain zero threshold/comparison logic: production code outside
  // intelligence/ must never import detector modules or threshold/weight
  // contracts. Test files are exempt (behavior assertions, not shipped
  // logic); every current test of detectors lives inside intelligence/.
  it("no production file outside intelligence/ imports detectors or thresholds", () => {
    const root = resolve(process.cwd(), "src");
    const violations: string[] = [];
    for (const file of sourceFilesRecursive(root)) {
      const relative = file
        .replace(resolve(process.cwd()), "")
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      if (isExemptPath(relative)) continue;
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (!/from\s+["']|import\s*\(/.test(line)) continue;
        for (const banned of BANNED_DETECTOR_IMPORTS) {
          if (line.includes(banned)) {
            violations.push(`${relative}: ${line.trim()}`);
          }
        }
      }
    }
    expect(
      violations,
      "detector/threshold imports outside intelligence/",
    ).toEqual([]);
  });
});

describe("intelligence structural locks", () => {
  const surface = [
    ...STAGE_ONE_FILES,
    ...DETECTOR_FILES,
    "src/server/features/intelligence/services/SourceTokens.ts",
    "src/shared/intelligence.ts",
    "src/shared/intelligence-thresholds.ts",
    "src/shared/opportunity-weights.ts",
    "src/db/intelligence.schema.ts",
    "src/db/pg/intelligence.schema.ts",
    "drizzle/0053_minor_korath.sql",
    "drizzle-pg/0031_closed_blindfold.sql",
  ];
  it.each(LOCKED_TOKENS)("never contains %s", (token) => {
    for (const file of surface) {
      const content = readSurface(file);
      expect(
        content.includes(token),
        `${file} must not contain locked token ${token}`,
      ).toBe(false);
    }
  });
});
