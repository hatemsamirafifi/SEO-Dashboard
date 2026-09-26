import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi, beforeEach } from "vitest";

// Mock Workers environment for any imported server functions
vi.mock("cloudflare:workers", () => ({ env: {} }));

// Mock Link from @tanstack/react-router to render standard <a> tags for static markup testing
vi.mock("@tanstack/react-router", () => ({
  Link: ({
    to,
    children,
    className,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
    className?: string;
  }) =>
    React.createElement(
      "a",
      { href: to, className, ...rest },
      children,
    ),
}));

// Mock researchKeywords server function to simulate provider failures
const mockResearchKeywords = vi.fn();
vi.mock("@/serverFunctions/keywords", () => ({
  researchKeywords: (...args: unknown[]) => mockResearchKeywords(...args),
}));

import {
  classifyResearchError,
  KeywordResearchErrorCard,
} from "./page/KeywordResearchErrorCard";
import { keywordResearchQueryFn } from "./hooks/useKeywordResearchData";
import { globalTraceStore } from "@/client/features/tracing/globalTraceStore";
import { DataforseoTestAlert } from "@/client/features/settings/DataforseoSettingsParts";
import { STANDARD_MESSAGES } from "@/client/lib/error-messages";

describe("Keyword Research 40201 & Error Classification", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Requirement 1: Classification of DATAFORSEO_ACCESS_PAUSED
  it("classifies DATAFORSEO_ACCESS_PAUSED as access_paused with curated guidance", () => {
    const error = new Error("DATAFORSEO_ACCESS_PAUSED");
    const result = classifyResearchError(error);

    expect(result.type).toBe("access_paused");
    expect(result.title).toBe("DataForSEO access paused");
    expect(result.message).toContain("support@dataforseo.com");
    expect(result.message).not.toContain("unexpected error");
  });

  // Requirement 2: Backwards compatibility with DATAFORSEO_ACCOUNT_PAUSED
  it("classifies legacy DATAFORSEO_ACCOUNT_PAUSED as access_paused", () => {
    const error = new Error("DATAFORSEO_ACCOUNT_PAUSED");
    const result = classifyResearchError(error);

    expect(result.type).toBe("access_paused");
    expect(result.title).toBe("DataForSEO access paused");
  });

  // Requirement 3: Fallback heuristic for raw 40201 task status error text
  it("classifies error containing 40201 or unusual activity heuristic text as access_paused", () => {
    const error = new Error(
      "DataForSEO task error (40201): We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access as a precaution.",
    );
    const result = classifyResearchError(error);

    expect(result.type).toBe("access_paused");
    expect(result.title).toBe("DataForSEO access paused");
  });

  // Requirement 4: STANDARD_MESSAGES contains trusted support email and no generic message
  it("provides actionable standard message pointing to support@dataforseo.com", () => {
    const standardMessage = STANDARD_MESSAGES.DATAFORSEO_ACCESS_PAUSED;
    expect(standardMessage).toBeDefined();
    expect(standardMessage).toContain("support@dataforseo.com");
    expect(standardMessage).toContain("temporarily restricted API access as a security precaution");
    expect(standardMessage).not.toContain("unexpected error");
  });

  // Requirement 5 & 6 & 7 & 8 & 9: UI Error Card for 40201 Access Paused
  describe("KeywordResearchErrorCard for 40201 Access Paused", () => {
    it("renders AlertTriangle, title, contact support, debug trace, settings, and HIDES Try again", () => {
      const error = new Error("DATAFORSEO_ACCESS_PAUSED");
      const html = renderToStaticMarkup(
        React.createElement(KeywordResearchErrorCard, {
          error,
          errorMessage: STANDARD_MESSAGES.DATAFORSEO_ACCESS_PAUSED,
          onRetry: vi.fn(),
        }),
      );

      // Title
      expect(html).toContain("DataForSEO access paused");

      // Message
      expect(html).toContain("support@dataforseo.com");

      // Primary Action: [Contact Support] with mailto
      expect(html).toContain("mailto:support@dataforseo.com?subject=Reactivate%20DataForSEO%20API%20Access");
      expect(html).toContain("Contact Support");

      // Secondary Action: [View Debug Trace]
      expect(html).toContain("View Debug Trace");

      // Tertiary Action: [Open DataForSEO Settings]
      expect(html).toContain('href="/settings"');
      expect(html).toContain("Open DataForSEO Settings");

      // CRITICAL: Generic "Try again" button must NOT be present
      expect(html).not.toContain("Try again");
    });
  });

  // Requirement 10: Insufficient funds error card
  describe("KeywordResearchErrorCard for Insufficient Funds", () => {
    it.each([
      ["INSUFFICIENT_FUNDS"],
      ["CREDITS_UNAVAILABLE"],
    ])("renders title Insufficient DataForSEO funds and settings link for %s", (code) => {
      const error = new Error(code);
      const html = renderToStaticMarkup(
        React.createElement(KeywordResearchErrorCard, {
          error,
          errorMessage: "Insufficient funds",
          onRetry: vi.fn(),
        }),
      );

      expect(html).toContain("Insufficient DataForSEO funds");
      expect(html).toContain('href="/settings"');
      expect(html).not.toContain("Try again");
    });
  });

  // Requirement 11: Rate limited error card
  describe("KeywordResearchErrorCard for Rate Limits", () => {
    it.each([
      ["RATE_LIMITED"],
      ["TOO_MANY_SIMULTANEOUS_QUERIES"],
    ])("renders title DataForSEO rate limit reached and Try again button for %s", (code) => {
      const error = new Error(code);
      const html = renderToStaticMarkup(
        React.createElement(KeywordResearchErrorCard, {
          error,
          errorMessage: "Rate limited",
          onRetry: vi.fn(),
        }),
      );

      expect(html).toContain("DataForSEO rate limit reached");
      expect(html).toContain("Try again");
    });
  });

  // Requirement 12: Upstream failure error card
  describe("KeywordResearchErrorCard for Upstream Failure", () => {
    it.each([
      ["UPSTREAM_UNAVAILABLE"],
      ["TRANSIENT_UPSTREAM"],
    ])("renders title Data provider unavailable and Try again button for %s", (code) => {
      const error = new Error(code);
      const html = renderToStaticMarkup(
        React.createElement(KeywordResearchErrorCard, {
          error,
          errorMessage: "Provider unavailable",
          onRetry: vi.fn(),
        }),
      );

      expect(html).toContain("Data provider unavailable");
      expect(html).toContain("Try again");
    });
  });

  // Requirement 13: Generic error fallback
  describe("KeywordResearchErrorCard for Generic Fallback", () => {
    it("renders fallback for unknown error with Try again button", () => {
      const error = new Error("Database connection dropped unexpectedly");
      const html = renderToStaticMarkup(
        React.createElement(KeywordResearchErrorCard, {
          error,
          errorMessage: "Database connection dropped unexpectedly",
          onRetry: vi.fn(),
        }),
      );

      expect(html).toContain("Error");
      expect(html).toContain("Database connection dropped unexpectedly");
      expect(html).toContain("Try again");
    });
  });

  // Requirement 14: Global Debug Trace Truthfulness on 40201 Failure
  describe("Global Debug Trace Truthfulness", () => {
    it("completes operation with truthful HTTP 200, taskStatus 40201, providerCalls 1, and no retry", async () => {
      const completeSpy = vi.spyOn(globalTraceStore, "completeOperation");

      mockResearchKeywords.mockRejectedValueOnce(
        new Error("DATAFORSEO_ACCESS_PAUSED"),
      );

      await expect(
        keywordResearchQueryFn({
          projectId: "proj_123",
          keywords: ["seo audit"],
          seedKeyword: "seo audit",
          locationCode: 2840,
          resultLimit: 150,
          mode: "auto",
          clickstream: false,
        }),
      ).rejects.toThrow("DATAFORSEO_ACCESS_PAUSED");

      expect(completeSpy).toHaveBeenCalledTimes(1);
      const patch = completeSpy.mock.calls[0][1];

      // Truthful status & error class
      expect(patch.status).toBe("failed");
      expect(patch.errorClass).toBe("DATAFORSEO_ACCESS_PAUSED");

      // Truthful HTTP status: 200 (never 500)
      expect(patch.httpStatus).toBe(200);

      // Truthful Provider calls: 1 (never 0)
      expect(patch.providerCalls).toBe(1);
      expect(patch.provider).toBe("DataForSEO");
      expect(patch.providerBreakdown).toEqual([
        { provider: "DataForSEO", count: 1 },
      ]);

      // Providers detail
      expect(patch.providers).toBeDefined();
      expect(patch.providers?.[0]).toMatchObject({
        provider: "DataForSEO",
        endpoint: "v3/dataforseo_labs/google/keyword_suggestions/live",
        httpStatus: 200,
        taskStatus: 40201,
        billing: "Paid",
        metered: true,
        budgetGuard: "PASS",
      });

      // Retry: NO
      expect(patch.retry).toEqual({ attempted: false, count: 0 });

      // Metadata records providerAccess PAUSED and statusCode 40201
      expect(patch.metadata).toMatchObject({
        providerAccess: "PAUSED",
        dataforseoStatusCode: 40201,
      });
    });
  });

  // Requirement 15: Settings DataforseoTestAlert alignment
  describe("Settings DataforseoTestAlert Alignment", () => {
    it("renders access paused alert with HTTP 200 / 40201 notice and operational guidance", () => {
      const html = renderToStaticMarkup(
        React.createElement(DataforseoTestAlert, {
          result: {
            ok: false,
            status: 402,
            reason: "DATAFORSEO_ACCESS_PAUSED",
            billingStatus: "unknown",
          },
        }),
      );

      expect(html).toContain("DataForSEO access paused (HTTP 200 / 40201)");
      expect(html).toContain(
        "API Health = Operational does NOT mean account access is active",
      );
      expect(html).toContain("support@dataforseo.com");
    });
  });
});
