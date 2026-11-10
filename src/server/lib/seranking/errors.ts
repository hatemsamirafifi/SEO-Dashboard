import { AppError } from "@/server/lib/errors";

export class SeRankingError extends Error {
  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
  ) {
    super(message);
    this.name = "SeRankingError";
  }
}

export class SeRankingAuthError extends SeRankingError {
  constructor(message = "SE Ranking authentication failed. Please check your API key.") {
    super(message, 401);
    this.name = "SeRankingAuthError";
  }
}

export class SeRankingRateLimitError extends SeRankingError {
  constructor(message = "SE Ranking rate limit exceeded (HTTP 429).") {
    super(message, 429);
    this.name = "SeRankingRateLimitError";
  }
}

export class SeRankingCreditExhaustedError extends SeRankingError {
  constructor(message = "SE Ranking account has insufficient credits.") {
    super(message, 402);
    this.name = "SeRankingCreditExhaustedError";
  }
}

export class SeRankingNotFoundError extends SeRankingError {
  constructor(message = "SE Ranking resource not found.") {
    super(message, 404);
    this.name = "SeRankingNotFoundError";
  }
}

export class SeRankingValidationError extends SeRankingError {
  constructor(message = "SE Ranking request validation error.", responseBody?: unknown) {
    super(message, 400, responseBody);
    this.name = "SeRankingValidationError";
  }
}

export class SeRankingUpstreamError extends SeRankingError {
  constructor(message = "SE Ranking upstream service error.", statusCode = 500) {
    super(message, statusCode);
    this.name = "SeRankingUpstreamError";
  }
}

export function classifySeRankingHttpError(status: number, body: unknown): SeRankingError {
  const msg = typeof body === "object" && body !== null && "message" in body && typeof body.message === "string"
    ? body.message
    : typeof body === "string"
      ? body
      : `SE Ranking API error HTTP ${status}`;

  if (status === 401 || status === 403) {
    return new SeRankingAuthError(msg);
  }
  if (status === 429) {
    return new SeRankingRateLimitError(msg);
  }
  if (status === 402 || (typeof msg === "string" && msg.toLowerCase().includes("insufficient"))) {
    return new SeRankingCreditExhaustedError(msg);
  }
  if (status === 404) {
    return new SeRankingNotFoundError(msg);
  }
  if (status === 400 || status === 422) {
    return new SeRankingValidationError(msg, body);
  }
  return new SeRankingUpstreamError(msg, status);
}

export function toAppErrorFromSeRanking(error: unknown): AppError | null {
  if (error instanceof SeRankingAuthError) {
    return new AppError("UNAUTHENTICATED", error.message);
  }
  if (error instanceof SeRankingCreditExhaustedError) {
    return new AppError("PAYMENT_REQUIRED", error.message);
  }
  if (error instanceof SeRankingRateLimitError) {
    return new AppError("RATE_LIMITED", error.message);
  }
  if (error instanceof SeRankingNotFoundError) {
    return new AppError("NOT_FOUND", error.message);
  }
  if (error instanceof SeRankingValidationError) {
    return new AppError("VALIDATION_ERROR", error.message);
  }
  if (error instanceof SeRankingUpstreamError) {
    return new AppError("UPSTREAM_UNAVAILABLE", error.message);
  }
  return null;
}
