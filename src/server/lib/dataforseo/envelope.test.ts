import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  assertOk,
  DataforseoChargedTaskError,
  isDataforseoAccountPaused,
  parseTaskItems,
} from "@/server/lib/dataforseo/envelope";
import { readDataforseoDiagnostics } from "@/server/lib/dataforseo/shared";
import { AppError } from "@/server/lib/errors";

const itemSchema = z.object({ keyword: z.string().optional() }).passthrough();

describe("parseTaskItems", () => {
  it("returns [] when the result items are null", () => {
    const task = { status_code: 20000, result: [{ items: null }] };
    expect(parseTaskItems("x", task, itemSchema)).toEqual([]);
  });

  it("returns [] when there is no result", () => {
    expect(parseTaskItems("x", { result: undefined }, itemSchema)).toEqual([]);
  });

  it("parses present items", () => {
    const task = { result: [{ items: [{ keyword: "seo" }] }] };
    expect(parseTaskItems("x", task, itemSchema)).toEqual([{ keyword: "seo" }]);
  });
});

describe("assertOk", () => {
  const okTask = {
    status_code: 20000,
    path: ["v3", "backlinks", "summary", "live"],
    cost: 0.1,
    result_count: 1,
    result: [],
  };

  it("returns the first task on success", () => {
    expect(assertOk({ status_code: 20000, tasks: [okTask] })).toBe(okTask);
  });

  it("throws DataforseoChargedTaskError when a charged task fails", () => {
    const task = {
      status_code: 40000,
      status_message: "fail",
      path: ["v3", "backlinks", "summary", "live"],
      cost: 0.05,
      result_count: 0,
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.billing).toEqual({
          path: task.path,
          costUsd: 0.05,
        });
      }
    }
  });

  it("appends the echoed request value to opaque 'Invalid Field' failures", () => {
    const task = {
      status_code: 40501,
      status_message: "Invalid Field: 'target'.",
      path: ["v3", "dataforseo_labs", "google", "domain_rank_overview", "live"],
      cost: 0.02,
      result_count: 0,
      data: { target: "not a valid domain", language_code: "en" },
    };
    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.message).toBe(
          `Invalid Field: 'target'. (sent target="not a valid domain")`,
        );
      }
    }
  });

  it("uses the classifier for non-charged (no-cost) failures", () => {
    const classify = vi.fn(
      () => new AppError("BACKLINKS_BILLING_ISSUE", "nope"),
    );
    const task = {
      status_code: 40200,
      status_message: "balance is too low",
    };
    expect(() =>
      assertOk(
        { status_code: 20000, tasks: [task] },
        { classify, classifyPath: "/v3/backlinks/summary/live" },
      ),
    ).toThrow("nope");
    expect(classify).toHaveBeenCalledWith(
      40200,
      "balance is too low",
      "/v3/backlinks/summary/live",
    );
  });

  it.each([
    [40200, "BACKLINKS_BILLING_ISSUE"],
    [40210, "BACKLINKS_BILLING_ISSUE"],
    [402, "BACKLINKS_BILLING_ISSUE"],
  ] as const)(
    "uses the classifier for account failure %s before charging billed task metadata",
    (status, code) => {
      const classify = vi.fn(
        () => new AppError(code, "Classified DataForSEO account failure"),
      );
      const task = {
        status_code: status,
        status_message: "Account balance is too low",
        path: ["v3", "backlinks", "summary", "live"],
        cost: 0.05,
        result_count: 0,
      };

      try {
        assertOk({ status_code: 20000, tasks: [task] }, { classify });
        throw new Error("expected assertOk to throw");
      } catch (error) {
        expect(error).not.toBeInstanceOf(DataforseoChargedTaskError);
        expect(error).toMatchObject({ code });
      }
      expect(classify).toHaveBeenCalledWith(
        status,
        "Account balance is too low",
        "/v3/backlinks/summary/live",
      );
    },
  );

  it("treats 40501 as an empty success when asked", () => {
    const task = {
      status_code: 40501,
      status_message: "No Search Results",
      path: ["v3", "serp", "google", "organic", "live", "advanced"],
      cost: 0.0,
    };
    expect(
      assertOk(
        { status_code: 20000, tasks: [task] },
        { treatNoResultsAsEmpty: true },
      ),
    ).toBe(task);
  });

  it("still surfaces a charged 40501 'Invalid Field' failure even with treatNoResultsAsEmpty", () => {
    // 40501 is not unique to no-results — it also covers validation rejections,
    // which are real charged failures we must not mask as empty results.
    const task = {
      status_code: 40501,
      status_message: "Invalid Field: 'categories'.",
      path: ["v3", "business_data", "business_listings", "search", "live"],
      cost: 0.02,
      result_count: 0,
      data: { categories: ["not_a_real_category"] },
    };
    try {
      assertOk(
        { status_code: 20000, tasks: [task] },
        { treatNoResultsAsEmpty: true },
      );
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(DataforseoChargedTaskError);
      if (error instanceof DataforseoChargedTaskError) {
        expect(error.billing).toEqual({ path: task.path, costUsd: 0.02 });
      }
    }
  });

  it("detects 40201 account paused task and throws canonical DATAFORSEO_ACCESS_PAUSED error with truthful HTTP 200", () => {
    const pauseMessage =
      "We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access as a precaution. Please contact our support team at support@dataforseo.com to resume access.";
    const task = {
      status_code: 40201,
      status_message: pauseMessage,
      path: ["v3", "dataforseo_labs", "google", "keyword_suggestions", "live"],
      cost: 0.05,
      result_count: 0,
      data: { target: "seo tools" },
    };

    expect(isDataforseoAccountPaused(task)).toBe(true);

    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error).not.toBeInstanceOf(DataforseoChargedTaskError);
      if (!(error instanceof AppError)) throw error;

      expect(error.code).toBe("DATAFORSEO_ACCESS_PAUSED");
      expect(error.message).toBe(pauseMessage);
      expect(error.details).toMatchObject({
        provider: "DataForSEO",
        providerStatusCode: "40201",
        providerStatusMessage: pauseMessage,
        errorClass: "DATAFORSEO_ACCESS_PAUSED",
      });

      const diagnostics = readDataforseoDiagnostics(error);
      expect(diagnostics).toBeDefined();
      expect(diagnostics?.httpStatus).toBe(200);
      expect(diagnostics?.httpStatus).not.toBe(500);
      expect(diagnostics?.dataforseoStatus).toBe(40201);
      expect(diagnostics?.dataforseoMessage).toBe(pauseMessage);
      expect(diagnostics?.request).toMatchObject({
        target: "seo tools",
      });
    }
  });

  it("handles 40201 at top-level response.status_code", () => {
    const pauseMessage =
      "We noticed some unusual activity in your DataForSEO account, so we've temporarily paused access as a precaution.";
    try {
      assertOk({
        status_code: 40201,
        status_message: pauseMessage,
      });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (!(error instanceof AppError)) throw error;
      expect(error.code).toBe("DATAFORSEO_ACCESS_PAUSED");
      expect(error.details).toMatchObject({
        providerStatusCode: "40201",
      });
      const diagnostics = readDataforseoDiagnostics(error);
      expect(diagnostics?.httpStatus).toBe(200);
      expect(diagnostics?.dataforseoStatus).toBe(40201);
    }
  });

  it("does not classify non-40201 errors as DATAFORSEO_ACCESS_PAUSED", () => {
    const task = {
      status_code: 40000,
      status_message: "Some other error",
    };
    expect(isDataforseoAccountPaused(task)).toBe(false);

    try {
      assertOk({ status_code: 20000, tasks: [task] });
      throw new Error("expected assertOk to throw");
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      if (error instanceof AppError) {
        expect(error.code).not.toBe("DATAFORSEO_ACCESS_PAUSED");
      }
    }
  });

  it.each([
    [40200, "CREDITS_UNAVAILABLE"],
    [40210, "INSUFFICIENT_FUNDS"],
    [40202, "RATE_LIMITED"],
    [40203, "COST_LIMIT_EXCEEDED"],
    [40209, "TOO_MANY_SIMULTANEOUS_QUERIES"],
    [50000, "TRANSIENT_UPSTREAM"],
  ] as const)(
    "classifies task status %s into %s by default without custom classifier",
    (status, expectedCode) => {
      const task = {
        status_code: status,
        status_message: `DataForSEO error ${status}`,
      };
      try {
        assertOk({ status_code: 20000, tasks: [task] });
        throw new Error("expected assertOk to throw");
      } catch (error) {
        expect(error).toBeInstanceOf(AppError);
        if (error instanceof AppError) {
          expect(error.code).toBe(expectedCode);
          expect(error.details).toMatchObject({
            providerStatusCode: String(status),
            errorClass: expectedCode,
          });
        }
      }
    },
  );
});
