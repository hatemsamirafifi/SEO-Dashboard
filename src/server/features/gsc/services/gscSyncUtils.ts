import { GscApiError, GscTokenError } from "@/server/lib/gscClient";
import { GscNotConnectedError } from "@/server/features/gsc/services/GscService";
import { scrubGlobalTraceText } from "@/shared/globalTraceTypes";

export type GscSyncGrain =
  | "summary"
  | "query"
  | "page"
  | "query_page"
  | "country"
  | "device"
  | "search_appearance";

export const GSC_GRAIN_CONFIGS: Array<{
  grain: GscSyncGrain;
  dimensions: string[];
}> = [
  { grain: "summary", dimensions: ["date"] },
  { grain: "query", dimensions: ["date", "query"] },
  { grain: "page", dimensions: ["date", "page"] },
  { grain: "query_page", dimensions: ["date", "query", "page"] },
  { grain: "country", dimensions: ["date", "country"] },
  { grain: "device", dimensions: ["date", "device"] },
];

export type DateChunk = {
  startDate: string;
  endDate: string;
};

const DATE_REGEX = /^\d{4}-\d{2}-\d{2}$/;

export function splitDateRangeIntoChunks(
  startDate: string,
  endDate: string,
  chunkDays: number = 7,
): DateChunk[] {
  const chunks: DateChunk[] = [];
  const startMs = Date.parse(`${startDate}T00:00:00Z`);
  const endMs = Date.parse(`${endDate}T00:00:00Z`);
  if (Number.isNaN(startMs) || Number.isNaN(endMs) || startMs > endMs) {
    return [];
  }

  const dayMs = 24 * 60 * 60 * 1000;
  let currentStart = startMs;

  while (currentStart <= endMs) {
    const nextEnd = Math.min(currentStart + (chunkDays - 1) * dayMs, endMs);
    chunks.push({
      startDate: new Date(currentStart).toISOString().slice(0, 10),
      endDate: new Date(nextEnd).toISOString().slice(0, 10),
    });
    currentStart = nextEnd + dayMs;
  }

  return chunks;
}

export type DateInterval = {
  startDate: string;
  endDate: string;
};

export function addDaysUtc(dateStr: string, days: number): string {
  if (!dateStr || typeof dateStr !== "string" || !DATE_REGEX.test(dateStr)) {
    return dateStr;
  }
  const ms = Date.parse(`${dateStr}T00:00:00Z`);
  if (Number.isNaN(ms)) return dateStr;
  return new Date(ms + days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

export function mergeDateIntervals(intervals: DateInterval[]): DateInterval[] {
  if (!Array.isArray(intervals)) return [];

  const valid = intervals.filter(
    (inv): inv is DateInterval =>
      Boolean(
        inv &&
          typeof inv.startDate === "string" &&
          typeof inv.endDate === "string" &&
          DATE_REGEX.test(inv.startDate) &&
          DATE_REGEX.test(inv.endDate) &&
          inv.startDate <= inv.endDate,
      ),
  );
  if (valid.length === 0) return [];

  valid.sort((a, b) => {
    if (a.startDate !== b.startDate) {
      return a.startDate.localeCompare(b.startDate);
    }
    return b.endDate.localeCompare(a.endDate);
  });

  const merged: DateInterval[] = [{ ...valid[0] }];

  for (let i = 1; i < valid.length; i++) {
    const current = valid[i];
    const prev = merged[merged.length - 1];
    const contiguousThreshold = addDaysUtc(prev.endDate, 1);

    if (current.startDate <= contiguousThreshold) {
      if (current.endDate > prev.endDate) {
        prev.endDate = current.endDate;
      }
    } else {
      merged.push({ ...current });
    }
  }

  return merged;
}

export function isRangeCoveredByIntervals(
  mergedIntervals: DateInterval[],
  range: DateInterval,
): boolean {
  if (
    !Array.isArray(mergedIntervals) ||
    !range ||
    typeof range.startDate !== "string" ||
    typeof range.endDate !== "string" ||
    !DATE_REGEX.test(range.startDate) ||
    !DATE_REGEX.test(range.endDate) ||
    range.startDate > range.endDate
  ) {
    return false;
  }

  return mergedIntervals.some(
    (inv) => inv.startDate <= range.startDate && inv.endDate >= range.endDate,
  );
}

export function syncRunsToIntervals(
  runs: Array<{
    status?: string | null;
    requestedStartDate?: string | null;
    requestedEndDate?: string | null;
    actualLastSuccessfulDate?: string | null;
  }>,
): DateInterval[] {
  const intervals: DateInterval[] = [];
  if (!Array.isArray(runs)) return intervals;

  for (const run of runs) {
    if (!run || typeof run !== "object") continue;
    const reqStart = run.requestedStartDate;
    const reqEnd = run.requestedEndDate;

    if (run.status === "completed") {
      if (
        reqStart &&
        reqEnd &&
        typeof reqStart === "string" &&
        typeof reqEnd === "string" &&
        DATE_REGEX.test(reqStart) &&
        DATE_REGEX.test(reqEnd) &&
        reqStart <= reqEnd
      ) {
        intervals.push({
          startDate: reqStart,
          endDate: reqEnd,
        });
      }
    } else if (run.status === "partial") {
      const end = run.actualLastSuccessfulDate;
      if (
        reqStart &&
        end &&
        typeof reqStart === "string" &&
        typeof end === "string" &&
        DATE_REGEX.test(reqStart) &&
        DATE_REGEX.test(end) &&
        reqStart <= end
      ) {
        intervals.push({
          startDate: reqStart,
          endDate: end,
        });
      }
    }
  }

  return intervals;
}

export function classifyGscSyncError(error: unknown): {
  errorClass: string;
  message: string;
} {
  if (error instanceof GscTokenError) {
    return {
      errorClass: "OAUTH_TOKEN_FAILURE",
      message:
        error.message || "Search Console OAuth grant expired or revoked.",
    };
  }
  if (error instanceof GscApiError) {
    if (error.status === 401 || error.status === 403) {
      return {
        errorClass: "PERMISSION_DENIED",
        message: "Search Console permission denied for this property.",
      };
    }
    if (error.status === 404) {
      return {
        errorClass: "PROPERTY_NOT_FOUND",
        message: "Search Console property not found.",
      };
    }
    if (error.status === 429) {
      return {
        errorClass: "RATE_LIMIT_EXCEEDED",
        message: "Search Console rate limit reached. Retry shortly.",
      };
    }
    if (error.status === 400) {
      return {
        errorClass: "INVALID_REQUEST",
        message: `Search Console invalid request: ${error.message}`,
      };
    }
    return {
      errorClass: `HTTP_ERROR_${error.status}`,
      message: error.message,
    };
  }
  if (error instanceof GscNotConnectedError) {
    return {
      errorClass: "NOT_CONNECTED",
      message: "Search Console is not connected for this project.",
    };
  }
  if (error instanceof Error) {
    return {
      errorClass: "SYNC_FAILURE",
      message: scrubGlobalTraceText(error.message),
    };
  }
  return {
    errorClass: "UNKNOWN_FAILURE",
    message: "Unknown failure during Search Console sync.",
  };
}
