/**
 * Shared fixtures for the "check missing rankings" service tests: the
 * config, billing customer, keyword rows, and latest-attempt ranking facts.
 * Pure data only — the mocks stay in the test files that own them.
 */
import type { DeviceRankingFacts } from "@/shared/rank-tracking";

export const activeConfig = {
  id: "config_1",
  projectId: "project_1",
  domain: "acme.com",
  locationCode: 2840,
  languageCode: "en",
  locationName: null,
  devices: "both" as const,
  serpDepth: 20,
  scheduleInterval: "weekly" as const,
  isActive: true,
};

export const billingCustomer = {
  userId: "user_1",
  userEmail: "user@example.com",
  organizationId: "org_1",
  projectId: "project_1",
};

export interface KeywordRow {
  id: string;
  configId: string;
  keyword: string;
}

export function makeKeywords(count: number): KeywordRow[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `keyword_${i + 1}`,
    configId: "config_1",
    keyword: `tracked query ${i + 1}`,
  }));
}

/** Latest-attempt pair facts keyed "keywordId:device". */
export function facts(
  entries: Record<
    string,
    | "CHECK_FAILED"
    | "CHECK_FAILED_preserved_7"
    | "NO_RESULT"
    | "lost"
    | "never"
    | (string & {})
  >,
): Map<string, DeviceRankingFacts> {
  const map = new Map<string, DeviceRankingFacts>();
  for (const [key, state] of Object.entries(entries)) {
    if (state === "never") continue;
    if (state === "CHECK_FAILED") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "CHECK_FAILED",
      });
    } else if (state === "CHECK_FAILED_preserved_7") {
      // Latest attempt failed; the state model preserves the older valid #7.
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: 7,
        rankingStatus: "CHECK_FAILED",
      });
    } else if (state === "NO_RESULT") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: null,
        rankingStatus: "NO_RESULT",
      });
    } else if (state === "lost") {
      map.set(key, {
        hasSnapshot: true,
        position: null,
        previousPosition: 8,
        rankingStatus: "NO_RESULT",
      });
    } else {
      const position = parseInt(state, 10);
      map.set(key, {
        hasSnapshot: true,
        position,
        previousPosition: position,
        rankingStatus: "RANKED",
      });
    }
  }
  return map;
}
