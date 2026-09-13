import {
  GscApiError,
  GscTokenError,
} from "@/server/lib/gscClient";
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
  { grain: "search_appearance", dimensions: ["date", "searchAppearance"] },
];

export type DateChunk = {
  startDate: string;
  endDate: string;
};

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

export function classifyGscSyncError(error: unknown): {
  errorClass: string;
  message: string;
} {
  if (error instanceof GscTokenError) {
    return {
      errorClass: "OAUTH_TOKEN_FAILURE",
      message: error.message || "Search Console OAuth grant expired or revoked.",
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
