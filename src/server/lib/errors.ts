import { isErrorCode, type ErrorCode } from "@/shared/error-codes";

export class AppError extends Error {
  constructor(
    public readonly code: ErrorCode,
    message?: string,
    public readonly details?: Record<string, string>,
  ) {
    super(message ?? code);
    this.name = "AppError";
  }
}

type ErrorLike = {
  name: string;
  message?: unknown;
  provider?: unknown;
};

function isErrorLike(value: unknown): value is ErrorLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "name" in value &&
    typeof value.name === "string"
  );
}

export function asAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof Error && isErrorCode(error.message)) {
    return new AppError(error.message, error.message);
  }
  if (isErrorLike(error)) {
    if (error.name === "BudgetExceededError") {
      return new AppError(
        "PAYMENT_REQUIRED",
        typeof error.message === "string" ? error.message : undefined,
      );
    }
    if (error.name === "AuthenticationError") {
      if (error.provider === "dataforseo") {
        return new AppError(
          "DATAFORSEO_AUTH_FAILED",
          typeof error.message === "string" ? error.message : undefined,
        );
      }
      return new AppError(
        "UNAUTHENTICATED",
        typeof error.message === "string" ? error.message : undefined,
      );
    }
    if (error.name === "RateLimitError") {
      return new AppError(
        "RATE_LIMITED",
        typeof error.message === "string" ? error.message : undefined,
      );
    }
    if (error.name === "ProviderUnavailableError") {
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        typeof error.message === "string" ? error.message : undefined,
      );
    }
    if (error.name === "ProviderUnsupportedError") {
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        typeof error.message === "string" ? error.message : undefined,
      );
    }
    if (error.name === "SeRankingAuthError") {
      return new AppError(
        "UNAUTHENTICATED",
        typeof error.message === "string" ? error.message : undefined,
        {
          publicMessage:
            "SE Ranking rejected the API token. Verify your SE Ranking API key in Settings.",
        },
      );
    }
    if (error.name === "SeRankingRateLimitError") {
      return new AppError(
        "RATE_LIMITED",
        typeof error.message === "string" ? error.message : undefined,
        {
          publicMessage:
            "SE Ranking rate limit reached. Please wait a moment and try again.",
        },
      );
    }
    if (error.name === "SeRankingCreditExhaustedError") {
      return new AppError(
        "INSUFFICIENT_CREDITS",
        typeof error.message === "string" ? error.message : undefined,
        {
          publicMessage:
            "Insufficient SE Ranking API credits for this request.",
        },
      );
    }
    if (error.name === "SeRankingValidationError") {
      const safeDetail =
        typeof error.message === "string" && error.message.trim().length > 0
          ? error.message.trim()
          : "SE Ranking response validation failed.";
      return new AppError("VALIDATION_ERROR", safeDetail, {
        publicMessage: safeDetail,
      });
    }
    if (
      error.name === "SeRankingUpstreamError" ||
      error.name === "SeRankingError"
    ) {
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        typeof error.message === "string" ? error.message : undefined,
        {
          publicMessage:
            "SE Ranking is temporarily unavailable. Please retry in a moment.",
        },
      );
    }
    if (error.name === "ZodError") {
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        "Invalid upstream response format",
      );
    }
  }
  return null;
}

// Codes whose server-side message is safe and useful to show the user.
// Setup errors only: their messages are static guidance ("TEAM_DOMAIN must be
// a full https URL…") that self-hosters need to fix their deployment, and the
// alternative is a generic card that makes every misconfiguration look the
// same. Everything else stays stripped to its bare code.
const CLIENT_DETAIL_ERROR_CODES = new Set<ErrorCode>(["AUTH_CONFIG_MISSING"]);

export function toClientError(error: unknown, correlationId?: string): Error {
  const appError = asAppError(error);
  const code = appError?.code ?? "INTERNAL_ERROR";
  const refTag = correlationId ? `[ref: ${correlationId}]` : "";
  const publicMessage = appError?.details?.publicMessage?.trim();

  if (
    appError &&
    CLIENT_DETAIL_ERROR_CODES.has(appError.code) &&
    appError.message !== appError.code
  ) {
    const detail = refTag ? `${refTag} ${appError.message}` : appError.message;
    return new Error(`${appError.code}: ${detail}`);
  }

  if (publicMessage) {
    const detail = refTag ? `${refTag} ${publicMessage}` : publicMessage;
    return new Error(`${code}: ${detail}`);
  }

  if (refTag && code === "INTERNAL_ERROR") {
    return new Error(`${code}: ${refTag}`);
  }

  return new Error(code);
}
