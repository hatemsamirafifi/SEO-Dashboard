import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * final-plan §9.4: `active28DayUsers` is excluded from the MVP entirely —
 * no column, no contract, no UI. Enforced at string level across the GA4
 * surface. (A metric identifier like this cannot legitimately appear in
 * prose comments either, so a raw full-file scan is the reliable guard.)
 */
const GA4_SURFACE_FILES = [
  "src/shared/ga4.ts",
  "src/server/lib/ga4Client.ts",
  "src/server/features/ga4/services/Ga4Service.ts",
  "src/server/features/ga4/services/Ga4SyncService.ts",
  "src/server/features/ga4/services/ga4SyncUtils.ts",
  "src/server/features/ga4/services/ga4SyncNormalize.ts",
  "src/server/features/ga4/services/scheduledGa4Sync.ts",
  "src/server/features/ga4/repositories/Ga4SyncRepository.ts",
  "src/server/features/ga4/repositories/Ga4ConnectionRepository.ts",
  "src/server/features/ga4/services/AnalyticsService.ts",
  "src/db/ga4.schema.ts",
  "src/db/pg/ga4.schema.ts",
  "src/types/schemas/ga4.ts",
  "src/serverFunctions/ga4.ts",
  "src/client/features/ga4/AnalyticsConnectionCard.tsx",
  "src/client/features/ga4/Ga4SyncStatus.tsx",
  "src/client/features/ga4/syncStatusCopy.ts",
  "src/client/features/analytics/analyticsCopy.ts",
  "src/client/features/analytics/AnalyticsFilterToolbar.tsx",
  "src/client/features/analytics/AnalyticsSections.tsx",
  "src/client/features/analytics/AnalyticsExtendedSections.tsx",
  "src/client/features/analytics/AnalyticsPage.tsx",
  "src/routes/_project/p/$projectId/analytics.tsx",
];

function readSurface(file: string): string {
  return readFileSync(resolve(process.cwd(), file), "utf8");
}

describe("GA4 active28DayUsers absence", () => {
  it("never appears in any GA4 contract, client, storage, or UI file", () => {
    for (const file of GA4_SURFACE_FILES) {
      const content = readSurface(file);
      expect(
        content.includes("active28DayUsers"),
        `${file} must not contain active28DayUsers`,
      ).toBe(false);
    }
  });
});

describe("GA4 averageSessionDuration absence", () => {
  it("is never fetched, stored, or displayed (derived engagement-time metric only, §9.4)", () => {
    for (const file of GA4_SURFACE_FILES) {
      const content = readSurface(file);
      expect(
        content.includes("averageSessionDuration"),
        `${file} must not contain averageSessionDuration`,
      ).toBe(false);
    }
  });
});

describe("GA4 no-SUM-users invariant", () => {
  it("never aggregates total_users/active_users in SQL or helpers", () => {
    const storageFiles = [
      "src/server/features/ga4/repositories/Ga4SyncRepository.ts",
      "src/server/features/ga4/services/Ga4SyncService.ts",
      "src/server/features/ga4/services/ga4SyncNormalize.ts",
      "src/server/features/ga4/services/Ga4Service.ts",
      "src/server/features/ga4/services/AnalyticsService.ts",
      "src/server/lib/ga4Client.ts",
    ];
    const forbidden = [
      /sum\([^)]*(totalUsers|total_users|activeUsers|active_users)/i,
      /(totalUsers|activeUsers)\s*\+\s*=?/i,
      /\.reduce\(\s*\([^)]*(totalUsers|activeUsers)/i,
    ];
    for (const file of storageFiles) {
      const content = readSurface(file);
      for (const pattern of forbidden) {
        expect(
          pattern.test(content),
          `${file} must not aggregate distinct users (${pattern})`,
        ).toBe(false);
      }
    }
  });
});
