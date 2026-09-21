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

export function asAppError(error: unknown): AppError | null {
  if (error instanceof AppError) return error;
  if (error instanceof Error && isErrorCode(error.message)) {
    return new AppError(error.message, error.message);
  }
  if (error && typeof error === "object") {
    const err = error as Record<string, unknown>;
    if (err.name === "BudgetExceededError") {
      return new AppError(
        "PAYMENT_REQUIRED",
        typeof err.message === "string" ? err.message : undefined,
      );
    }
    if (err.name === "AuthenticationError") {
      if (err.provider === "dataforseo") {
        return new AppError(
          "DATAFORSEO_AUTH_FAILED",
          typeof err.message === "string" ? err.message : undefined,
        );
      }
      return new AppError(
        "UNAUTHENTICATED",
        typeof err.message === "string" ? err.message : undefined,
      );
    }
    if (err.name === "RateLimitError") {
      return new AppError(
        "RATE_LIMITED",
        typeof err.message === "string" ? err.message : undefined,
      );
    }
    if (err.name === "ProviderUnavailableError") {
      return new AppError(
        "UPSTREAM_UNAVAILABLE",
        typeof err.message === "string" ? err.message : undefined,
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

export function toClientError(error: unknown): Error {
  const appError = asAppError(error);
  if (
    appError &&
    CLIENT_DETAIL_ERROR_CODES.has(appError.code) &&
    appError.message !== appError.code
  ) {
    return new Error(`${appError.code}: ${appError.message}`);
  }
  return new Error(appError?.code ?? "INTERNAL_ERROR");
}
