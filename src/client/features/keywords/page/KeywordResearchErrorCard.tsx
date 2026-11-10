import { Link } from "@tanstack/react-router";
import { AlertCircle, AlertTriangle } from "lucide-react";
import { getErrorCode } from "@/client/lib/error-messages";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { BILLING_ROUTE } from "@/shared/billing";

export type ClassifiedResearchError = {
  type:
    | "access_paused"
    | "insufficient_funds"
    | "rate_limited"
    | "upstream_unavailable"
    | "invalid_upstream"
    | "unsupported_market"
    | "no_data"
    | "internal_error"
    | "generic";
  title: string;
  message: string;
  correlationId?: string | null;
};

function isAccessPausedError(code: string | null, lowerMsg: string): boolean {
  return (
    code === "DATAFORSEO_ACCESS_PAUSED" ||
    code === "DATAFORSEO_ACCOUNT_PAUSED" ||
    lowerMsg.includes("40201") ||
    lowerMsg.includes("paused access") ||
    lowerMsg.includes("unusual activity")
  );
}

function isInvalidUpstreamError(lowerMsg: string): boolean {
  return (
    lowerMsg.includes("invalid upstream") ||
    lowerMsg.includes("zoderror") ||
    lowerMsg.includes("malformed") ||
    lowerMsg.includes("unexpected format")
  );
}

function isUnsupportedMarketError(lowerMsg: string): boolean {
  return (
    lowerMsg.includes("unsupported market") ||
    lowerMsg.includes("market not supported") ||
    (lowerMsg.includes("unsupported") && lowerMsg.includes("location"))
  );
}

function isNoDataError(code: string | null, lowerMsg: string): boolean {
  return (
    code === "NOT_FOUND" ||
    lowerMsg.includes("no keyword data") ||
    lowerMsg.includes("no data found")
  );
}

function isInsufficientFundsError(code: string | null, lowerMsg: string): boolean {
  return (
    code === "INSUFFICIENT_FUNDS" ||
    code === "CREDITS_UNAVAILABLE" ||
    code === "INSUFFICIENT_CREDITS" ||
    code === "PAYMENT_REQUIRED" ||
    lowerMsg.includes("40210") ||
    lowerMsg.includes("40200") ||
    lowerMsg.includes("insufficient funds") ||
    lowerMsg.includes("insufficient credits") ||
    lowerMsg.includes("balance is too low")
  );
}

function isRateLimitedError(code: string | null, lowerMsg: string): boolean {
  return (
    code === "RATE_LIMITED" ||
    code === "COST_LIMIT_EXCEEDED" ||
    code === "TOO_MANY_SIMULTANEOUS_QUERIES" ||
    lowerMsg.includes("40202") ||
    lowerMsg.includes("40203") ||
    lowerMsg.includes("40209") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("simultaneous")
  );
}

function isUpstreamUnavailableError(code: string | null, lowerMsg: string): boolean {
  return (
    code === "UPSTREAM_UNAVAILABLE" ||
    code === "TRANSIENT_UPSTREAM" ||
    lowerMsg.includes("temporarily unavailable") ||
    lowerMsg.includes("upstream")
  );
}

function isInternalServerError(code: string | null, msg: string, lowerMsg: string): boolean {
  return (
    code === "INTERNAL_ERROR" ||
    msg === "INTERNAL_ERROR" ||
    lowerMsg.startsWith("internal_error")
  );
}

export function classifyResearchError(error: unknown): ClassifiedResearchError {
  const code = getErrorCode(error);
  const msg = error instanceof Error ? error.message : "";
  const lowerMsg = msg.toLowerCase();
  const correlationId = msg.match(/\[ref:\s*([a-zA-Z0-9_-]+)\]/)?.[1] ?? null;

  if (isAccessPausedError(code, lowerMsg)) {
    return {
      type: "access_paused",
      title: "DataForSEO access paused",
      message:
        "DataForSEO access is temporarily paused. Your credentials are valid and your account may have available balance, but DataForSEO has temporarily restricted API access as a security precaution. Contact DataForSEO support at support@dataforseo.com to reactivate the account.",
      correlationId,
    };
  }

  if (isInvalidUpstreamError(lowerMsg)) {
    return {
      type: "invalid_upstream",
      title: "Invalid upstream response",
      message:
        "The data provider returned an unexpected response format. Please retry or adjust search parameters.",
      correlationId,
    };
  }

  if (isUnsupportedMarketError(lowerMsg)) {
    return {
      type: "unsupported_market",
      title: "Unsupported market",
      message:
        "The requested country or language is not supported by the active data provider.",
      correlationId,
    };
  }

  if (isNoDataError(code, lowerMsg)) {
    return {
      type: "no_data",
      title: "No keyword data",
      message:
        "No keyword data was found for this query in the selected location. Try searching for a broader term.",
      correlationId,
    };
  }

  if (isInsufficientFundsError(code, lowerMsg)) {
    const isDataForSeoSpecific =
      code === "INSUFFICIENT_FUNDS" ||
      code === "CREDITS_UNAVAILABLE" ||
      lowerMsg.includes("dataforseo");

    return {
      type: "insufficient_funds",
      title: isDataForSeoSpecific
        ? "Insufficient DataForSEO funds"
        : "Insufficient credits",
      message: isDataForSeoSpecific
        ? "Your DataForSEO balance is not sufficient for this request. Please add funds to your DataForSEO account."
        : "Your account credit balance or provider credit limit is insufficient for this request. Please add credits or upgrade your plan in Settings.",
      correlationId,
    };
  }

  if (isRateLimitedError(code, lowerMsg)) {
    return {
      type: "rate_limited",
      title: "DataForSEO rate limit reached",
      message: "Please wait and try again.",
      correlationId,
    };
  }

  if (isUpstreamUnavailableError(code, lowerMsg)) {
    return {
      type: "upstream_unavailable",
      title: "Data provider unavailable",
      message:
        "The data provider is temporarily unavailable. Please retry in a moment.",
      correlationId,
    };
  }

  if (isInternalServerError(code, msg, lowerMsg)) {
    return {
      type: "internal_error",
      title: "Internal server error",
      message:
        "An unexpected error occurred while processing keyword research. Please check server logs and try again.",
      correlationId,
    };
  }

  return {
    type: "generic",
    title: "Error",
    message:
      msg ||
      "An unexpected error occurred. Please check server logs and try again.",
    correlationId,
  };
}

export function KeywordResearchErrorCard({
  error,
  errorMessage,
  onRetry,
}: {
  error: unknown;
  errorMessage: string;
  onRetry: () => void;
}) {
  const classified = classifyResearchError(error);
  const displayMessage = classified.message || errorMessage;

  if (classified.type === "access_paused") {
    return (
      <div
        className="flex-1 flex items-center justify-center pt-1"
        data-testid="keyword-research-error-card"
      >
        <div className="w-full max-w-xl rounded-xl border border-warning/40 bg-warning/10 p-5 shadow-sm space-y-4">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="space-y-1">
              <h3 className="font-semibold text-base text-base-content">
                {classified.title}
              </h3>
              <p className="text-sm text-base-content/80 leading-relaxed">
                {displayMessage}
              </p>
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1 pl-8">
            <button
              type="button"
              className="btn btn-sm btn-primary"
              data-testid="keyword-research-retry-btn"
              onClick={onRetry}
            >
              Try again
            </button>
            <a
              href="mailto:support@dataforseo.com?subject=Reactivate%20DataForSEO%20API%20Access"
              className="btn btn-sm btn-outline"
              data-testid="keyword-research-contact-support-btn"
            >
              Contact Support
            </a>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              data-testid="keyword-research-view-debug-trace-btn"
              onClick={() => globalTraceStore.setPanelOpen(true)}
            >
              View Debug Trace
            </button>
            <Link
              to="/settings"
              className="btn btn-sm btn-ghost"
              data-testid="keyword-research-open-settings-btn"
            >
              Open DataForSEO Settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  if (classified.type === "insufficient_funds") {
    const isInternalCredits = getErrorCode(error) === "INSUFFICIENT_CREDITS";
    return (
      <div
        className="flex-1 flex items-center justify-center pt-1"
        data-testid="keyword-research-error-card"
      >
        <div className="w-full max-w-xl rounded-xl border border-error/30 bg-error/10 p-5 text-error space-y-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0" />
            <div className="space-y-1">
              <h3 className="font-semibold text-base text-base-content">
                {classified.title}
              </h3>
              <p className="text-sm text-base-content/80">{displayMessage}</p>
            </div>
          </div>
          <div className="pt-1 pl-8">
            {isInternalCredits ? (
              <Link to={BILLING_ROUTE} className="btn btn-sm btn-primary">
                Go to Billing
              </Link>
            ) : (
              <Link to="/settings" className="btn btn-sm btn-primary">
                Open DataForSEO Settings
              </Link>
            )}
          </div>
        </div>
      </div>
    );
  }

  if (
    classified.type === "rate_limited" ||
    classified.type === "upstream_unavailable" ||
    classified.type === "invalid_upstream" ||
    classified.type === "unsupported_market" ||
    classified.type === "no_data"
  ) {
    return (
      <div
        className="flex-1 flex items-center justify-center pt-1"
        data-testid="keyword-research-error-card"
      >
        <div className="w-full max-w-xl rounded-xl border border-warning/30 bg-warning/10 p-5 space-y-4">
          <div className="flex items-start gap-3">
            <AlertCircle className="mt-0.5 size-5 shrink-0 text-warning" />
            <div className="space-y-1">
              <h3 className="font-semibold text-base text-base-content">
                {classified.title}
              </h3>
              <p className="text-sm text-base-content/80">{displayMessage}</p>
              {classified.correlationId && (
                <p className="text-xs text-base-content/60 font-mono pt-1">
                  Reference: {classified.correlationId}
                </p>
              )}
            </div>
          </div>
          <div className="flex flex-wrap items-center gap-2 pt-1 pl-8">
            <button className="btn btn-sm btn-primary" onClick={onRetry}>
              Try again
            </button>
            <button
              type="button"
              className="btn btn-sm btn-outline"
              data-testid="keyword-research-view-debug-trace-btn"
              onClick={() => globalTraceStore.setPanelOpen(true)}
            >
              View Debug Trace
            </button>
            <Link
              to="/settings"
              className="btn btn-sm btn-ghost"
              data-testid="keyword-research-open-settings-btn"
            >
              Settings
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className="flex-1 flex items-center justify-center pt-1"
      data-testid="keyword-research-error-card"
    >
      <div className="w-full max-w-xl rounded-xl border border-error/30 bg-error/10 p-5 text-error space-y-3">
        <div className="flex items-start gap-3">
          <AlertCircle className="mt-0.5 size-5 shrink-0" />
          <div className="space-y-1">
            <h3 className="font-semibold text-base text-base-content">
              {classified.title}
            </h3>
            <p className="text-sm text-base-content/80">{displayMessage}</p>
            {classified.correlationId && (
              <p className="text-xs text-base-content/60 font-mono pt-1">
                Reference: {classified.correlationId}
              </p>
            )}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2 pt-1 pl-8">
          <button className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
          <button
            type="button"
            className="btn btn-sm btn-outline"
            data-testid="keyword-research-view-debug-trace-btn"
            onClick={() => globalTraceStore.setPanelOpen(true)}
          >
            View Debug Trace
          </button>
        </div>
      </div>
    </div>
  );
}
