import { describe, expect, it } from "vitest";
import {
  boundedRetryAfterMs,
  clampProviderRetries,
  classifyProviderFailure,
  retryBackoffMs,
  waitWithCancellation,
} from "./retryPolicy";

describe("classifyProviderFailure", () => {
  it("retries ordinary operational failures", () => {
    for (const code of [
      "NETWORK_OR_TIMEOUT",
      "PROVIDER_UNAVAILABLE",
      "UPSTREAM_UNAVAILABLE",
      "RATE_LIMITED",
      "TEMPORARY_UNAVAILABLE",
      "MALFORMED_JSON",
      "INVALID_PROVIDER_RESPONSE",
      "TRANSIENT_UPSTREAM",
      "PROVIDER_FAILURE",
    ]) {
      expect(classifyProviderFailure({ code, deterministic: false })).toEqual({
        category: code,
        retryable: true,
      });
    }
  });

  it("does not retry deterministic API/account/configuration failures", () => {
    for (const code of [
      "AUTH_FAILED",
      "INVALID_CREDENTIALS",
      "INVALID_API_KEY",
      "QUOTA_EXHAUSTED",
      "CREDITS_UNAVAILABLE",
      "DATAFORSEO_ACCOUNT_PAUSED",
      "PROVIDER_DISABLED",
      "MISSING_CREDENTIALS",
      "INVALID_CONFIGURATION",
      "UNSUPPORTED_DEVICE",
    ]) {
      expect(classifyProviderFailure({ code, deterministic: true })).toEqual({
        category: code,
        retryable: false,
      });
    }
  });

  // An adapter flag (deterministic) always wins over the code list: a provider
  // that reports a normally-retryable code as deterministic is respected.
  it("never retries a failure the adapter flagged deterministic", () => {
    expect(
      classifyProviderFailure({
        code: "RATE_LIMITED",
        deterministic: true,
      }),
    ).toEqual({ category: "RATE_LIMITED", retryable: false });
  });

  it("keeps RATE_LIMITED retryable and distinct from QUOTA_EXHAUSTED", () => {
    expect(
      classifyProviderFailure({ code: "RATE_LIMITED", deterministic: false }),
    ).toEqual({ category: "RATE_LIMITED", retryable: true });
    expect(
      classifyProviderFailure({ code: "QUOTA_EXHAUSTED", deterministic: true }),
    ).toEqual({ category: "QUOTA_EXHAUSTED", retryable: false });
  });

  it("defaults unknown codes to retryable when not deterministic", () => {
    expect(
      classifyProviderFailure({ code: "SOME_NEW_CODE", deterministic: false }),
    ).toEqual({ category: "SOME_NEW_CODE", retryable: true });
  });
});

describe("clampProviderRetries", () => {
  it("clamps to the 0-5 range and defaults to 2", () => {
    expect(clampProviderRetries(0)).toBe(0);
    expect(clampProviderRetries(5)).toBe(5);
    expect(clampProviderRetries(7)).toBe(5);
    expect(clampProviderRetries(-1)).toBe(0);
    expect(clampProviderRetries(2.7)).toBe(2);
    expect(clampProviderRetries(null)).toBe(2);
    expect(clampProviderRetries(undefined)).toBe(2);
    expect(clampProviderRetries(Number.NaN)).toBe(2);
  });
});

describe("retryBackoffMs", () => {
  it("grows linearly and caps at 4 seconds", () => {
    expect(retryBackoffMs(1)).toBe(500);
    expect(retryBackoffMs(2)).toBe(1_000);
    expect(retryBackoffMs(8)).toBe(4_000);
  });
});

describe("boundedRetryAfterMs", () => {
  it("parses seconds and caps at the safe maximum", () => {
    expect(boundedRetryAfterMs("2")).toBe(2_000);
    expect(boundedRetryAfterMs("0")).toBe(0);
    expect(boundedRetryAfterMs("120")).toBe(10_000);
    expect(boundedRetryAfterMs(null)).toBeNull();
    expect(boundedRetryAfterMs("garbage")).toBeNull();
  });

  it("parses HTTP-dates relative to now", () => {
    const future = new Date(Date.now() + 3_000).toUTCString();
    const parsed = boundedRetryAfterMs(future);
    expect(parsed).not.toBeNull();
    expect(parsed ?? 0).toBeGreaterThan(2_000);
    expect(parsed ?? 0).toBeLessThanOrEqual(10_000);
  });
});

describe("waitWithCancellation", () => {
  it("resolves after the wait", async () => {
    const startedAt = Date.now();
    await waitWithCancellation(30);
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(20);
  });

  it("resolves immediately for zero waits", async () => {
    await waitWithCancellation(0);
  });

  it("rejects when the abort signal fires during the wait", async () => {
    const controller = new AbortController();
    const waitPromise = waitWithCancellation(5_000, controller.signal);
    controller.abort();
    await expect(waitPromise).rejects.toHaveProperty("name", "AbortError");
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(
      waitWithCancellation(5_000, controller.signal),
    ).rejects.toHaveProperty("name", "AbortError");
  });
});