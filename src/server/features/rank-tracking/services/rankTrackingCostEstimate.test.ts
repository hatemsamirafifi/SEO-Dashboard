import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getConfigById: vi.fn(),
  getKeywordsForConfig: vi.fn(),
  getTargetsForConfig: vi.fn(),
  getKeywordTargetsForTargets: vi.fn(),
  getProjectBindingByLocalProject: vi.fn(),
  resolveEffectiveSeRankingConfig: vi.fn(),
  dbSelect: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: {} }));

vi.mock("@/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => Promise.resolve([{ organizationId: "org-1" }]),
        }),
      }),
    }),
  },
}));

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingRepository",
  () => ({
    RankTrackingRepository: {
      getConfigById: mocks.getConfigById,
      getKeywordsForConfig: mocks.getKeywordsForConfig,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/RankTrackingTargetRepository",
  () => ({
    RankTrackingTargetRepository: {
      getTargetsForConfig: mocks.getTargetsForConfig,
      getKeywordTargetsForTargets: mocks.getKeywordTargetsForTargets,
    },
  }),
);

vi.mock(
  "@/server/features/rank-tracking/repositories/SeRankingBindingRepository",
  () => ({
    SeRankingBindingRepository: {
      getProjectBindingByLocalProject: mocks.getProjectBindingByLocalProject,
    },
  }),
);

vi.mock("@/server/features/settings/services/SeRankingSettingsService", () => ({
  resolveEffectiveSeRankingConfig: mocks.resolveEffectiveSeRankingConfig,
}));

const SAMPLE_CONFIG = {
  id: "cfg-test-1",
  projectId: "proj-test-1",
  domain: "example.com",
  locationCode: 2818,
  languageCode: "ar",
  devices: "both" as const,
  serpDepth: 100,
  scheduleInterval: "weekly" as const,
  isActive: true,
};

describe(
  "RankTrackingService.estimateCost - regression tests",
  { timeout: 30000 },
  () => {
    beforeEach(() => {
      vi.resetModules();
      for (const mock of Object.values(mocks)) mock.mockReset();
      mocks.getConfigById.mockResolvedValue(SAMPLE_CONFIG);
    });

    it("1. Unbound new project: resolves SE Ranking provider from settings when no remote project binding exists yet", async () => {
      // Project has SE Ranking enabled in settings, but no remote binding row yet
      mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
        enabled: true,
        apiKey: "test-key",
        source: "project",
      });
      mocks.getProjectBindingByLocalProject.mockResolvedValue(null);

      mocks.getKeywordsForConfig.mockResolvedValue([
        { id: "kw-1", keyword: "seo tools" },
        { id: "kw-2", keyword: "rank tracker" },
      ]);

      // Active targets: 2 (e.g. desktop + mobile)
      mocks.getTargetsForConfig.mockResolvedValue([
        { id: "t-1", device: "desktop", enabled: true },
        { id: "t-2", device: "mobile", enabled: true },
      ]);
      mocks.getKeywordTargetsForTargets.mockResolvedValue([]);

      const { RankTrackingService } = await import("./RankTrackingService");
      const result = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
      );

      // Provider resolved to SE Ranking
      expect(result.provider).toBe("seranking");
      expect(result.pricingModel).toBe("subscription_quota");
      // Direct monetary cost is strictly null, never free or $0.00
      expect(result.costUsd).toBeNull();
      expect(result.costCredits).toBeNull();
      expect(result.keywordCount).toBe(2);
      expect(result.targetCount).toBe(2);
      expect(result.totalChecks).toBe(4);
      expect(result.method).toBe("queued");
    });

    it("2. Partial keyword-target assignments: calculates totalChecks exactly for explicit active pairs", async () => {
      mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
        enabled: true,
        apiKey: "test-key",
      });
      mocks.getProjectBindingByLocalProject.mockResolvedValue(null);

      mocks.getKeywordsForConfig.mockResolvedValue([
        { id: "kw-1", keyword: "keyword one" },
        { id: "kw-2", keyword: "keyword two" },
        { id: "kw-3", keyword: "keyword three" },
      ]);

      const targetDesktop = {
        id: "t-desktop",
        device: "desktop",
        enabled: true,
      };
      const targetMobile = { id: "t-mobile", device: "mobile", enabled: true };
      mocks.getTargetsForConfig.mockResolvedValue([
        targetDesktop,
        targetMobile,
      ]);

      // kw-1: only desktop enabled, mobile disabled
      // kw-2: both desktop and mobile enabled
      // kw-3: no row in keywordTargets -> default inherits all active targets
      mocks.getKeywordTargetsForTargets.mockResolvedValue([
        {
          trackingKeywordId: "kw-1",
          trackingTargetId: "t-desktop",
          enabled: true,
        },
        {
          trackingKeywordId: "kw-1",
          trackingTargetId: "t-mobile",
          enabled: false,
        },
        {
          trackingKeywordId: "kw-2",
          trackingTargetId: "t-desktop",
          enabled: true,
        },
        {
          trackingKeywordId: "kw-2",
          trackingTargetId: "t-mobile",
          enabled: true,
        },
      ]);

      const { RankTrackingService } = await import("./RankTrackingService");

      // All keywords check: kw1 (1) + kw2 (2) + kw3 (2) = 5 checks
      const allResult = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
      );
      expect(allResult.keywordCount).toBe(3);
      expect(allResult.totalChecks).toBe(5);

      // Scoped keywords check (e.g., user selected only kw-1): 1 check
      const kw1Result = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
        ["kw-1"],
      );
      expect(kw1Result.keywordCount).toBe(1);
      expect(kw1Result.totalChecks).toBe(1);

      // Scoped keywords check (kw-1 and kw-2): 1 + 2 = 3 checks
      const kw1And2Result = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
        ["kw-1", "kw-2"],
      );
      expect(kw1And2Result.keywordCount).toBe(2);
      expect(kw1And2Result.totalChecks).toBe(3);
    });

    it("3. Multiple markets: handles arbitrary targets across countries, cities, languages, and devices", async () => {
      mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
        enabled: true,
        apiKey: "test-key",
      });
      mocks.getProjectBindingByLocalProject.mockResolvedValue(null);

      mocks.getKeywordsForConfig.mockResolvedValue([
        { id: "kw-1", keyword: "cross-border logistics" },
      ]);

      // 4 active targets across multiple markets (Egypt, Saudi, UAE, US)
      mocks.getTargetsForConfig.mockResolvedValue([
        {
          id: "t-eg",
          countryCode: "eg",
          cityName: null,
          languageCode: "ar",
          device: "desktop",
          enabled: true,
        },
        {
          id: "t-sa",
          countryCode: "sa",
          cityName: "Riyadh",
          languageCode: "ar",
          device: "mobile",
          enabled: true,
        },
        {
          id: "t-ae",
          countryCode: "ae",
          cityName: "Dubai",
          languageCode: "en",
          device: "desktop",
          enabled: true,
        },
        {
          id: "t-us",
          countryCode: "us",
          cityName: "New York",
          languageCode: "en",
          device: "mobile",
          enabled: true,
        },
      ]);
      mocks.getKeywordTargetsForTargets.mockResolvedValue([]);

      const { RankTrackingService } = await import("./RankTrackingService");
      const result = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
      );

      expect(result.keywordCount).toBe(1);
      expect(result.targetCount).toBe(4);
      expect(result.totalChecks).toBe(4);
      expect(result.costUsd).toBeNull();
    });

    it("4. Provider switching: switches between DataForSEO per-serp USD pricing and SE Ranking quota pricing", async () => {
      mocks.getKeywordsForConfig.mockResolvedValue([
        { id: "kw-1", keyword: "test keyword 1" },
        { id: "kw-2", keyword: "test keyword 2" },
      ]);
      mocks.getTargetsForConfig.mockResolvedValue([
        { id: "t-1", device: "desktop", enabled: true },
        { id: "t-2", device: "mobile", enabled: true },
      ]);
      mocks.getKeywordTargetsForTargets.mockResolvedValue([]);

      const { RankTrackingService } = await import("./RankTrackingService");

      // Case A: DataForSEO active (SE Ranking disabled in settings & no binding)
      mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
        enabled: false,
      });
      mocks.getProjectBindingByLocalProject.mockResolvedValue(null);

      const dataForSeoResult = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
      );

      expect(dataForSeoResult.provider).toBe("dataforseo");
      expect(dataForSeoResult.pricingModel).toBe("per_serp_usd");
      expect(typeof dataForSeoResult.costUsd).toBe("number");
      expect(dataForSeoResult.costUsd).toBeGreaterThan(0);
      expect(dataForSeoResult.costCredits).toBeGreaterThan(0);
      expect(dataForSeoResult.totalChecks).toBe(4);

      // Case B: Switched to SE Ranking
      mocks.resolveEffectiveSeRankingConfig.mockResolvedValue({
        enabled: true,
        apiKey: "seranking-api-key",
      });

      const seRankingResult = await RankTrackingService.estimateCost(
        "cfg-test-1",
        "proj-test-1",
        "org-1",
      );

      expect(seRankingResult.provider).toBe("seranking");
      expect(seRankingResult.pricingModel).toBe("subscription_quota");
      expect(seRankingResult.costUsd).toBeNull();
      expect(seRankingResult.costCredits).toBeNull();
      expect(seRankingResult.totalChecks).toBe(4);
    });
  },
);
