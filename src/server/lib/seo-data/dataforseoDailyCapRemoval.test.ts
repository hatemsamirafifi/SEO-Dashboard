import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  env: new Map<string, string>(),
}));

vi.mock("@/server/lib/runtime-env", () => ({
  getOptionalEnvValue: vi.fn(async (name: string) => mocks.env.get(name)),
}));

import {
  assertDataforseoBudgetAvailable,
  getCostCounters,
  recordDataforseoCall,
  resetBudgetConfigCache,
  resetCostCounters,
} from "./cost-tracker";
import { BudgetExceededError } from "./errors";
import { classifyProviderFailure } from "@/server/features/serp/retryPolicy";
import {
  openProviderCircuit,
  closeProviderCircuit,
  getProviderCircuitView,
} from "@/server/features/serp/circuitBreaker";

describe("DataForSEO Daily Cap Removal & Safety Controls Regression Suite", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-12T12:00:00.000Z"));
    mocks.env.clear();
    resetBudgetConfigCache();
    resetCostCounters();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("1. DataForSEO daily usage above $1 does not block requests", async () => {
    // Simulate previous runs having spent $1.50 today
    recordDataforseoCall(1.5);
    expect(getCostCounters().estimatedDataforseoCostUsd).toBe(1.5);

    // assertDataforseoBudgetAvailable must resolve cleanly without throwing
    await expect(assertDataforseoBudgetAvailable()).resolves.toBeUndefined();

    // Even with $10.00 or $50.00 in daily spend, requests must NOT be blocked
    recordDataforseoCall(8.5);
    await expect(assertDataforseoBudgetAvailable()).resolves.toBeUndefined();
  });

  it("2. No daily budget configuration does not impose a hidden default", async () => {
    // Explicitly verify that without any env vars, no implicit $1 limit is applied
    resetBudgetConfigCache();
    recordDataforseoCall(2.0);

    await expect(assertDataforseoBudgetAvailable()).resolves.toBeUndefined();
  });

  it("3. Ignores DATAFORSEO_DAILY_BUDGET even if set in environment", async () => {
    // If an environment variable is present from old config, it must be ignored
    mocks.env.set("DATAFORSEO_DAILY_BUDGET", "1");
    resetBudgetConfigCache();
    recordDataforseoCall(1.05);

    await expect(assertDataforseoBudgetAvailable()).resolves.toBeUndefined();
  });

  it("4. Provider insufficient balance still blocks requests correctly", () => {
    // Permanent quota/credits failure classification must be non-retryable
    const quotaFailure = classifyProviderFailure({
      code: "QUOTA_EXHAUSTED",
      deterministic: true,
    });
    expect(quotaFailure.retryable).toBe(false);
    expect(quotaFailure.category).toBe("QUOTA_EXHAUSTED");

    const creditsFailure = classifyProviderFailure({
      code: "CREDITS_UNAVAILABLE",
      deterministic: true,
    });
    expect(creditsFailure.retryable).toBe(false);
    expect(creditsFailure.category).toBe("CREDITS_UNAVAILABLE");
  });

  it("5. Explicit per-run budget restrictions still apply (e.g. monthly budget guard)", async () => {
    // Monthly budget guard remains functional when explicitly configured
    mocks.env.set("DATAFORSEO_MONTHLY_BUDGET", "5.0");
    resetBudgetConfigCache();
    recordDataforseoCall(5.0);

    await expect(assertDataforseoBudgetAvailable()).rejects.toMatchObject({
      name: BudgetExceededError.name,
      period: "monthly",
      limit: 5.0,
      spent: 5.0,
    });
  });

  it("6. Existing cost tracking is preserved", () => {
    recordDataforseoCall(0.002);
    recordDataforseoCall(0.004);

    const counters = getCostCounters();
    expect(counters.dataforseoCalls).toBe(2);
    expect(counters.estimatedDataforseoCostUsd).toBeCloseTo(0.006, 6);
  });

  it("7. Permanent provider errors (auth failure, paused access) do not trigger retries", () => {
    const authFailure = classifyProviderFailure({
      code: "AUTH_FAILED",
      deterministic: true,
    });
    expect(authFailure.retryable).toBe(false);
    expect(authFailure.category).toBe("AUTH_FAILED");

    const pausedFailure = classifyProviderFailure({
      code: "DATAFORSEO_ACCOUNT_PAUSED",
      deterministic: true,
    });
    expect(pausedFailure.retryable).toBe(false);
    expect(pausedFailure.category).toBe("DATAFORSEO_ACCOUNT_PAUSED");
  });

  it("8. Circuit breaker behavior remains correct when bypassed or open", () => {
    const identity = {
      provider: "dataforseo",
      organizationId: "org-test",
      projectId: null,
      credentialFingerprint: "fp-1",
    };

    closeProviderCircuit(identity);
    expect(getProviderCircuitView(identity).state).toBe("closed");

    openProviderCircuit(identity, "Provider errors exceeded threshold");
    const view = getProviderCircuitView(identity);
    expect(view.state).toBe("open");
    expect(view.reason).toContain("threshold");

    closeProviderCircuit(identity);
    expect(getProviderCircuitView(identity).state).toBe("closed");
  });
});
