import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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

// SourceTokens.ts is the ONE file allowed to import source repositories.
const NO_SOURCE_IMPORT_FILES = STAGE_ONE_FILES.filter(
  (file) =>
    file !== "src/server/features/intelligence/services/SourceTokens.ts",
);

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

describe("intelligence structural locks", () => {
  const surface = [
    ...STAGE_ONE_FILES,
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
