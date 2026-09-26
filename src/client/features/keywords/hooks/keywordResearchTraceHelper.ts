import { getErrorCode } from "@/client/lib/error-messages";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { parseDataforseoDiagnosticsFromErrorMessage } from "@/shared/dataforseoDiagnosticsParser";
import type { KeywordMode } from "@/client/features/keywords/keywordResearchTypes";

export type KeywordResearchTraceRequest = {
  keywords: string[];
  mode: KeywordMode;
  locationCode: number | undefined;
};

type TraceFailureDetails = {
  httpStatus: number;
  taskStatus: number | null;
  errorClass: string;
  errorMessage: string;
  metadata?: Record<string, unknown>;
};

const PAUSED_CODES = new Set([
  "DATAFORSEO_ACCESS_PAUSED",
  "DATAFORSEO_ACCOUNT_PAUSED",
]);
const CREDIT_CODES = new Set([
  "CREDITS_UNAVAILABLE",
  "INSUFFICIENT_FUNDS",
  "PAYMENT_REQUIRED",
  "INSUFFICIENT_CREDITS",
]);
const RATE_LIMIT_CODES = new Set([
  "RATE_LIMITED",
  "COST_LIMIT_EXCEEDED",
  "TOO_MANY_SIMULTANEOUS_QUERIES",
]);
const UPSTREAM_CODES = new Set([
  "TRANSIENT_UPSTREAM",
  "UPSTREAM_UNAVAILABLE",
]);

function isPausedAccount(
  rawCode: string | null,
  rawMessage: string,
  errorClass: string,
  taskCode: number | null,
): boolean {
  if (rawCode && PAUSED_CODES.has(rawCode)) return true;
  if (PAUSED_CODES.has(errorClass)) return true;
  if (taskCode === 40201) return true;
  const lower = rawMessage.toLowerCase();
  return lower.includes("unusual activity") || lower.includes("paused access");
}

function resolveTraceFailureDetails(
  error: unknown,
  request: KeywordResearchTraceRequest,
): TraceFailureDetails {
  const rawCode = getErrorCode(error);
  const rawMessage = error instanceof Error ? error.message : "";
  const parsedDiag = parseDataforseoDiagnosticsFromErrorMessage(rawMessage);

  if (
    isPausedAccount(
      rawCode,
      rawMessage,
      parsedDiag.errorClass,
      parsedDiag.dataforseoStatusCode,
    )
  ) {
    return {
      httpStatus: 200,
      taskStatus: 40201,
      errorClass: "DATAFORSEO_ACCESS_PAUSED",
      errorMessage: "DataForSEO access is temporarily paused.",
      metadata: {
        keywords: request.keywords,
        mode: request.mode,
        locationCode: request.locationCode,
        providerAccess: "PAUSED",
        dataforseoStatusCode: 40201,
      },
    };
  }

  const isCredits =
    (rawCode && CREDIT_CODES.has(rawCode)) ||
    CREDIT_CODES.has(parsedDiag.errorClass) ||
    parsedDiag.dataforseoStatusCode === 40200 ||
    parsedDiag.dataforseoStatusCode === 40210;

  if (isCredits) {
    const isFunds =
      rawCode === "INSUFFICIENT_FUNDS" ||
      parsedDiag.dataforseoStatusCode === 40210;
    return {
      httpStatus: parsedDiag.httpStatus ?? 200,
      taskStatus: isFunds ? 40210 : 40200,
      errorClass:
        rawCode ?? (isFunds ? "INSUFFICIENT_FUNDS" : "CREDITS_UNAVAILABLE"),
      errorMessage: isFunds
        ? "Insufficient DataForSEO funds."
        : "DataForSEO credits unavailable.",
    };
  }

  const isRateLimit =
    (rawCode && RATE_LIMIT_CODES.has(rawCode)) ||
    RATE_LIMIT_CODES.has(parsedDiag.errorClass) ||
    parsedDiag.dataforseoStatusCode === 40202;

  if (isRateLimit) {
    return {
      httpStatus: parsedDiag.httpStatus ?? 200,
      taskStatus: parsedDiag.dataforseoStatusCode ?? 40202,
      errorClass: rawCode ?? "RATE_LIMITED",
      errorMessage: "DataForSEO rate limit reached.",
    };
  }

  const isTransient =
    (rawCode && UPSTREAM_CODES.has(rawCode)) ||
    parsedDiag.httpStatus === 500 ||
    UPSTREAM_CODES.has(parsedDiag.errorClass);

  if (isTransient) {
    return {
      httpStatus: parsedDiag.httpStatus ?? 500,
      taskStatus: parsedDiag.dataforseoStatusCode ?? 50000,
      errorClass: rawCode ?? "TRANSIENT_UPSTREAM",
      errorMessage: "The data provider is temporarily unavailable.",
    };
  }

  return {
    httpStatus: parsedDiag.httpStatus ?? 500,
    taskStatus: parsedDiag.dataforseoStatusCode ?? null,
    errorClass: rawCode ?? "OPERATION_FAILED",
    errorMessage:
      error instanceof Error ? error.message : "Keyword research failed",
  };
}

export function recordKeywordResearchTraceFailure(
  opId: string,
  error: unknown,
  request: KeywordResearchTraceRequest,
): void {
  const details = resolveTraceFailureDetails(error, request);

  globalTraceStore.completeOperation(opId, {
    status: "failed",
    httpStatus: details.httpStatus,
    provider: "DataForSEO",
    providerCalls: 1,
    providerBreakdown: [{ provider: "DataForSEO", count: 1 }],
    providers: [
      {
        provider: "DataForSEO",
        endpoint: "v3/dataforseo_labs/google/keyword_suggestions/live",
        httpStatus: details.httpStatus,
        taskStatus: details.taskStatus,
        transport: "HTTP",
        billing: "Paid",
        metered: true,
        budgetGuard: "PASS",
      },
    ],
    retry: { attempted: false, count: 0 },
    billing: "Paid",
    metered: true,
    errorClass: details.errorClass,
    errorMessage: details.errorMessage,
    metadata: details.metadata,
  });
}
