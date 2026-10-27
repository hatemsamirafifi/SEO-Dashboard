import { describe, expect, it } from "vitest";
import {
  boundAgentKeywordResearchOutput,
  SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT,
} from "./samKeywordResearchBounding";

describe("boundAgentKeywordResearchOutput", () => {
  it("passes through small results unmodified", () => {
    const raw = {
      content: [{ type: "text", text: "small summary" }],
      structuredContent: {
        ok: true,
        results: [
          {
            seed: "football",
            ok: true,
            rowCount: 5,
            source: "dataforseo",
            usedFallback: false,
            rows: Array.from({ length: 5 }, (_, i) => ({
              keyword: `kw ${i}`,
              searchVolume: 100 - i,
              keywordDifficulty: 20,
              cpc: 1.5,
              competition: 0.2,
              intent: "commercial",
            })),
          },
        ],
      },
    };

    const bounded = boundAgentKeywordResearchOutput(raw);
    expect(bounded).toEqual(raw);
  });

  it("bounds oversized result to SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT per seed", () => {
    const largeRows = Array.from({ length: 100 }, (_, i) => ({
      keyword: `keyword ${i}`,
      searchVolume: i * 10,
      keywordDifficulty: 30,
      cpc: 1.0,
      competition: 0.1,
      intent: "informational",
    }));

    const raw = {
      content: [{ type: "text", text: "full 100-row markdown table" }],
      structuredContent: {
        ok: true,
        results: [
          {
            seed: "sports courts",
            ok: true,
            rowCount: 100,
            source: "dataforseo",
            usedFallback: false,
            rows: largeRows,
          },
        ],
      },
    };

    const bounded = boundAgentKeywordResearchOutput(raw) as {
      content: Array<{ text: string }>;
      structuredContent: {
        results: Array<{
          rowCount: number;
          rows: unknown[];
          agentTruncated?: boolean;
        }>;
      };
    };

    expect(bounded.structuredContent.results[0].rows).toHaveLength(
      SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT,
    );
    expect(bounded.structuredContent.results[0].rowCount).toBe(100);
    expect(bounded.structuredContent.results[0].agentTruncated).toBe(true);
    expect(bounded.content[0].text).toContain(
      `showing top ${SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT} of 100 keywords`,
    );
  });

  it("handles non-record or error payloads gracefully", () => {
    expect(boundAgentKeywordResearchOutput(null)).toBeNull();
    expect(boundAgentKeywordResearchOutput({ error: "failed" })).toEqual({
      error: "failed",
    });
  });
});
