import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  estimateCreditCost,
  assertBalanceSufficient,
  reserveSeRankingCredits,
  resetCreditGuardState,
  DEFAULT_REQUEST_CREDIT_CAP,
  DEFAULT_MONTHLY_CREDIT_CAP,
} from "./credits";
import { SeRankingCreditExhaustedError } from "./errors";
import type { SeRankingClient } from "./client";

describe("Credit Budget Protection — Priority 3", () => {
  const mockClient = {
    getSubscription: vi.fn(),
  } as unknown as SeRankingClient;

  beforeEach(() => {
    vi.clearAllMocks();
    resetCreditGuardState();
  });

  describe("estimateCreditCost", () => {
    it("exports sensible default caps", () => {
      expect(DEFAULT_REQUEST_CREDIT_CAP).toBe(2000);
      expect(DEFAULT_MONTHLY_CREDIT_CAP).toBe(80000);
    });

    it("estimates credit cost accurately across operations", () => {
      expect(estimateCreditCost("account_subscription")).toBe(0);
      expect(estimateCreditCost("keyword_metrics", 5)).toBe(5);
      expect(estimateCreditCost("keyword_ideas", 10)).toBe(100);
      expect(estimateCreditCost("domain_overview")).toBe(100);
      expect(estimateCreditCost("domain_competitors")).toBe(100);
      expect(estimateCreditCost("backlinks_summary")).toBe(100);
      expect(estimateCreditCost("backlinks_history", 30)).toBe(40);
    });
  });

  describe("assertBalanceSufficient", () => {
    it("throws when subscription is expired or disabled", () => {
      expect(() =>
        assertBalanceSufficient(
          { status: "expired", units_left: 5000, units_limit: 10000 },
          100,
        ),
      ).toThrow(SeRankingCreditExhaustedError);

      expect(() =>
        assertBalanceSufficient(
          { status: "disabled", units_left: 5000, units_limit: 10000 },
          100,
        ),
      ).toThrow(SeRankingCreditExhaustedError);
    });

    it("throws when units_left is less than estimated cost", () => {
      expect(() =>
        assertBalanceSufficient(
          { status: "active", units_left: 50, units_limit: 10000 },
          100,
        ),
      ).toThrow(/insufficient/i);
    });

    it("passes when units_left is sufficient", () => {
      expect(() =>
        assertBalanceSufficient(
          { status: "active", units_left: 500, units_limit: 10000 },
          100,
        ),
      ).not.toThrow();
    });
  });

  describe("reserveSeRankingCredits", () => {
    it("rejects when estimated cost exceeds per-request cap", async () => {
      // 300 keyword ideas * 10 credits = 3000 credits > default cap of 2000
      await expect(
        reserveSeRankingCredits({
          organizationId: "org-1",
          operation: "keyword_ideas",
          count: 300,
          client: mockClient,
        }),
      ).rejects.toThrow(/per-request cap/i);
    });

    it("enforces per-organization monthly budget limit", async () => {
      vi.mocked(mockClient.getSubscription).mockResolvedValue({
        status: "active",
        units_left: 500000,
        units_limit: 1000000,
      });

      // Simulate reservations reaching the monthly cap (e.g. custom cap 500)
      const res1 = await reserveSeRankingCredits({
        organizationId: "budget-org",
        operation: "domain_overview", // 100 credits
        customMonthlyCap: 150,
        client: mockClient,
      });
      await res1.commit();

      // Next reservation for 100 credits would exceed 150 monthly limit
      await expect(
        reserveSeRankingCredits({
          organizationId: "budget-org",
          operation: "domain_overview", // 100 credits
          customMonthlyCap: 150,
          client: mockClient,
        }),
      ).rejects.toThrow(/monthly credit limit reached/i);
    });

    it("reconciles reservation upon release if an operation fails", async () => {
      vi.mocked(mockClient.getSubscription).mockResolvedValue({
        status: "active",
        units_left: 500000,
        units_limit: 1000000,
      });

      const res = await reserveSeRankingCredits({
        organizationId: "rollback-org",
        operation: "domain_overview", // 100 credits
        customMonthlyCap: 150,
        client: mockClient,
      });

      // Release without committing
      await res.release();

      // Now another reservation can succeed because prior spend was rolled back
      const res2 = await reserveSeRankingCredits({
        organizationId: "rollback-org",
        operation: "domain_overview",
        customMonthlyCap: 150,
        client: mockClient,
      });
      await res2.commit();
    });

    it("forces subscription balance refresh when cached balance is low", async () => {
      // First call for cheap operation (5 units) caches a low balance of 10 units
      vi.mocked(mockClient.getSubscription)
        .mockResolvedValueOnce({
          status: "active",
          units_left: 10,
          units_limit: 1000,
        })
        .mockResolvedValueOnce({
          // Refreshed call after user topped up
          status: "active",
          units_left: 2000,
          units_limit: 10000,
        });

      // Cheap operation succeeds with 10 units and caches the balance
      const res1 = await reserveSeRankingCredits({
        organizationId: "refresh-org",
        operation: "keyword_metrics", // 5 units
        count: 5,
        client: mockClient,
      });
      await res1.commit();
      expect(mockClient.getSubscription).toHaveBeenCalledTimes(1);

      // Subsequent 100-unit operation sees cached 10 is low, forces a refresh, and gets 2000 units
      const res2 = await reserveSeRankingCredits({
        organizationId: "refresh-org",
        operation: "domain_overview", // 100 units
        client: mockClient,
      });

      expect(res2.estimatedUnits).toBe(100);
      expect(mockClient.getSubscription).toHaveBeenCalledTimes(2);
      await res2.commit();
    });
  });
});
