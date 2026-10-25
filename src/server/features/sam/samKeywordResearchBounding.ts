import { formatMcpTable, type McpTableColumn } from "@/server/mcp/table";

export const SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT = 25;

type ResearchRow = {
  keyword: string;
  searchVolume: number | null;
  keywordDifficulty: number | null;
  cpc: number | null;
  competition: number | null;
  intent: string;
};

const RESEARCH_COLUMNS: McpTableColumn<ResearchRow>[] = [
  { header: "keyword", value: (row) => row.keyword },
  { header: "volume", value: (row) => row.searchVolume },
  { header: "KD", value: (row) => row.keywordDifficulty },
  { header: "CPC", value: (row) => row.cpc },
  { header: "competition", value: (row) => row.competition },
  { header: "intent", value: (row) => row.intent },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

type SeedSuccessResult = {
  seed: string;
  ok: true;
  rowCount: number;
  source: string;
  usedFallback: boolean;
  rows: ResearchRow[];
};

type SeedFailureResult = {
  seed: string;
  ok: false;
  error: string;
};

type SeedResult = SeedSuccessResult | SeedFailureResult;

function isSeedResult(value: unknown): value is SeedResult {
  if (!isRecord(value) || typeof value.seed !== "string") return false;
  return value.ok === true || value.ok === false;
}

/**
 * Bounds the keyword research output for SAM (the in-app chat agent).
 *
 * In the MCP server route, `research_keywords` returns hundreds or thousands of rows.
 * If all rows are dumped into the agent transcript, each streaming chunk re-clones
 * multi-hundred-KB messages, causing render storms and React's "Maximum update depth exceeded".
 *
 * This function preserves the top keywords per seed (default 25, sorted by volume),
 * trims the table text, and notes that the full dataset was processed.
 */
export function boundAgentKeywordResearchOutput(output: unknown): unknown {
  if (!isRecord(output)) return output;

  // The output might be a CallToolResult ({ content: [{ text }], structuredContent: { results } })
  const content = Array.isArray(output.content) ? output.content : undefined;
  const structured = isRecord(output.structuredContent)
    ? output.structuredContent
    : isRecord(output.data)
      ? output.data
      : undefined;

  if (!structured || !Array.isArray(structured.results)) {
    return output;
  }

  const results: unknown[] = structured.results;
  let needsBounding = false;

  for (const r of results) {
    if (
      isSeedResult(r) &&
      r.ok &&
      Array.isArray(r.rows) &&
      r.rows.length > SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT
    ) {
      needsBounding = true;
      break;
    }
  }

  if (!needsBounding) {
    return output;
  }

  const boundedResults = results.map((r) => {
    if (!isSeedResult(r) || !r.ok || !Array.isArray(r.rows)) {
      return r;
    }
    if (r.rows.length <= SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT) {
      return r;
    }

    // Sort by search volume descending if available
    const sorted = r.rows.toSorted((a, b) => {
      const volA = typeof a.searchVolume === "number" ? a.searchVolume : -1;
      const volB = typeof b.searchVolume === "number" ? b.searchVolume : -1;
      return volB - volA;
    });

    const boundedRows = sorted.slice(0, SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT);
    return {
      ...r,
      rows: boundedRows,
      agentTruncated: true,
      agentRowCount: boundedRows.length,
      totalRowCount: r.rowCount,
    };
  });

  const okCount = boundedResults.filter((r) => isSeedResult(r) && r.ok).length;
  const failCount = boundedResults.length - okCount;

  const regeneratedText =
    boundedResults
      .map((r) => {
        if (!isSeedResult(r)) return "";
        if (!r.ok) {
          return `## "${r.seed}" — FAILED\n${r.error}`;
        }
        const isTruncated = r.rows.length < r.rowCount;
        const boundNote = isTruncated
          ? ` [agent bound: showing top ${r.rows.length} of ${r.rowCount} keywords]`
          : "";
        const header = `## "${r.seed}" — ${r.rowCount} keywords (source: ${r.source}${r.usedFallback ? ", fallback" : ""})${boundNote}`;
        if (r.rows.length === 0) {
          return `${header}\n(no keywords returned)`;
        }
        return `${header}\n${formatMcpTable(r.rows, RESEARCH_COLUMNS)}`;
      })
      .join("\n\n") +
    `\n\nResearched ${okCount} of ${boundedResults.length} seeds${failCount > 0 ? ` (${failCount} failed)` : ""}. Note: Results bounded to top ${SAM_KEYWORD_RESEARCH_AGENT_ROW_LIMIT} keywords per seed for chat display.`;

  const newContent = content
    ? [{ type: "text", text: regeneratedText }]
    : output.content;

  const newStructured = {
    ...structured,
    results: boundedResults,
  };

  return {
    ...output,
    content: newContent,
    structuredContent: output.structuredContent ? newStructured : undefined,
    data: output.data ? newStructured : undefined,
  };
}
