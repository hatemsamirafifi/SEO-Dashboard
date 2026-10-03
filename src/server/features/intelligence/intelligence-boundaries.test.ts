/* eslint-disable max-lines -- boundary allowlists grow with the guarded surface */
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
  // Pure scan-time join: pre-fetched rows in, merged rows out. Imports no
  // repositories by design (fetchers read; the joiner matches).
  "src/server/features/intelligence/services/AnalyticsJoinService.ts",
  "src/server/features/intelligence/repositories/ScanLedgerRepository.ts",
  "src/server/features/intelligence/repositories/ArtifactStore.ts",
  "src/server/features/intelligence/detectors/types.ts",
  "src/server/features/intelligence/detectors/registry.ts",
  "src/serverFunctions/intelligence.ts",
  // Stage-3 read model: artifact + ledger + own tables only (connection
  // metadata for the GA4 flag lives in the server-function handler).
  "src/server/features/intelligence/services/InsightComposer.ts",
  "src/server/features/intelligence/services/insightGroups.ts",
  "src/server/features/intelligence/services/InsightService.ts",
  "src/server/features/intelligence/repositories/InsightRepository.ts",
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
  "src/server/features/intelligence/detectors/ga4OrganicChange.ts",
  "src/server/features/intelligence/detectors/organicTrafficChange.ts",
  "src/server/features/intelligence/detectors/lowCtrQuery.ts",
  "src/server/features/intelligence/detectors/contentDecay.ts",
  "src/server/features/intelligence/detectors/rankingDrop.ts",
  "src/server/features/intelligence/detectors/cannibalization.ts",
  "src/server/features/intelligence/detectors/technicalOnImportantPage.ts",
  "src/server/features/intelligence/detectors/backlinkChange.ts",
  "src/server/features/intelligence/detectors/lostBacklinks.ts",
  // Spec 010: shared scan-time pre-fetch helpers for the organic page join
  // (repository reads only — matching stays inside AnalyticsJoinService).
  "src/server/features/intelligence/detectors/organicJoin.ts",
  // Spec 010: GA4-backed detectors (conversion_drop is site-level per goal;
  // engagement_drop is per canonical page via the join).
  "src/server/features/intelligence/detectors/conversionDrop.ts",
  "src/server/features/intelligence/detectors/engagementDrop.ts",
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

const REPORTS_FILES = [
  "src/shared/reports.ts",
  "src/server/features/reports/repositories/ReportRepository.ts",
  "src/server/features/reports/repositories/SharingRepository.ts",
  "src/server/features/reports/repositories/BrandingRepository.ts",
  "src/server/features/reports/services/reportSections.ts",
  "src/server/features/reports/services/ReportService.ts",
  "src/server/features/reports/services/ShareService.ts",
  "src/server/features/reports/services/BrandingService.ts",
  "src/server/features/reports/services/brandLogo.ts",
  "src/server/features/reports/services/printModel.ts",
  "src/server/features/reports/services/pdfDocument.ts",
  "src/server/features/reports/services/printHtml.ts",
  "src/server/features/reports/services/ExportService.ts",
  "src/serverFunctions/reports.ts",
  "src/serverFunctions/branding.ts",
  "src/types/schemas/reports.ts",
  "src/types/schemas/branding.ts",
];

// Live data paths reports must never touch: snapshots freeze stored
// aggregates, so provider clients, the router, visit-triggered refresh, and
// raw fact-table imports are all banned (aggregate repository readers only).
const BANNED_REPORTS_IMPORTS = [
  "ga4Client",
  "gscClient",
  "getSeoDataRouter",
  "ensureBacklinkSnapshot",
];

const REPORTS_FACT_TABLES = [
  "gscSearchPerformance",
  "ga4DailySummary",
  "ga4DailyLandingPages",
  "ga4DailyEvents",
  "ga4SyncCoverage",
  "rankSnapshots",
  "rankCheckRuns",
  "rankTrackingConfigs",
  "auditIssues",
  "backlinkSnapshots",
  "audits",
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
  }, 30_000);
});

describe("reports snapshot discipline (final-plan §12)", () => {
  it("never imports live clients or visit-triggered refresh", () => {
    for (const file of REPORTS_FILES) {
      const content = readSurface(file);
      for (const banned of BANNED_REPORTS_IMPORTS) {
        expect(
          content.includes(banned),
          `${file} must not reference live path ${banned}`,
        ).toBe(false);
      }
    }
  });

  it("reads metrics through aggregate readers, never raw fact tables", () => {
    for (const file of REPORTS_FILES) {
      const content = readSurface(file);
      for (const line of content.split("\n")) {
        if (!line.includes('from "@/db/schema"')) continue;
        for (const table of REPORTS_FACT_TABLES) {
          expect(
            line.includes(table),
            `${file} must not import fact table ${table}`,
          ).toBe(false);
        }
      }
    }
  });
});

import {
  AUTOPILOT_COPY_FILES,
  AUTOPILOT_FILES,
  AUTOPILOT_LOCK_FILES,
  MCP_UI_COPY_FILES,
} from "./boundarySurfaces";

describe("autopilot stage discipline (final-plan §13)", () => {
  // The executor may pin sources (SourceTokens assemble/hash) and read its
  // own ledger — never detectors, thresholds, weights, source-metric
  // repositories, or raw fact tables. Synthesis modules (Task 16) additionally
  // pass through the assertSynthesisInput firewall (behavior-tested).
  it("imports no detector, threshold, weight, or source-metric modules", () => {
    for (const file of AUTOPILOT_FILES) {
      const content = readSurface(file);
      for (const banned of BANNED_DETECTOR_IMPORTS) {
        expect(
          content.includes(banned),
          `${file} must not import ${banned}`,
        ).toBe(false);
      }
      for (const pattern of SOURCE_REPOSITORY_IMPORTS) {
        expect(
          pattern.test(content),
          `${file} must not import source repositories (${pattern})`,
        ).toBe(false);
      }
    }
  });

  it("reads no raw fact tables", () => {
    for (const file of AUTOPILOT_FILES) {
      const content = readSurface(file);
      for (const line of content.split("\n")) {
        if (!line.includes('from "@/db/schema"')) continue;
        for (const table of REPORTS_FACT_TABLES) {
          expect(
            line.includes(table),
            `${file} must not import fact table ${table}`,
          ).toBe(false);
        }
      }
    }
  });
});

describe("observational causality lock (final-plan §10)", () => {
  // MVP automated output is correlation-only: no detector fact and no
  // materializer recommendation may carry causal phrasing. Only future
  // provider-confirmed / manual-assertion evidence classes unlock it.
  // Leading boundaries matter: "failed to load" is legitimate UI copy,
  // not the causal "led to" phrasing.
  const BANNED_CAUSAL = [
    /\bcaused\b/i,
    /\bcauses\b/i,
    /\bcausing\b/i,
    /\bbecause of/i,
    /\bdue to/i,
    /\bled to/i,
    /\bresulted in/i,
    /\btriggered\b/i,
  ];
  const COPY_FILES = [
    ...DETECTOR_FILES,
    "src/server/features/intelligence/services/opportunityTemplates.ts",
    "src/server/features/intelligence/services/insightGroups.ts",
    "src/client/features/opportunities/opportunitiesCopy.ts",
    "src/client/features/opportunities/OpportunitiesPage.tsx",
    "src/client/features/opportunities/OpportunityDetail.tsx",
    "src/client/features/opportunities/OpportunityDetailSections.tsx",
    "src/shared/reports.ts",
    "src/server/features/reports/services/ReportService.ts",
    "src/server/features/reports/services/reportSections.ts",
    "src/client/features/reports/reportsCopy.ts",
    "src/client/features/reports/ReportsPage.tsx",
    "src/client/features/reports/ReportDetail.tsx",
    "src/client/features/reports/ReportSections.tsx",
    "src/client/features/reports/ShareReportModal.tsx",
    "src/client/features/reports/PublicReportPage.tsx",
    "src/client/features/reports/BrandingSettings.tsx",
    "src/client/features/reports/ExportReportButtons.tsx",
    ...AUTOPILOT_COPY_FILES,
    ...MCP_UI_COPY_FILES,
  ];
  it("contains zero banned causal verbs in detector/template sources", () => {
    const violations: string[] = [];
    for (const file of COPY_FILES) {
      const content = readSurface(file);
      for (const pattern of BANNED_CAUSAL) {
        if (pattern.test(content)) {
          violations.push(`${file}: ${pattern}`);
        }
      }
    }
    expect(violations).toEqual([]);
  });
});

describe("intelligence structural locks", () => {
  const surface = [
    ...STAGE_ONE_FILES,
    ...DETECTOR_FILES,
    "src/server/features/intelligence/services/opportunityTemplates.ts",
    "src/server/features/intelligence/services/OpportunityMaterializer.ts",
    "src/server/features/intelligence/services/OpportunityService.ts",
    "src/server/features/intelligence/repositories/OpportunityRepository.ts",
    "src/serverFunctions/opportunities.ts",
    "src/types/schemas/opportunities.ts",
    "src/db/opportunities.schema.ts",
    "src/db/pg/opportunities.schema.ts",
    "drizzle/0054_mighty_mole_man.sql",
    "drizzle-pg/0032_nosy_leader.sql",
    "src/client/features/opportunities/opportunitiesCopy.ts",
    "src/client/features/opportunities/OpportunitiesPage.tsx",
    "src/client/features/opportunities/OpportunityDetail.tsx",
    "src/client/features/opportunities/OpportunityDetailSections.tsx",
    "src/client/navigation/items.ts",
    "src/client/features/insights/insightsCopy.ts",
    "src/client/features/insights/InsightSections.tsx",
    "src/client/features/dashboard/DashboardPage.tsx",
    "src/client/components/SourceBadge.tsx",
    "src/client/components/StaleBanner.tsx",
    "src/server/features/intelligence/services/insightGroups.ts",
    "src/server/features/intelligence/services/InsightComposer.ts",
    "src/server/features/intelligence/services/InsightService.ts",
    "src/server/features/intelligence/repositories/InsightRepository.ts",
    "src/types/schemas/dashboard.ts",
    "src/serverFunctions/dashboard.ts",
    "src/db/insights.schema.ts",
    "src/db/pg/insights.schema.ts",
    "drizzle/0055_certain_infant_terrible.sql",
    "drizzle-pg/0033_puzzling_hitman.sql",
    "src/shared/reports.ts",
    "src/server/features/reports/repositories/ReportRepository.ts",
    "src/server/features/reports/services/reportSections.ts",
    "src/server/features/reports/services/ReportService.ts",
    "src/serverFunctions/reports.ts",
    "src/types/schemas/reports.ts",
    "src/db/reports.schema.ts",
    "src/db/pg/reports.schema.ts",
    "drizzle/0056_majestic_forgotten_one.sql",
    "drizzle-pg/0034_shocking_masked_marvel.sql",
    "src/client/features/reports/reportsCopy.ts",
    "src/client/features/reports/ReportsPage.tsx",
    "src/client/features/reports/ReportDetail.tsx",
    "src/routes/_project/p/$projectId/reports.tsx",
    "src/routes/_project/p/$projectId/reports/index.tsx",
    "src/routes/_project/p/$projectId/reports/$reportId.tsx",
    "src/shared/reports.ts",
    "src/server/features/reports/repositories/SharingRepository.ts",
    "src/server/features/reports/repositories/BrandingRepository.ts",
    "src/server/features/reports/services/ShareService.ts",
    "src/server/features/reports/services/BrandingService.ts",
    "src/server/features/reports/services/brandLogo.ts",
    "src/serverFunctions/branding.ts",
    "src/types/schemas/branding.ts",
    "src/db/report-sharing.schema.ts",
    "src/db/pg/report-sharing.schema.ts",
    "drizzle/0057_round_midnight.sql",
    "drizzle-pg/0035_complex_sandman.sql",
    "src/routes/r/$token.tsx",
    "src/routes/api/public-report.ts",
    "src/routes/api/brand-logo.ts",
    "src/client/features/reports/ReportSections.tsx",
    "src/client/features/reports/ShareReportModal.tsx",
    "src/client/features/reports/PublicReportPage.tsx",
    "src/client/features/reports/BrandingSettings.tsx",
    "src/client/features/reports/ExportReportButtons.tsx",
    "src/client/features/projects/ProjectSettings.tsx",
    "src/server/features/reports/services/printModel.ts",
    "src/server/features/reports/services/pdfDocument.ts",
    "src/server/features/reports/services/printHtml.ts",
    "src/server/features/reports/services/ExportService.ts",
    "src/routes/api/report-export.ts",
    ...AUTOPILOT_LOCK_FILES,
    "wrangler.jsonc",
    "src/server.ts",
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

describe("canonical page identity single-helper (spec 006, G1)", () => {
  // Every analytical page-identity consumer routes through canonicalUrl from
  // @/shared/intelligence — the single SEO page identity (G1). GA4 sync
  // storage keeps the strict path normalizer (storage grain, not identity);
  // audit crawl keeps its strict canonicalUrlKey (documented P24 exception
  // for redirect-loop safety). Domain-grain www-folds elsewhere (domain
  // display, onboarding, provider targets) are a different concern and are
  // intentionally NOT covered by this guard.
  const IDENTITY_CONSUMERS = [
    "src/server/features/intelligence/services/AnalyticsJoinService.ts",
    "src/server/features/intelligence/detectors/contentDecay.ts",
    "src/server/features/intelligence/detectors/cannibalization.ts",
    "src/server/features/intelligence/detectors/technicalOnImportantPage.ts",
    // Spec 010: rank-snapshot canonicalization in the organic-join pre-fetch
    // helpers. engagementDrop.ts consumes already-canonical join output and
    // needs no direct import; conversionDrop.ts is site-level (no URLs).
    "src/server/features/intelligence/detectors/organicJoin.ts",
  ];
  const STRICT_PATH_ALLOWLIST = new Set([
    // Defines the strict path policy.
    "src/shared/ga4.ts",
    // Composes the strict path branch into the analytical identity.
    "src/shared/intelligence.ts",
    // GA4 sync storage grain (stored landingPage values, never identity).
    "src/server/features/ga4/services/ga4SyncNormalize.ts",
  ]);

  it("all analytical page-identity consumers import the single helper", () => {
    for (const file of IDENTITY_CONSUMERS) {
      const content = readSurface(file);
      expect(
        /import\s*\{[^}]*\bcanonicalUrl\b[^}]*\}\s*from\s*["']@\/shared\/intelligence["']/.test(
          content,
        ),
        `${file} must import canonicalUrl from @/shared/intelligence`,
      ).toBe(true);
    }
  });

  it("no production file outside the allowlist imports the strict path normalizer", () => {
    const root = resolve(process.cwd(), "src");
    const violations: string[] = [];
    for (const file of sourceFilesRecursive(root)) {
      const relative = file
        .replace(resolve(process.cwd()), "")
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      if (
        relative.endsWith(".test.ts") ||
        relative.endsWith(".test.tsx") ||
        STRICT_PATH_ALLOWLIST.has(relative)
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        if (
          /from\s*["']/.test(line) &&
          line.includes("normalizeGa4LandingPage")
        ) {
          violations.push(`${relative}: ${line.trim()}`);
        }
      }
    }
    expect(
      violations,
      "strict path normalizer imports outside the allowlist",
    ).toEqual([]);
  });

  it("no parallel page canonicalizer is defined anywhere else", () => {
    const root = resolve(process.cwd(), "src");
    const violations: string[] = [];
    for (const file of sourceFilesRecursive(root)) {
      const relative = file
        .replace(resolve(process.cwd()), "")
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      if (
        relative.endsWith(".test.ts") ||
        relative.endsWith(".test.tsx") ||
        relative === "src/shared/intelligence.ts"
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      for (const line of content.split("\n")) {
        // Page-identity forks: a second canonicalUrl definition, or any
        // canonicalPage* page canonicalizer. (Audit's canonicalUrlKey is
        // intentionally named differently and is the documented exception;
        // keyword/snapshot canonicalizers — canonicalKeyword,
        // canonicalKeywordKey, canonicalSerpSnapshot — are different grains
        // and are unaffected by this pattern.)
        if (
          /export\s+(function|const)\s+canonicalUrl\s*[=(<]/.test(line) ||
          /export\s+(function|const)\s+canonicalPage\w*/.test(line)
        ) {
          violations.push(`${relative}: ${line.trim()}`);
        }
      }
    }
    expect(violations, "parallel page canonicalizer definitions").toEqual([]);
  });

  it("cross-source page joins happen only through AnalyticsJoinService (spec 010, FR-005)", () => {
    // The pure join is defined once; only detector fetchers may call it
    // (pre-fetched rows in). A second ad-hoc join implementation anywhere
    // else is a parallel system (P2).
    const JOIN_CALLERS = new Set([
      // Definition site.
      "src/server/features/intelligence/services/AnalyticsJoinService.ts",
      // engagement_drop fetcher: builds join inputs from pre-fetched rows.
      // (conversionDrop.ts is site-level and never joins; organicJoin.ts only
      // pre-fetches rows and never calls the join itself.)
      "src/server/features/intelligence/detectors/engagementDrop.ts",
    ]);
    const root = resolve(process.cwd(), "src");
    const violations: string[] = [];
    for (const file of sourceFilesRecursive(root)) {
      const relative = file
        .replace(resolve(process.cwd()), "")
        .replace(/\\/g, "/")
        .replace(/^\//, "");
      if (
        relative.endsWith(".test.ts") ||
        relative.endsWith(".test.tsx") ||
        JOIN_CALLERS.has(relative)
      ) {
        continue;
      }
      const content = readFileSync(file, "utf8");
      if (/\bjoinUrlEvidence\s*\(/.test(content)) {
        violations.push(relative);
      }
    }
    expect(violations, "joinUrlEvidence callers outside the allowlist").toEqual(
      [],
    );
  });
});
