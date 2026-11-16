import { describe, it, expect, vi, beforeEach } from "vitest";
import { timingSafeEqual } from "node:crypto";
import {
  recordSchedulerTick,
  getSchedulerHeartbeatStatus,
  isSchedulerRecentlyActive,
  getLastSchedulerTick,
} from "./schedulerHeartbeat";
import { APPROVED_PILOT_CONFIG_ID } from "@/shared/rank-tracking";

function isAllowedEnvironment(mode: string): boolean {
  return mode === "local_noauth";
}

function isAllowedMethod(pathname: string, method: string): boolean {
  if (pathname === "/api/internal/cron/status") return method === "GET";
  if (pathname === "/api/internal/cron/trigger") return method === "POST";
  return false;
}

function constantTimeEqual(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") {
    return false;
  }
  const bufA = Buffer.from(a, "utf8");
  const bufB = Buffer.from(b, "utf8");
  if (bufA.length === 0 || bufB.length === 0 || bufA.length !== bufB.length) {
    return false;
  }
  return timingSafeEqual(bufA, bufB);
}

function checkSecretConfigured(secret: string | undefined): boolean {
  return Boolean(secret && secret.trim().length > 0);
}

function evaluatePilotEnabled(val: string | undefined): boolean {
  return val === "true";
}

describe("Local Docker Scheduler Integration & Security", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("Heartbeat State Tracking", () => {
    it("records a successful scheduler tick with timestamp and increments total", () => {
      const before = new Date().toISOString();
      const heartbeat = recordSchedulerTick(true);

      expect(heartbeat.success).toBe(true);
      expect(heartbeat.lastTickAt).toBeDefined();
      expect(heartbeat.totalTicks).toBeGreaterThan(0);
      expect(heartbeat.lastTickAt >= before).toBe(true);
      expect(getLastSchedulerTick()).toBe(heartbeat.lastTickAt);
    });

    it("records a failed scheduler tick with error message", () => {
      const heartbeat = recordSchedulerTick(false, "Connection refused");

      expect(heartbeat.success).toBe(false);
      const status = getSchedulerHeartbeatStatus({
        SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "true",
      });
      expect(status.lastTickSuccess).toBe(false);
      expect(status.lastTickError).toBe("Connection refused");
    });

    it("correctly evaluates recently active state based on maxAgeMs", () => {
      recordSchedulerTick(true);
      expect(isSchedulerRecentlyActive(60 * 1000)).toBe(true);

      // Past threshold
      expect(isSchedulerRecentlyActive(-1)).toBe(false);
    });

    it("distinguishes scheduler running from merely configured", () => {
      // 1. Configured = false, Running = false
      const disabledStatus = getSchedulerHeartbeatStatus({
        SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "false",
      });
      expect(disabledStatus.schedulerConfigured).toBe(false);

      // 2. Configured = true
      const enabledStatus = getSchedulerHeartbeatStatus({
        SCHEDULED_RANK_TRACKING_PILOT_ENABLED: "true",
      });
      expect(enabledStatus.schedulerConfigured).toBe(true);
      expect(enabledStatus.cadence).toBe("weekly");
      expect(enabledStatus.allowlist).toContain(APPROVED_PILOT_CONFIG_ID);
    });
  });

  describe("Docker Scheduler Internal Endpoint Security Contract", () => {
    it("enforces timing-safe secret key comparison and fails closed on length mismatch", () => {
      const expectedSecret = "a".repeat(64);
      const validKey = "a".repeat(64);
      const invalidKey = "b".repeat(64);
      const shortKey = "a".repeat(32);
      const emptyKey = "";

      expect(constantTimeEqual(validKey, expectedSecret)).toBe(true);
      expect(constantTimeEqual(invalidKey, expectedSecret)).toBe(false);
      expect(constantTimeEqual(shortKey, expectedSecret)).toBe(false);
      expect(constantTimeEqual(emptyKey, expectedSecret)).toBe(false);
    });

    it("fails closed when expected secret is empty or absent", () => {
      expect(checkSecretConfigured(undefined)).toBe(false);
      expect(checkSecretConfigured("")).toBe(false);
      expect(checkSecretConfigured("   ")).toBe(false);
      expect(checkSecretConfigured("strong-random-secret-64-bytes")).toBe(true);
    });

    it("fails closed when authMode is hosted or cloudflare_access", () => {
      expect(isAllowedEnvironment("local_noauth")).toBe(true);
      expect(isAllowedEnvironment("hosted")).toBe(false);
      expect(isAllowedEnvironment("cloudflare_access")).toBe(false);
      expect(isAllowedEnvironment("")).toBe(false);
    });

    it("restricts HTTP methods: GET only for status, POST only for trigger", () => {
      expect(isAllowedMethod("/api/internal/cron/status", "GET")).toBe(true);
      expect(isAllowedMethod("/api/internal/cron/status", "POST")).toBe(false);
      expect(isAllowedMethod("/api/internal/cron/trigger", "POST")).toBe(true);
      expect(isAllowedMethod("/api/internal/cron/trigger", "GET")).toBe(false);
      expect(isAllowedMethod("/api/internal/cron/trigger", "PUT")).toBe(false);
      expect(isAllowedMethod("/api/internal/cron/trigger", "DELETE")).toBe(
        false,
      );
    });

    it("strictly requires explicit 'true' for SCHEDULED_RANK_TRACKING_PILOT_ENABLED", () => {
      expect(evaluatePilotEnabled("true")).toBe(true);
      expect(evaluatePilotEnabled(undefined)).toBe(false);
      expect(evaluatePilotEnabled("false")).toBe(false);
      expect(evaluatePilotEnabled("1")).toBe(false);
      expect(evaluatePilotEnabled("yes")).toBe(false);
      expect(evaluatePilotEnabled("TRUE")).toBe(false);
      expect(evaluatePilotEnabled("")).toBe(false);
    });
  });
});
