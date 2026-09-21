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
    | "generic";
  title: string;
  message: string;
};

export function classifyResearchError(error: unknown): ClassifiedResearchError {
  const code = getErrorCode(error);
  const msg = error instanceof Error ? error.message : "";
  const lowerMsg = msg.toLowerCase();

  const isAccessPaused =
    code === "DATAFORSEO_ACCESS_PAUSED" ||
    code === "DATAFORSEO_ACCOUNT_PAUSED" ||
    lowerMsg.includes("40201") ||
    lowerMsg.includes("paused access") ||
    lowerMsg.includes("unusual activity");

  if (isAccessPaused) {
    return {
      type: "access_paused",
      title: "DataForSEO access paused",
      message:
        "DataForSEO access is temporarily paused. Your credentials are valid and your account may have available balance, but DataForSEO has temporarily restricted API access as a security precaution. Contact DataForSEO support at support@dataforseo.com to reactivate the account.",
    };
  }

  const isInsufficientFunds =
    code === "INSUFFICIENT_FUNDS" ||
    code === "CREDITS_UNAVAILABLE" ||
    code === "INSUFFICIENT_CREDITS" ||
    code === "PAYMENT_REQUIRED" ||
    lowerMsg.includes("40210") ||
    lowerMsg.includes("40200") ||
    lowerMsg.includes("insufficient funds") ||
    lowerMsg.includes("balance is too low");

  if (isInsufficientFunds) {
    return {
      type: "insufficient_funds",
      title: "Insufficient DataForSEO funds",
      message:
        "Your DataForSEO balance is not sufficient for this request. Please add funds to your DataForSEO account.",
    };
  }

  const isRateLimited =
    code === "RATE_LIMITED" ||
    code === "COST_LIMIT_EXCEEDED" ||
    code === "TOO_MANY_SIMULTANEOUS_QUERIES" ||
    lowerMsg.includes("40202") ||
    lowerMsg.includes("40203") ||
    lowerMsg.includes("40209") ||
    lowerMsg.includes("rate limit") ||
    lowerMsg.includes("simultaneous");

  if (isRateLimited) {
    return {
      type: "rate_limited",
      title: "DataForSEO rate limit reached",
      message: "Please wait and try again.",
    };
  }

  const isUpstream =
    code === "UPSTREAM_UNAVAILABLE" ||
    code === "TRANSIENT_UPSTREAM" ||
    lowerMsg.includes("temporarily unavailable") ||
    lowerMsg.includes("upstream");

  if (isUpstream) {
    return {
      type: "upstream_unavailable",
      title: "Data provider unavailable",
      message:
        "The data provider is temporarily unavailable. Please retry in a moment.",
    };
  }

  return {
    type: "generic",
    title: "Error",
    message:
      msg ||
      "An unexpected error occurred. Please check server logs and try again.",
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
        <div className="w-full max-w-xl rounded-xl border border-warning/40 bg-warning/10 p-5 text-warning-content shadow-sm space-y-4">
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
            <a
              href="mailto:support@dataforseo.com?subject=Reactivate%20DataForSEO%20API%20Access"
              className="btn btn-sm btn-primary"
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
    classified.type === "upstream_unavailable"
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
            </div>
          </div>
          <div className="pt-1 pl-8">
            <button className="btn btn-sm" onClick={onRetry}>
              Try again
            </button>
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
          </div>
        </div>
        <div className="pt-1 pl-8">
          <button className="btn btn-sm" onClick={onRetry}>
            Try again
          </button>
        </div>
      </div>
    </div>
  );
}
