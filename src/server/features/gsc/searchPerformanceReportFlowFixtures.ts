import type {
  SearchPerformanceDimensionRowResult,
  SearchPerformanceStrikingRow,
  SearchPerformanceTotalsResult,
} from "@/types/schemas/search-performance";

/** Shape of a mocked gsc_search_performance_syncs row (loose subset of
 *  GscSyncRow: only the fields the report flow reads are exercised). */
export interface TestSyncRow {
  id?: string;
  projectId?: string;
  property?: string;
  status: string;
  syncType?: string;
  requestedStartDate: string | null;
  requestedEndDate: string | null;
  actualLastSuccessfulDate?: string | null;
  rowsFetched?: number;
  rowsInserted?: number;
  rowsUpdated?: number;
  rowsFailed?: number;
  startedAt?: string;
  completedAt?: string | null;
  error?: string | null;
}

/** Shape of a mocked gscSearchPerformance coverage aggregate row. */
export interface TestFactRow {
  minDate: string | null;
  maxDate: string | null;
  count?: number;
  totalDays?: number;
}

export const totalsResult: SearchPerformanceTotalsResult = {
  clicks: 120,
  impressions: 2400,
  ctr: 0.05,
  position: 8.5,
};

export const strikingResult: SearchPerformanceStrikingRow[] = [
  {
    query: "best running shoes",
    page: "https://example.com/shoes",
    clicks: 10,
    impressions: 200,
    position: 7.2,
  },
];

export const countriesResult: SearchPerformanceDimensionRowResult[] = [
  {
    key: "usa",
    clicks: 80,
    impressions: 1500,
    ctr: 0.053,
    position: 6.4,
  },
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Narrows an untrusted JSON.parse result to a record, failing the test with
 *  a clear message instead of a TypeError on malformed shapes. */
export function asRecord(
  value: unknown,
  label: string,
): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`${label} did not parse to a plain object`);
  }
  return value;
}

function isUnknownArray(value: unknown): value is unknown[] {
  return Array.isArray(value);
}

/** Best-effort textual rendering of a drizzle SQL clause, used by the test db
 *  mock to sniff which sync statuses a query filters on. */
export function extractSqlClauseText(value: unknown, depth = 0): string {
  if (depth > 6 || !value) return "";
  if (typeof value === "string") return value;
  if (
    typeof value === "number" ||
    typeof value === "boolean" ||
    typeof value === "bigint"
  ) {
    return String(value);
  }
  if (typeof value !== "object") return "";
  if ("queryChunks" in value) {
    const chunks: unknown = value["queryChunks"];
    if (isUnknownArray(chunks)) {
      return chunks
        .map((chunk) => extractSqlClauseText(chunk, depth + 1))
        .join(" ");
    }
  }
  if ("value" in value) {
    return extractSqlClauseText(value["value"], depth + 1);
  }
  if ("values" in value) {
    const values: unknown = value["values"];
    if (isUnknownArray(values)) {
      return values
        .map((item) => extractSqlClauseText(item, depth + 1))
        .join(" ");
    }
  }
  if (isUnknownArray(value)) {
    return value.map((item) => extractSqlClauseText(item, depth + 1)).join(" ");
  }
  return "";
}
