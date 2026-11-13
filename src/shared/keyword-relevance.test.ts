import { describe, expect, it } from "vitest";
import type { KeywordResearchRow } from "@/types/keywords";
import {
  annotateAndSortKeywordRows,
  detectScriptKind,
  isExactKeywordMatch,
  normalizeArabicKeyword,
  scoreKeywordRelevance,
} from "./keyword-relevance";

function makeRow(
  keyword: string,
  searchVolume: number | null,
  overrides: Partial<KeywordResearchRow> = {},
): KeywordResearchRow {
  return {
    keyword,
    searchVolume,
    trend: [],
    keywordDifficulty: 25,
    cpc: 0.5,
    competition: 0.3,
    intent: "commercial",
    ...overrides,
  };
}

describe("Arabic & Cross-Language Keyword Relevance", () => {
  describe("normalizeArabicKeyword & isExactKeywordMatch", () => {
    it("normalizes Alef variants, Teh Marbuta, Alef Maqsura, diacritics, and tatweel", () => {
      expect(normalizeArabicKeyword("  أفضل شَرِكَاتُ لاندسكيب  ")).toBe(
        "افضل شركات لاندسكيب",
      );
      expect(normalizeArabicKeyword("شركة لاندسكيب")).toBe("شركه لاندسكيب");
      expect(normalizeArabicKeyword("شركه لاندسكيب")).toBe("شركه لاندسكيب");
      expect(normalizeArabicKeyword("مستشفى")).toBe("مستشفي");
      expect(normalizeArabicKeyword("شـركـات")).toBe("شركات");
    });

    it("matches Arabic orthographic variants as exact matches while preserving original spelling", () => {
      expect(isExactKeywordMatch("شركة لاندسكيب", "شركه لاندسكيب")).toBe(true);
      expect(
        isExactKeywordMatch("أفضل شركات لاندسكيب", "افضل شركات لاندسكيب"),
      ).toBe(true);
      expect(isExactKeywordMatch("شركات لاندسكيب", "شركات تنسيق حدائق")).toBe(
        false,
      );
    });

    it("detects script kinds accurately", () => {
      expect(detectScriptKind("شركات لاندسكيب")).toBe("arabic");
      expect(detectScriptKind("landscape design")).toBe("latin");
      expect(detectScriptKind("شركات landscape في مصر")).toBe("mixed");
    });
  });

  describe("scoreKeywordRelevance & annotateAndSortKeywordRows for 'شركات لاندسكيب' in Egypt", () => {
    const seed = "شركات لاندسكيب";

    it("prioritizes relevant Arabic keywords and flags weakly related English keywords without discarding them", () => {
      const inputRows: KeywordResearchRow[] = [
        makeRow("landscape design ideas", 5400),
        makeRow("backyard landscaping", 3200),
        makeRow("شركات تنسيق حدائق", 880),
        makeRow("شركات لاندسكيب في مصر", 320),
        makeRow("افضل شركة لاندسكيب", 210),
        makeRow("اسعار اللاندسكيب", 140),
      ];

      const sorted = annotateAndSortKeywordRows(inputRows, seed, "ar");

      // Never discards any rows
      expect(sorted).toHaveLength(6);

      // High-tier Arabic matches (phrase/partial token overlap) come first
      expect(sorted[0].keyword).toBe("شركات لاندسكيب في مصر");
      expect(sorted[0].matchType).toBe("phrase");
      expect(sorted[0].relevanceTier).toBe("high");
      expect(sorted[0].isWeaklyRelated).toBe(false);

      expect(sorted[1].keyword).toBe("افضل شركة لاندسكيب");
      expect(sorted[1].relevanceTier).toBe("high");
      expect(sorted[1].isWeaklyRelated).toBe(false);

      // Weakly related English keywords are placed last and flagged, with genuine volumes intact
      const englishRows = sorted.slice(-2);
      expect(englishRows.map((r) => r.keyword)).toEqual([
        "landscape design ideas",
        "backyard landscaping",
      ]);
      expect(englishRows[0].isWeaklyRelated).toBe(true);
      expect(englishRows[0].relevanceTier).toBe("low");
      expect(englishRows[0].searchVolume).toBe(5400);
      expect(englishRows[1].isWeaklyRelated).toBe(true);
      expect(englishRows[1].searchVolume).toBe(3200);
    });

    it("places exact match first even when a related keyword has higher search volume", () => {
      const inputRows: KeywordResearchRow[] = [
        makeRow("شركات تنسيق حدائق بالقاهرة", 1900),
        makeRow("شركات لاندسكيب", 480),
        makeRow("garden design egypt", 2500),
      ];

      const sorted = annotateAndSortKeywordRows(inputRows, seed, "ar");

      expect(sorted[0].keyword).toBe("شركات لاندسكيب");
      expect(sorted[0].matchType).toBe("exact");
      expect(sorted[0].searchVolume).toBe(480);
      expect(sorted[1].keyword).toBe("شركات تنسيق حدائق بالقاهرة");
      expect(sorted[2].keyword).toBe("garden design egypt");
      expect(sorted[2].isWeaklyRelated).toBe(true);
    });

    it("supports mixed-language seed queries without flagging English terms as weakly related", () => {
      const mixedSeed = "شركات landscape في مصر";
      const assessmentAr = scoreKeywordRelevance(
        "شركات تنسيق حدائق",
        mixedSeed,
        "ar",
      );
      const assessmentEn = scoreKeywordRelevance(
        "landscape companies cairo",
        mixedSeed,
        "ar",
      );

      expect(assessmentAr.isWeaklyRelated).toBe(false);
      expect(assessmentEn.isWeaklyRelated).toBe(false);
      expect(assessmentEn.relevanceTier).toBe("high");
    });

    it("preserves null search volumes distinctly from zero search volumes", () => {
      const rows: KeywordResearchRow[] = [
        makeRow("شركات لاندسكيب التجمع", null),
        makeRow("شركات لاندسكيب الشيخ زايد", 0),
      ];

      const sorted = annotateAndSortKeywordRows(rows, seed, "ar");

      // Legitimate 0 volume ranks before unknown/null volume within the same tier
      expect(sorted[0].keyword).toBe("شركات لاندسكيب الشيخ زايد");
      expect(sorted[0].searchVolume).toBe(0);
      expect(sorted[1].keyword).toBe("شركات لاندسكيب التجمع");
      expect(sorted[1].searchVolume).toBeNull();
    });
  });
});
