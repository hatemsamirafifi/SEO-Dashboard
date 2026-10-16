import { describe, expect, it, vi } from "vitest";
import {
  competitorGapDetector,
  detectCompetitorGap,
  fetchCompetitorGapInput,
  isCompetitorGapInput,
  type CompetitorGapInput,
} from "./competitorGap";
import { InsufficientCoverageError, type DetectorContext } from "./types";

vi.mock("cloudflare:workers", () => ({ env: {} }));

const mockRepo = vi.hoisted(() => ({
  getLatestCompetitorSnapshotsForProject: vi.fn(),
  getProjectDomain: vi.fn(),
  getKeywordSearchVolumes: vi.fn(),
  getLatestFactDate: vi.fn(),
  getDailyGrainFacts: vi.fn(),
}));

vi.mock("@/server/lib/seo-data/competitor-snapshot-repository", () => ({
  getLatestCompetitorSnapshotsForProject:
    mockRepo.getLatestCompetitorSnapshotsForProject,
  getProjectDomain: mockRepo.getProjectDomain,
  getKeywordSearchVolumes: mockRepo.getKeywordSearchVolumes,
}));

vi.mock(
  "@/server/features/gsc/repositories/GscSearchPerformanceRepository",
  () => ({
    GscSearchPerformanceRepository: {
      getLatestFactDate: mockRepo.getLatestFactDate,
      getDailyGrainFacts: mockRepo.getDailyGrainFacts,
    },
  }),
);

const testThresholds = {
  minWindowDays: 28,
  minCoverageRatio: 0.8,
  minCompetitorRank: 10,
  maxFirstPartyPosition: 20,
  minVolume: 50,
};

const dummyCtx: DetectorContext = {
  projectId: "proj-1",
  organizationId: "org-1",
  periodFrom: "2026-09-01",
  periodTo: "2026-09-28",
  thresholds: testThresholds,
  thresholdVersion: 3,
};

const BANNED_CAUSAL_PATTERNS = [
  /\bcaused\b/i,
  /\bcauses\b/i,
  /\bcausing\b/i,
  /\bbecause of/i,
  /\bdue to/i,
  /\bled to/i,
  /\bresulted in/i,
  /\btriggered\b/i,
];

describe("competitor_gap detector", () => {
  it("emits a finding when competitor ranks in top 10 and first-party is absent", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "enterprise crm",
          searchVolume: 1200,
          competitors: [
            {
              domain: "salesforce.com",
              position: 2,
              url: "https://salesforce.com/crm",
            },
            { domain: "hubspot.com", position: 5 },
          ],
          firstPartyPosition: null,
          firstPartyUrl: null,
          factIds: ["fact-1"],
        },
      ],
      thresholds: testThresholds,
    };

    const findings = detectCompetitorGap(dummyCtx, input);
    expect(findings).toHaveLength(1);

    const f = findings[0];
    expect(f.entityKey).toBe("enterprise crm");
    expect(f.entity.keyword).toBe("enterprise crm");
    expect(f.entity.competitorDomain).toBe("salesforce.com");
    expect(f.entity.competitorPosition).toBe(2);
    expect(f.entity.firstPartyPosition).toBeUndefined();
    expect(f.evidence.evidenceType).toBe("observational");
    expect(f.evidence.metrics.searchVolume).toBe(1200);
    expect(f.evidence.metrics.competitorPosition).toBe(2);
    expect(f.evidence.metrics.hasFirstPartyRank).toBe(false);
    expect(f.confidenceScore).toBeGreaterThanOrEqual(40);
    expect(f.coverageFlags.competitorCoverage).toBe(true);
    expect(f.coverageFlags.firstPartyCoverage).toBe(false);

    // Verify secondary competitor appears in correlations
    expect(f.evidence.correlations).toHaveLength(1);
    expect(f.evidence.correlations[0].entityRef).toBe("hubspot.com");

    // Verify observational language has zero banned causal words
    for (const pat of BANNED_CAUSAL_PATTERNS) {
      expect(pat.test(f.explanationFact)).toBe(false);
    }
  });

  it("emits a finding when competitor ranks in top 10 and first-party ranks beyond threshold", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "sales pipeline tracking",
          searchVolume: 450,
          competitors: [{ domain: "pipedrive.com", position: 3 }],
          firstPartyPosition: 35,
          firstPartyUrl: "https://mysite.com/pipeline",
          factIds: ["fact-2"],
        },
      ],
      thresholds: testThresholds,
    };

    const findings = detectCompetitorGap(dummyCtx, input);
    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.entity.firstPartyPosition).toBe(35);
    expect(f.entity.targetUrl).toBe("https://mysite.com/pipeline");
    expect(f.evidence.metrics.hasFirstPartyRank).toBe(true);
    expect(f.explanationFact).toContain("ranks at position 35.0");
  });

  it("emits NO findings when first-party already ranks within threshold (<= 20)", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "lead management software",
          searchVolume: 800,
          competitors: [{ domain: "zoho.com", position: 4 }],
          firstPartyPosition: 6, // Ranks on page 1 - no gap!
          firstPartyUrl: "https://mysite.com/lead-management",
          factIds: ["fact-3"],
        },
      ],
      thresholds: testThresholds,
    };

    const findings = detectCompetitorGap(dummyCtx, input);
    expect(findings).toHaveLength(0);
  });

  it("emits NO findings when search volume is below floor", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "niche obscure feature query",
          searchVolume: 15, // < minVolume of 50
          competitors: [{ domain: "zoho.com", position: 2 }],
          firstPartyPosition: null,
          firstPartyUrl: null,
          factIds: [],
        },
      ],
      thresholds: testThresholds,
    };

    const findings = detectCompetitorGap(dummyCtx, input);
    expect(findings).toHaveLength(0);
  });

  it("emits NO findings when competitor position is outside top 10", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "workflow automation",
          searchVolume: 500,
          competitors: [{ domain: "zapier.com", position: 18 }], // > minCompetitorRank of 10
          firstPartyPosition: null,
          firstPartyUrl: null,
          factIds: [],
        },
      ],
      thresholds: testThresholds,
    };

    const findings = detectCompetitorGap(dummyCtx, input);
    expect(findings).toHaveLength(0);
  });

  it("provides deterministic deduplication and stable finding identity", () => {
    const input: CompetitorGapInput = {
      periodFrom: "2026-09-01",
      periodTo: "2026-09-28",
      rows: [
        {
          keyword: "CRM Software",
          searchVolume: 2000,
          competitors: [{ domain: "hubspot.com", position: 1 }],
          firstPartyPosition: null,
          firstPartyUrl: null,
          factIds: [],
        },
      ],
      thresholds: testThresholds,
    };

    const run1 = detectCompetitorGap(dummyCtx, input);
    const run2 = detectCompetitorGap(dummyCtx, input);

    expect(run1).toHaveLength(1);
    expect(run2).toHaveLength(1);
    expect(run1[0].entityKey).toBe("crm software"); // Canonical lowercased
    expect(run2[0].entityKey).toBe(run1[0].entityKey);
    expect(run1[0].explanationFact).toBe(run2[0].explanationFact);
    expect(run1[0].confidenceScore).toBe(run2[0].confidenceScore);
  });

  it("type-checks input shape via isCompetitorGapInput", () => {
    expect(isCompetitorGapInput(null)).toBe(false);
    expect(isCompetitorGapInput({})).toBe(false);
    expect(isCompetitorGapInput({ rows: [], periodFrom: "2026-01-01" })).toBe(
      false,
    );
    expect(
      isCompetitorGapInput({
        rows: [],
        periodFrom: "2026-01-01",
        periodTo: "2026-01-28",
        thresholds: {},
      }),
    ).toBe(true);
  });

  it("detectorDef declares expected properties and checks type", () => {
    expect(competitorGapDetector.detectorKey).toBe("competitor_gap");
    expect(competitorGapDetector.version).toBe(1);
    expect(competitorGapDetector.requiredSources).toEqual(["rank", "gsc"]);
    expect(competitorGapDetector.minConfidenceToEmit).toBe(40);
    expect(() => competitorGapDetector.detect(dummyCtx, {})).toThrow(
      "competitor_gap: mistyped input",
    );
  });

  it("fetchCompetitorGapInput throws InsufficientCoverageError if no competitor snapshots exist", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([]);
    await expect(fetchCompetitorGapInput("p1", dummyCtx)).rejects.toThrow(
      InsufficientCoverageError,
    );
  });

  it("fetchCompetitorGapInput throws InsufficientCoverageError if no GSC facts exist", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [{ domain: "rival.com", avg_position: 2 }],
        fetchedAt: "2026-09-28T00:00:00Z",
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce(null);
    await expect(fetchCompetitorGapInput("p1", dummyCtx)).rejects.toThrow(
      "no GSC query facts",
    );
  });

  it("fetchCompetitorGapInput throws InsufficientCoverageError if newest snapshot is older than freshness window", async () => {
    mockRepo.getLatestCompetitorSnapshotsForProject.mockResolvedValueOnce([
      {
        id: 1,
        projectId: "p1",
        keywordKey: '["crm"]',
        keywords: ["crm"],
        locationCode: 2840,
        languageCode: "en",
        items: [{ domain: "rival.com", avg_position: 2 }],
        fetchedAt: "2026-01-01T00:00:00Z", // Stale relative to 2026-09-28
      },
    ]);
    mockRepo.getLatestFactDate.mockResolvedValueOnce("2026-09-28");
    await expect(fetchCompetitorGapInput("p1", dummyCtx)).rejects.toThrow(
      /newest snapshot older than/,
    );
  });
});

