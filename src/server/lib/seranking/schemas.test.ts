import { describe, it, expect } from "vitest";
import {
  seRankingHistoryTrendSchema,
  mapSeRankingIntent,
  seRankingKeywordSuggestionItemSchema,
  seRankingKeywordExportItemSchema,
  seRankingSubscriptionSchema,
} from "./schemas";
import { parseKeywordSuggestionItems } from "./keywords";

describe("SE Ranking Schemas & API Contracts", () => {
  describe("seRankingHistoryTrendSchema", () => {
    it("parses object/record format into an array of date-volume items", () => {
      const input = {
        "2024-01-01": 1500,
        "2024-02-01": 1800,
        "2024-03-01": "2100",
      };
      const parsed = seRankingHistoryTrendSchema.parse(input);
      expect(parsed).toEqual([
        { date: "2024-01-01", volume: 1500 },
        { date: "2024-02-01", volume: 1800 },
        { date: "2024-03-01", volume: 2100 },
      ]);
    });

    it("parses standard array format into date-volume items", () => {
      const input = [
        { date: "2024-01-01", volume: 1500 },
        { date: "2024-02-01", volume: 1800 },
      ];
      const parsed = seRankingHistoryTrendSchema.parse(input);
      expect(parsed).toEqual([
        { date: "2024-01-01", volume: 1500 },
        { date: "2024-02-01", volume: 1800 },
      ]);
    });

    it("defaults undefined to empty array", () => {
      expect(seRankingHistoryTrendSchema.parse(undefined)).toEqual([]);
    });

    it("parses null history_trend into an empty array without throwing", () => {
      expect(seRankingHistoryTrendSchema.parse(null)).toEqual([]);
    });

    it("handles empty object {} into an empty array without throwing", () => {
      expect(seRankingHistoryTrendSchema.parse({})).toEqual([]);
    });
  });

  describe("mapSeRankingIntent", () => {
    it("maps single letter and numeric intent codes to standard OpenSEO intents", () => {
      expect(mapSeRankingIntent(["I"])).toBe("informational");
      expect(mapSeRankingIntent(["C"])).toBe("commercial");
      expect(mapSeRankingIntent(["T"])).toBe("transactional");
      expect(mapSeRankingIntent(["N"])).toBe("navigational");
      expect(mapSeRankingIntent("I")).toBe("informational");
      expect(mapSeRankingIntent(1)).toBe("informational");
      expect(mapSeRankingIntent(3)).toBe("commercial");
    });

    it("handles null or missing intent gracefully", () => {
      expect(mapSeRankingIntent(null)).toBeNull();
      expect(mapSeRankingIntent(undefined)).toBeNull();
      expect(mapSeRankingIntent([])).toBeNull();
    });
  });

  describe("seRankingKeywordSuggestionItemSchema", () => {
    it("parses Arabic keyword with object history_trend and intents array", () => {
      const raw = {
        keyword: "عطور رجالية",
        volume: 2400,
        cpc: 0.85,
        difficulty: 32,
        competition: 0.65,
        intents: ["C"],
        history_trend: {
          "2024-10-01": 2100,
          "2024-11-01": 2400,
        },
      };

      const parsed = seRankingKeywordSuggestionItemSchema.parse(raw);
      expect(parsed.keyword).toBe("عطور رجالية");
      expect(parsed.volume).toBe(2400);
      expect(parsed.cpc).toBe(0.85);
      expect(parsed.difficulty).toBe(32);
      expect(parsed.competition).toBe(0.65);
      expect(parsed.intent).toBe("commercial");
      expect(parsed.history_trend).toEqual([
        { date: "2024-10-01", volume: 2100 },
        { date: "2024-11-01", volume: 2400 },
      ]);
    });

    it("handles missing/null metrics without fabricating values", () => {
      const raw = {
        keyword: "عطور رجالية فخمة",
      };

      const parsed = seRankingKeywordSuggestionItemSchema.parse(raw);
      expect(parsed.keyword).toBe("عطور رجالية فخمة");
      expect(parsed.volume).toBeNull();
      expect(parsed.cpc).toBeNull();
      expect(parsed.difficulty).toBeNull();
      expect(parsed.competition).toBeNull();
      expect(parsed.intent).toBeNull();
      expect(parsed.history_trend).toEqual([]);
    });

    it("parses official SE Ranking contract with null fields and passthrough extra keys", () => {
      const officialDocItem = {
        keyword: "1 avocado brownies",
        volume: 480,
        cpc: 1.1,
        difficulty: 28,
        competition: 0.45,
        intents: ["I", "C"],
        serp_features: ["featured_snippets", "images"],
        history_trend: {
          "2025-11-01": 400,
          "2025-12-01": 450,
        },
      };

      const parsed = seRankingKeywordSuggestionItemSchema.parse(officialDocItem);
      expect(parsed.keyword).toBe("1 avocado brownies");
      expect(parsed.volume).toBe(480);
      expect(parsed.difficulty).toBe(28);
      expect(parsed.intent).toBe("informational"); // "I" matches informational
      expect(parsed.history_trend).toEqual([
        { date: "2025-11-01", volume: 400 },
        { date: "2025-12-01", volume: 450 },
      ]);

      const itemWithNulls = {
        keyword: "عطور رجالية نادرة",
        volume: null,
        cpc: null,
        difficulty: null,
        competition: null,
        intents: null,
        history_trend: null,
        serp_features: [],
      };

      const parsedNulls = seRankingKeywordSuggestionItemSchema.parse(itemWithNulls);
      expect(parsedNulls.keyword).toBe("عطور رجالية نادرة");
      expect(parsedNulls.volume).toBeNull();
      expect(parsedNulls.intent).toBeNull();
      expect(parsedNulls.history_trend).toEqual([]);
    });

    it("parseKeywordSuggestionItems safely parses arrays and salvages valid items even if an item has anomalies", () => {
      const items = [
        {
          keyword: "عطور رجالية",
          volume: 2400,
          history_trend: null,
        },
        {
          // missing keyword string
          volume: 1200,
        },
        {
          keyword: "عطور فرنسية",
          volume: 1800,
          history_trend: { "2026-01-01": 1800 },
        },
      ];

      const results = parseKeywordSuggestionItems(items);
      expect(results).toHaveLength(2);
      expect(results[0].keyword).toBe("عطور رجالية");
      expect(results[0].history_trend).toEqual([]);
      expect(results[1].keyword).toBe("عطور فرنسية");
      expect(results[1].history_trend).toEqual([{ date: "2026-01-01", volume: 1800 }]);
    });

    it("parses export item schema with body structure", () => {
      const raw = {
        keyword: "عطور رجالية",
        volume: 2400,
        intents: ["C"],
      };

      const parsed = seRankingKeywordExportItemSchema.parse(raw);
      expect(parsed.keyword).toBe("عطور رجالية");
      expect(parsed.volume).toBe(2400);
      expect(parsed.intent).toBe("commercial");
    });
  });

  describe("seRankingSubscriptionSchema", () => {
    it("validates successful subscription response with 100,000 units", () => {
      const raw = {
        subscription_info: {
          status: "active",
          units_left: 100000,
          units_limit: 100000,
          start_date: "2026-01-01",
          expiration_date: "2026-12-31",
        },
      };

      const parsed = seRankingSubscriptionSchema.parse(raw);
      expect(parsed.status).toBe("active");
      expect(parsed.units_left).toBe(100000);
      expect(parsed.units_limit).toBe(100000);
    });
  });
});
