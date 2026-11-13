import { AppError } from "@/server/lib/errors";

export class SeRankingError extends Error {
  public readonly upstreamStatus?: number;

  constructor(
    message: string,
    public readonly statusCode?: number,
    public readonly responseBody?: unknown,
    upstreamStatus?: number,
  ) {
    super(message);
    this.name = "SeRankingError";
    this.upstreamStatus = upstreamStatus ?? statusCode;
  }
}

export class SeRankingAuthError extends SeRankingError {
  constructor(
    message = "SE Ranking authentication failed. Please check your API key.",
    upstreamStatus = 401,
  ) {
    super(message, 401, undefined, upstreamStatus);
    this.name = "SeRankingAuthError";
  }
}

export class SeRankingRateLimitError extends SeRankingError {
  constructor(
    message = "SE Ranking rate limit exceeded (HTTP 429).",
    upstreamStatus = 429,
  ) {
    super(message, 429, undefined, upstreamStatus);
    this.name = "SeRankingRateLimitError";
  }
}

export class SeRankingCreditExhaustedError extends SeRankingError {
  constructor(
    message = "SE Ranking account has insufficient credits.",
    upstreamStatus = 402,
  ) {
    super(message, 402, undefined, upstreamStatus);
    this.name = "SeRankingCreditExhaustedError";
  }
}

export class SeRankingNotFoundError extends SeRankingError {
  constructor(
    message = "SE Ranking resource not found.",
    upstreamStatus = 404,
  ) {
    super(message, 404, undefined, upstreamStatus);
    this.name = "SeRankingNotFoundError";
  }
}

export class SeRankingValidationError extends SeRankingError {
  public readonly rawItemCount?: number;

  constructor(
    message = "SE Ranking request validation error.",
    responseBody?: unknown,
    upstreamStatus = 400,
    rawItemCount?: number,
  ) {
    super(message, 400, responseBody, upstreamStatus);
    this.name = "SeRankingValidationError";
    this.rawItemCount = rawItemCount;
  }
}

export class SeRankingUpstreamError extends SeRankingError {
  constructor(
    message = "SE Ranking upstream service error.",
    statusCode = 500,
    upstreamStatus?: number,
  ) {
    super(message, statusCode, undefined, upstreamStatus ?? statusCode);
    this.name = "SeRankingUpstreamError";
  }
}

export function classifySeRankingHttpError(
  status: number,
  body: unknown,
): SeRankingError {
  const msg =
    typeof body === "object" &&
    body !== null &&
    "message" in body &&
    typeof body.message === "string"
      ? body.message
      : typeof body === "string"
        ? body
        : `SE Ranking API error HTTP ${status}`;

  const lowerMsg = typeof msg === "string" ? msg.toLowerCase() : "";
  const isQuotaMessage =
    lowerMsg.includes("insufficient") ||
    lowerMsg.includes("quota") ||
    lowerMsg.includes("limit exceeded") ||
    lowerMsg.includes("subscription") ||
    lowerMsg.includes("expired") ||
    lowerMsg.includes("exceeds limit");

  if (status === 402 || isQuotaMessage) {
    return new SeRankingCreditExhaustedError(msg, status);
  }
  if (status === 401 || status === 403) {
    return new SeRankingAuthError(msg, status);
  }
  if (status === 429) {
    return new SeRankingRateLimitError(msg, status);
  }
  if (status === 404) {
    return new SeRankingNotFoundError(msg, status);
  }
  if (status === 400 || status === 422) {
    return new SeRankingValidationError(msg, body, status);
  }
  return new SeRankingUpstreamError(msg, status, status);
}

function makeDetails(
  upstream?: number,
  extra?: Record<string, string>,
): Record<string, string> | undefined {
  const d: Record<string, string> = { ...extra };
  if (upstream !== undefined) {
    d.upstreamStatus = String(upstream);
  }
  return Object.keys(d).length > 0 ? d : undefined;
}

export function toAppErrorFromSeRanking(error: unknown): AppError | null {
  if (error instanceof SeRankingAuthError) {
    return new AppError(
      "UNAUTHENTICATED",
      error.message,
      makeDetails(error.upstreamStatus),
    );
  }
  if (error instanceof SeRankingCreditExhaustedError) {
    return new AppError(
      "PAYMENT_REQUIRED",
      error.message,
      makeDetails(error.upstreamStatus),
    );
  }
  if (error instanceof SeRankingRateLimitError) {
    return new AppError(
      "RATE_LIMITED",
      error.message,
      makeDetails(error.upstreamStatus),
    );
  }
  if (error instanceof SeRankingNotFoundError) {
    return new AppError(
      "NOT_FOUND",
      error.message,
      makeDetails(error.upstreamStatus),
    );
  }
  if (error instanceof SeRankingValidationError) {
    return new AppError(
      "VALIDATION_ERROR",
      error.message,
      makeDetails(error.upstreamStatus ?? 200, { localStatus: "400" }),
    );
  }
  if (error instanceof SeRankingUpstreamError) {
    return new AppError(
      "UPSTREAM_UNAVAILABLE",
      error.message,
      makeDetails(error.upstreamStatus),
    );
  }
  return null;
}
