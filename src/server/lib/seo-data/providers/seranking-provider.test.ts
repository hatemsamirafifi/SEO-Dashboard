/* eslint-disable eslint/max-lines, eslint/max-lines-per-function */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@/db", () => ({
  db: {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          orderBy: vi.fn(() => ({
            limit: vi.fn().mockResolvedValue([]),
          })),
        })),
      })),
    })),
    insert: vi.fn(() => ({
      values: vi.fn().mockResolvedValue(undefined),
    })),
  },
}));

import type * as SeRankingModule from "@/server/lib/seranking";
import { createSerankingProvider } from "./seranking-provider";

vi.mock("@/server/features/settings/services/SeRankingSettingsService", () => ({
  resolveEffectiveSeRankingConfig: vi.fn(),
}));

vi.mock("@/server/lib/seranking", async (importOriginal) => {
  const actual = await importOriginal<typeof SeRankingModule>();
  return {
    ...actual,
    createSeRankingClient: vi.fn(),
    getExportKeywords: vi.fn(),
    getSimilarKeywords: vi.fn(),
    getDomainOverview: vi.fn(),
    getDomainKeywords: vi.fn(),
    getDomainPages: vi.fn(),
    getDomainCompetitors: vi.fn(),
    getBacklinksSummary: vi.fn(),
    getReferringDomains: vi.fn(),
    getBacklinksHistory: vi.fn(),
    reserveSeRankingCredits: vi.fn(async () => ({
      reservationId: "res-test",
      organizationId: "org-test",
      estimatedUnits: 100,
      commit: vi.fn(async () => {}),
      release: vi.fn(async () => {}),
    })),
  };
});

describe("SerankingProvider", () => {
  const provider = createSerankingProvider();
  const testBillingCustomer = {
    organizationId: "org_1",
    userId: "user_1",
    userEmail: "user@example.com",
  };

  it("has name 'seranking'", () => {
    expect(provider.name).toBe("seranking");
  });

  describe("supports()", () => {
    it("supports keyword_ideas with keyword", () => {
      expect(
        provider.supports({
          dataType: "keyword_ideas",
          keyword: "seo",
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(true);

      expect(
        provider.supports({
          dataType: "keyword_ideas",
          keyword: "",
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(false);
    });

    it("supports keyword_metrics with keywords", () => {
      expect(
        provider.supports({
          dataType: "keyword_metrics",
          keywords: ["seo", "rankings"],
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(true);

      expect(
        provider.supports({
          dataType: "keyword_metrics",
          keywords: [],
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(false);
    });

    it("supports domain_overview, domain_keywords, domain_pages", () => {
      const base = {
        domain: "example.com",
        billingCustomer: testBillingCustomer,
      };

      expect(provider.supports({ ...base, dataType: "domain_overview" })).toBe(
        true,
      );
      expect(provider.supports({ ...base, dataType: "domain_keywords" })).toBe(
        true,
      );
      expect(provider.supports({ ...base, dataType: "domain_pages" })).toBe(
        true,
      );
    });

    it("supports competitors and backlinks", () => {
      const base = {
        domain: "example.com",
        billingCustomer: testBillingCustomer,
      };

      expect(provider.supports({ ...base, dataType: "competitors" })).toBe(
        true,
      );
      expect(provider.supports({ ...base, dataType: "backlinks" })).toBe(true);
      expect(
        provider.supports({ ...base, dataType: "competitive_metrics" }),
      ).toBe(true);
    });

    it("does not support site_audit or serp directly", () => {
      expect(
        provider.supports({
          dataType: "site_audit",
          url: "https://example.com",
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(false);

      expect(
        provider.supports({
          dataType: "serp",
          keyword: "test",
          billingCustomer: testBillingCustomer,
        }),
      ).toBe(false);
    });
  });

  describe("get()", () => {
    beforeEach(() => {
      vi.clearAllMocks();
    });

    it("throws ProviderUnavailableError when not configured", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: false,
        enabled: false,
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "none",
        priority: 1,
      });

      await expect(
        provider.get({
          dataType: "keyword_metrics",
          keywords: ["test"],
          billingCustomer: testBillingCustomer,
        }),
      ).rejects.toThrow(/not configured/);
    });

    it("fetches and normalizes keyword metrics", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getExportKeywords } = await import("@/server/lib/seranking");
      vi.mocked(getExportKeywords).mockResolvedValue([
        {
          keyword: "seo software",
          volume: 5000,
          cpc: 2.5,
          competition: 0.75,
          difficulty: 55,
          intent: "commercial",
          history_trend: [{ date: "2026-01", volume: 4800 }],
        },
      ]);

      const result = await provider.get({
        dataType: "keyword_metrics",
        keywords: ["seo software"],
        locationCode: 2840,
        billingCustomer: testBillingCustomer,
      });

      expect(result).toEqual([
        {
          keyword: "seo software",
          searchVolume: 5000,
          cpc: 2.5,
          competition: 0.75,
          competitionLevel: "HIGH",
          keywordDifficulty: 55,
          intent: "commercial",
          monthlySearches: [
            {
              year: 2026,
              month: 1,
              searchVolume: 4800,
            },
          ],
        },
      ]);
    });

    it("fetches and normalizes keyword ideas for Arabic keyword and Egypt", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getSimilarKeywords } = await import("@/server/lib/seranking");
      vi.mocked(getSimilarKeywords).mockResolvedValue([
        {
          keyword: "عطور رجالية",
          volume: 2400,
          cpc: 0.85,
          difficulty: 32,
          competition: 0.65,
          intent: "commercial",
          history_trend: [{ date: "2026-01-01", volume: 2400 }],
        },
      ]);

      const result = (await provider.get({
        dataType: "keyword_ideas",
        keyword: "عطور رجالية",
        locationCode: 2818,
        billingCustomer: testBillingCustomer,
        constraints: {
          limit: 150,
          source: "suggestions",
        },
      })) as Array<{
        keyword: string;
        keyword_info: {
          search_volume: number;
          cpc: number;
          competition: number;
          monthly_searches: Array<{
            year: number;
            month: number;
            search_volume: number;
          }>;
        };
        keyword_properties: {
          keyword_difficulty: number;
        };
        search_intent_info: {
          main_intent: string;
        };
      }>;

      expect(getSimilarKeywords).toHaveBeenCalledWith(
        undefined,
        expect.objectContaining({
          keyword: "عطور رجالية",
          source: "eg",
          limit: 150,
        }),
      );

      expect(result).toHaveLength(1);
      expect(result[0].keyword).toBe("عطور رجالية");
      expect(result[0].keyword_info.search_volume).toBe(2400);
      expect(result[0].keyword_info.cpc).toBe(0.85);
      expect(result[0].keyword_info.competition).toBe(0.65);
      expect(result[0].keyword_properties.keyword_difficulty).toBe(32);
      expect(result[0].search_intent_info.main_intent).toBe("commercial");
      expect(result[0].keyword_info.monthly_searches).toEqual([
        { year: 2026, month: 1, search_volume: 2400 },
      ]);
    });

    it("fetches and normalizes domain overview", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getDomainOverview } = await import("@/server/lib/seranking");
      vi.mocked(getDomainOverview).mockResolvedValue({
        organic: {
          keywords_count: 1200,
          traffic_sum: 8500,
        },
      });

      const result = await provider.get({
        dataType: "domain_overview",
        domain: "example.com",
        locationCode: 2840,
        billingCustomer: testBillingCustomer,
      });

      expect(result).toEqual([
        {
          metrics: {
            organic: {
              etv: 8500,
              count: 1200,
            },
          },
        },
      ]);
    });

    it("fetches and normalizes backlinks summary", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getBacklinksSummary } = await import("@/server/lib/seranking");
      vi.mocked(getBacklinksSummary).mockResolvedValue({
        target: "example.com",
        total_backlinks: 45000,
        referring_domains: 950,
        domain_inlink_rank: 52.3,
        new_backlinks: 100,
        lost_backlinks: 20,
      });

      const result = await provider.get({
        dataType: "backlinks",
        domain: "example.com",
        constraints: { backlinkCall: "summary" },
        billingCustomer: testBillingCustomer,
      });

      expect(result).toEqual({
        target: "example.com",
        rank: 52.3,
        backlinks: 45000,
        referring_domains: 950,
        new_backlinks: 100,
        lost_backlinks: 20,
        referring_pages: 45000,
        broken_backlinks: 0,
        broken_pages: 0,
        backlinks_spam_score: null,
      });
    });

    it("fetches and maps genuine backlinks history", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getBacklinksHistory } = await import("@/server/lib/seranking");
      vi.mocked(getBacklinksHistory).mockResolvedValue([
        {
          date: "2026-01-01",
          count: 1200,
          referring_domains: 310,
          new: 15,
          lost: 2,
          inlink_rank: 45,
        },
      ]);

      const result = await provider.get({
        dataType: "backlinks",
        domain: "example.com",
        constraints: { backlinkCall: "history" },
        billingCustomer: testBillingCustomer,
      });

      expect(result).toEqual([
        {
          date: "2026-01-01",
          rank: 45,
          backlinks: 1200,
          referring_domains: 310,
          new_backlinks: 15,
          lost_backlinks: 2,
          new_referring_domains: null,
          lost_referring_domains: null,
        },
      ]);
    });

    it("never fabricates missing history and returns empty array when empty", async () => {
      const { resolveEffectiveSeRankingConfig } =
        await import("@/server/features/settings/services/SeRankingSettingsService");
      vi.mocked(resolveEffectiveSeRankingConfig).mockResolvedValue({
        provider: "seranking",
        configured: true,
        enabled: true,
        apiKey: "valid-key",
        circuitBreakerEnabled: true,
        maxRetries: 2,
        source: "organization",
        priority: 1,
      });

      const { getBacklinksHistory } = await import("@/server/lib/seranking");
      vi.mocked(getBacklinksHistory).mockResolvedValue([]);

      const result = await provider.get({
        dataType: "backlinks",
        domain: "example.com",
        constraints: { backlinkCall: "history" },
        billingCustomer: testBillingCustomer,
      });

      expect(result).toEqual([]);
    });
  });
});
