import type { KeywordResearchRow, SerpResultItem } from "@/types/keywords";
import type { ResolvedResearchKeywordsInput } from "@/types/schemas/keywords";
import type { SerpFeatureSet } from "@/server/features/serp/types";
import type { ResearchResult } from "@/server/features/keywords/services/research/research";

const MONTHLY_SEARCHES = [
  { year: 2025, month: 4, searchVolume: 1200 },
  { year: 2025, month: 5, searchVolume: 1600 },
  { year: 2025, month: 6, searchVolume: 2400 },
  { year: 2025, month: 7, searchVolume: 3200 },
  { year: 2025, month: 8, searchVolume: 4200 },
  { year: 2025, month: 9, searchVolume: 3600 },
  { year: 2025, month: 10, searchVolume: 3000 },
  { year: 2025, month: 11, searchVolume: 2600 },
  { year: 2025, month: 12, searchVolume: 2200 },
  { year: 2026, month: 1, searchVolume: 2100 },
  { year: 2026, month: 2, searchVolume: 2300 },
  { year: 2026, month: 3, searchVolume: 2800 },
];

function makeRow(
  keyword: string,
  index: number,
  overrides: Partial<KeywordResearchRow> = {},
): KeywordResearchRow {
  return {
    keyword,
    searchVolume: 20_000 - index * 750,
    trend: MONTHLY_SEARCHES,
    keywordDifficulty: 40 + (index % 40),
    cpc: Number((1.25 + index * 0.15).toFixed(2)),
    competition: Number((0.05 + (index % 10) * 0.04).toFixed(2)),
    intent: index % 3 === 0 ? "commercial" : "informational",
    ...overrides,
  };
}

function getMultiSourceFixture(
  data: ResolvedResearchKeywordsInput,
  seed: string,
): ResearchResult {
  const partial = seed === "عطور عربية";
  const rows: KeywordResearchRow[] = partial
    ? [
        {
          keyword: "عطور عربية اقتصادية",
          searchVolume: null,
          cpc: null,
          competition: null,
          intent: null,
          keywordDifficulty: null,
          trend: [],
          matchType: "phrase",
          attribution: [
            {
              source: "gsc",
              cacheStatus: "miss",
              confidence: "observed",
              keyword: "عطور عربية اقتصادية",
              observedAt: "2026-11-22T00:00:00Z",
              sitePerformance: {
                impressions: 18,
                clicks: 0,
                startDate: "2026-08-20",
                endDate: "2026-11-20",
              },
            },
          ],
        },
      ]
    : [];
  return {
    provider: partial ? "gsc" : "none",
    rows,
    source: partial ? "gsc" : "suggestions",
    usedFallback: partial,
    diagnostics: {
      requestedMode: data.mode,
      threshold: 5,
      coverage: partial ? "partial" : "empty",
      servingProviders: partial ? ["gsc"] : [],
      sourceAttempts: [
        {
          source: "suggestions",
          provider: "seranking",
          status: "no_coverage",
          fromCache: true,
          rowCount: 0,
          nonSeedCount: 0,
        },
        {
          source: "google_ads",
          provider: "google_ads",
          status: partial ? "rate_limited" : "skipped",
          rowCount: 0,
          nonSeedCount: 0,
        },
        {
          source: "gsc",
          provider: "gsc",
          status: partial ? "available" : "no_coverage",
          attemptedProviders: ["gsc"],
          endpoint: "searchAnalytics.query",
          fromCache: false,
          rowCount: rows.length,
          nonSeedCount: rows.length,
        },
        {
          source: "internal",
          provider: "internal",
          status: "no_coverage",
          rowCount: 0,
          nonSeedCount: 0,
        },
      ],
    },
  };
}

export function getKeywordResearchFixture(
  data: ResolvedResearchKeywordsInput,
): ResearchResult {
  const seedKeyword = data.keywords[0] ?? "keyword research";
  if (
    data.languageCode === "ar" &&
    ["عطور عربية", "عطور بلا نتائج"].includes(seedKeyword)
  ) {
    return getMultiSourceFixture(data, seedKeyword);
  }
  const rows = [
    makeRow(seedKeyword, 0, {
      searchVolume: 288_431,
      keywordDifficulty: 78,
      cpc: 11.93,
      competition: 0.07,
      intent: "informational",
    }),
    makeRow(`${seedKeyword} tools`, 1),
    makeRow(`${seedKeyword} software`, 2),
    makeRow(`${seedKeyword} checklist`, 3),
    makeRow(`${seedKeyword} template`, 4),
    makeRow(`${seedKeyword} examples`, 5),
    makeRow(`${seedKeyword} guide`, 6),
    makeRow(`${seedKeyword} strategy`, 7),
    makeRow(`${seedKeyword} platform`, 8),
    makeRow(`${seedKeyword} generator`, 9),
  ];

  return {
    provider: "seranking",
    rows,
    source: "related" as const,
    usedFallback: false,
    diagnostics: {
      requestedMode: data.mode,
      threshold: 3,
      sourceAttempts: [
        {
          source: "related" as const,
          rowCount: rows.length,
          nonSeedCount: rows.length - 1,
        },
      ],
    },
  };
}

/* Deterministic SERP analysis fixture (spec 011, T017): three organic rows
 * (row 3 enrichment-failed), a placement-2 PAA block with ten questions, and
 * a local pack — enough to prove the mobile card view, placement honesty,
 * and FR-006 degradation without a live provider. */
function makeSerpItem(
  rank: number,
  title: string,
  overrides: Partial<SerpResultItem> = {},
): SerpResultItem {
  return {
    rank,
    title,
    url: `https://fixture.example/${rank}`,
    domain: "fixture.example",
    description: `Fixture summary ${["one", "two", "three"][rank - 1]}.`,
    etv: 900,
    estimatedPaidTrafficCost: null,
    referringDomains: 1200,
    backlinks: 5400,
    isNew: false,
    rankChange: null,
    domainRank: 42,
    pageRank: 38,
    metricStatus: "available",
    ...overrides,
  };
}

export function getSerpAnalysisFixture(keyword: string) {
  const items: SerpResultItem[] = [
    makeSerpItem(1, "Fixture top result"),
    makeSerpItem(2, "Fixture second result"),
    makeSerpItem(3, "Fixture third result", {
      domainRank: null,
      pageRank: null,
      referringDomains: null,
      backlinks: null,
      etv: null,
      metricStatus: "failed",
    }),
  ];
  const features: SerpFeatureSet = {
    peopleAlsoAsk: {
      items: Array.from({ length: 10 }, (_, i) => ({
        question: `Fixture question ${i + 1}?`,
        url: i === 0 ? "https://fixture.example/q1" : null,
        placement: 2,
      })),
    },
    localPack: {
      items: [
        {
          title: "Fixture shop",
          url: "https://fixture.example/shop",
          domain: "fixture.example",
          address: "1 Fixture St",
          rating: 4.5,
          reviewCount: 120,
        },
      ],
    },
  };
  return {
    requestedKeyword: keyword,
    items,
    features,
    enrichmentAccountBlocked: null,
  };
}
