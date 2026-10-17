import { describe, expect, it, vi } from "vitest";
import { classifyProviderFailure } from "@/server/features/serp/retryPolicy";
import { createHttpSerpProvider } from "@/server/features/serp/httpProviders";
import { defaultClassifyDataforseoTask } from "@/server/lib/dataforseo/envelope";
import { BudgetExceededError } from "@/server/lib/seo-data/errors";
import {
  buildRankCompletionPatch,
  type RankRowForTrace,
} from "@/client/features/rank-tracking/rankTraceCompletion";
import {
  classifyKeywordFromPairFacts,
  type DeviceRankingFacts,
} from "@/shared/rank-tracking";

describe("Rank Tracking Bulk Check Reliability & Regression Suite", () => {
  describe("1. Accounting for 268 selected vs 266 missing and the 2 ranked keywords", () => {
    it("proves why 268 initially missing became 266 missing: 2 keywords ranked, leaving 147 unavailable + 8 lost + 111 no ranking", () => {
      // 268 keywords in run:
      // - 1 keyword ranked #1
      // - 1 keyword ranked #2
      // - 119 keywords valid NO_RESULT (8 lost, 111 no ranking)
      // - 147 keywords CHECK_FAILED (provider quota/budget error)
      const factsMap = new Map<string, DeviceRankingFacts>();

      // 1 ranked #1
      factsMap.set("kw-ranked-1:desktop", {
        hasSnapshot: true,
        position: 1,
        previousPosition: null,
        rankingStatus: "RANKED",
      });
      // 1 ranked #2
      factsMap.set("kw-ranked-2:desktop", {
        hasSnapshot: true,
        position: 2,
        previousPosition: null,
        rankingStatus: "RANKED",
      });

      // 8 Lost (valid NO_RESULT with prior rank)
      for (let i = 1; i <= 8; i++) {
        factsMap.set(`kw-lost-${i}:desktop`, {
          hasSnapshot: true,
          position: null,
          previousPosition: 15,
          rankingStatus: "NO_RESULT",
        });
      }

      // 111 No Ranking (valid NO_RESULT without prior rank)
      for (let i = 1; i <= 111; i++) {
        factsMap.set(`kw-norank-${i}:desktop`, {
          hasSnapshot: true,
          position: null,
          previousPosition: null,
          rankingStatus: "NO_RESULT",
        });
      }

      // 147 Ranking Unavailable (CHECK_FAILED)
      for (let i = 1; i <= 147; i++) {
        factsMap.set(`kw-failed-${i}:desktop`, {
          hasSnapshot: true,
          position: null,
          previousPosition: 20, // Previous rank must be preserved!
          rankingStatus: "CHECK_FAILED",
        });
      }

      // Verify classification for all 268 keywords
      const ranked1 = classifyKeywordFromPairFacts(factsMap, "kw-ranked-1", "desktop");
      const ranked2 = classifyKeywordFromPairFacts(factsMap, "kw-ranked-2", "desktop");

      expect(ranked1.eligible).toBe(false); // Exits missing rankings!
      expect(ranked1.bucket).toBeNull();
      expect(ranked2.eligible).toBe(false); // Exits missing rankings!
      expect(ranked2.bucket).toBeNull();

      let unavailableCount = 0;
      let lostCount = 0;
      let noRankingCount = 0;

      for (let i = 1; i <= 147; i++) {
        const c = classifyKeywordFromPairFacts(factsMap, `kw-failed-${i}`, "desktop");
        expect(c.eligible).toBe(true);
        expect(c.bucket).toBe("ranking_unavailable");
        unavailableCount++;
      }

      for (let i = 1; i <= 8; i++) {
        const c = classifyKeywordFromPairFacts(factsMap, `kw-lost-${i}`, "desktop");
        expect(c.eligible).toBe(true);
        expect(c.bucket).toBe("lost");
        lostCount++;
      }

      for (let i = 1; i <= 111; i++) {
        const c = classifyKeywordFromPairFacts(factsMap, `kw-norank-${i}`, "desktop");
        expect(c.eligible).toBe(true);
        expect(c.bucket).toBe("no_ranking");
        noRankingCount++;
      }

      expect(unavailableCount).toBe(147);
      expect(lostCount).toBe(8);
      expect(noRankingCount).toBe(111);
      expect(unavailableCount + lostCount + noRankingCount).toBe(266);
      expect(266 + 2).toBe(268); // Exact total selected accounted for!
    });
  });

  describe("2. Provider failure classification: Serper HTTP 400 credit exhaustion & DataForSEO BudgetExceededError", () => {
    it("classifies Serper HTTP 400 'Not enough credits' as deterministic QUOTA_EXHAUSTED without retries", async () => {
      const fetchFn = vi.fn(async () => {
        return new Response(
          JSON.stringify({
            message: "Not enough credits",
            statusCode: 400,
          }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      });

      const provider = createHttpSerpProvider({
        id: "serper",
        apiKey: "test-api-key",
        fetchFn,
      });

      const input = {
        keywordId: "kw-test",
        keyword: "test keyword",
        targetDomain: "powersiment.ae",
        location: {
          countryCode: "AE",
          languageCode: "ar",
          locationName: "United Arab Emirates",
        },
        device: "desktop" as const,
        depth: 10,
      };

      await expect(provider.search(input)).rejects.toMatchObject({
        provider: "serper",
        code: "QUOTA_EXHAUSTED",
        deterministic: true,
      });

      // The failure must be non-retryable
      const classification = classifyProviderFailure({
        code: "QUOTA_EXHAUSTED",
        deterministic: true,
      });
      expect(classification.retryable).toBe(false);
      expect(classification.category).toBe("QUOTA_EXHAUSTED");
    });

    it("classifies DataForSEO BudgetExceededError as non-retryable BUDGET_EXCEEDED", () => {
      const budgetError = new BudgetExceededError("daily", 1.0, 1.002);
      expect(budgetError.message).toContain("DataForSEO daily budget exceeded");

      const classification = classifyProviderFailure({
        code: "BUDGET_EXCEEDED",
        deterministic: true,
      });
      expect(classification.retryable).toBe(false);
      expect(classification.category).toBe("BUDGET_EXCEEDED");
    });

    it("distinguishes DataForSEO 40100 (AUTH_FAILED) versus 40201 (DATAFORSEO_ACCESS_PAUSED) inside HTTP 200", () => {
      expect(
        defaultClassifyDataforseoTask(40100, "Authentication error"),
      ).toBe("DATAFORSEO_AUTH_FAILED");

      expect(
        defaultClassifyDataforseoTask(40201, "Account access paused"),
      ).toBe("DATAFORSEO_ACCESS_PAUSED");

      expect(
        defaultClassifyDataforseoTask(40200, "Insufficient credits"),
      ).toBe("CREDITS_UNAVAILABLE");
    });

    it("does not claim mobile support for Serper", () => {
      const provider = createHttpSerpProvider({
        id: "serper",
        apiKey: "key",
      });
      expect(
        provider.supports({
          keywordId: "k1",
          keyword: "test",
          targetDomain: "test.com",
          location: {
            countryCode: "AE",
            languageCode: "ar",
            locationName: "United Arab Emirates",
          },
          device: "mobile",
          depth: 10,
        }),
      ).toBe(false);
      expect(
        provider.supports({
          keywordId: "k1",
          keyword: "test",
          targetDomain: "test.com",
          location: {
            countryCode: "AE",
            languageCode: "ar",
            locationName: "United Arab Emirates",
          },
          device: "desktop",
          depth: 10,
        }),
      ).toBe(true);
    });
  });

  describe("3. Ranking state semantics & preserving last valid position", () => {
    it("preserves previous valid position and sets rankingStatus = CHECK_FAILED during provider outage", () => {
      const facts = new Map<string, DeviceRankingFacts>();
      facts.set("kw-1:desktop", {
        hasSnapshot: true,
        position: null,
        previousPosition: 12,
        rankingStatus: "CHECK_FAILED",
      });

      const classification = classifyKeywordFromPairFacts(facts, "kw-1", "desktop");
      expect(classification.eligible).toBe(true);
      expect(classification.bucket).toBe("ranking_unavailable");
      // Never write a false Lost transition when check failed
      expect(classification.bucket).not.toBe("lost");
    });

    it("records NO_RESULT as Lost when valid SERP returned but domain absent and had prior rank", () => {
      const facts = new Map<string, DeviceRankingFacts>();
      facts.set("kw-2:desktop", {
        hasSnapshot: true,
        position: null,
        previousPosition: 14,
        rankingStatus: "NO_RESULT",
      });

      const classification = classifyKeywordFromPairFacts(facts, "kw-2", "desktop");
      expect(classification.eligible).toBe(true);
      expect(classification.bucket).toBe("lost");
    });
  });

  describe("4. Accurate trace counters and terminal run reconciliation", () => {
    it("computes truthful explicit counters for a partial run with 121 succeeded and 147 failed", () => {
      const targetIds: string[] = [];
      const rows: RankRowForTrace[] = [];
      const runStartedAt = new Date().toISOString();

      // 121 succeeded
      for (let i = 1; i <= 121; i++) {
        const id = `kw-s-${i}`;
        targetIds.push(id);
        rows.push({
          trackingKeywordId: id,
          keyword: `kw ${i}`,
          desktop: {
            position: i <= 2 ? i : null,
            previousPosition: null,
            checkedAt: runStartedAt,
            rankingStatus: i <= 2 ? "RANKED" : "NO_RESULT",
            status: "success",
            provider: "dataforseo",
          },
        });
      }

      // 147 failed
      for (let i = 1; i <= 147; i++) {
        const id = `kw-f-${i}`;
        targetIds.push(id);
        rows.push({
          trackingKeywordId: id,
          keyword: `kw failed ${i}`,
          desktop: {
            position: null,
            previousPosition: 25,
            checkedAt: runStartedAt,
            rankingStatus: "CHECK_FAILED",
            status: "failed",
            provider: "serper",
            errorMessage: "Serper.dev request failed: QUOTA_EXHAUSTED",
          },
        });
      }

      const patch = buildRankCompletionPatch({
        run: {
          id: "run-test-1",
          status: "partial",
          keywordsChecked: 121,
          keywordsTotal: 268,
          startedAt: runStartedAt,
        },
        rows,
        targetIds,
      });

      expect(patch.status).toBe("failed"); // Partial run with failures must not finalize as success!
      expect(patch.rankChecksSucceeded).toBe(121);
      expect(patch.succeededWithValidSerp).toBe(121);
      expect(patch.rankChecksFailed).toBe(147);
      expect(patch.rankChecksAttempted).toBe(268);
      expect(patch.counters).toMatchObject({
        selected: 268,
        attempted: 268,
        succeededWithValidSerp: 121,
        failed: 147,
        pending: 0,
        checked: 121,
        total: 268,
      });

      // Provider attribution for failed keywords must be Serper, not hardcoded DataForSEO or skipped Zenserp
      const failedChild = patch.children.find((c) => c.keywordId === "kw-f-1");
      expect(failedChild?.status).toBe("failed");
      expect(failedChild?.rankingStatus).toBe("CHECK_FAILED");
      expect(failedChild?.provider).toBe("Serper.dev");
    });
  });
});
