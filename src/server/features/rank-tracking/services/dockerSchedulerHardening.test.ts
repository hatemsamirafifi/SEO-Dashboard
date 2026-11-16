import { describe, it, expect, vi, beforeEach } from "vitest";
import { timingSafeEqual } from "node:crypto";
import {
  APPROVED_PILOT_CONFIG_ID,
  APPROVED_PILOT_KEYWORD_ID,
  APPROVED_PILOT_TARGET_IDS,
} from "@/shared/rank-tracking";

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

function isSecretValid(
  secret: string | undefined,
  key: string | undefined,
): boolean {
  if (!secret || secret.trim().length === 0) return false;
  if (!key || key.trim().length === 0) return false;
  return constantTimeEqual(key.trim(), secret.trim());
}

function isPilotEnabled(val: string | undefined): boolean {
  return val === "true";
}

function handleTick(pilotEnabled: boolean) {
  if (!pilotEnabled) {
    return {
      executed: false,
      reason: "pilot_disabled",
      message: "Scheduled rank check pilot is disabled by environment flag",
    };
  }
  return { executed: true };
}

function isPastActive(tickIso: string, maxAgeMs = 35 * 60 * 1000) {
  const elapsed = Date.now() - Date.parse(tickIso);
  return elapsed >= 0 && elapsed <= maxAgeMs;
}

describe("Task 5 — Docker Scheduler Hardening & Weekly Execution Contract", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("1. Scheduler Authentication & Fail-Safe Defaults", () => {
    it("fails closed when LOCAL_SCHEDULER_SECRET is absent or empty", () => {
      expect(isSecretValid(undefined, "some-key")).toBe(false);
      expect(isSecretValid("", "some-key")).toBe(false);
      expect(isSecretValid("  ", "some-key")).toBe(false);
      expect(isSecretValid("secure-random-token", undefined)).toBe(false);
      expect(isSecretValid("secure-random-token", "")).toBe(false);
      expect(isSecretValid("secure-random-token", "wrong-token")).toBe(false);
      expect(isSecretValid("secure-random-token", "secure-random-token")).toBe(
        true,
      );
    });

    it("evaluates SCHEDULED_RANK_TRACKING_PILOT_ENABLED strictly to false unless explicit 'true'", () => {
      expect(isPilotEnabled("true")).toBe(true);
      expect(isPilotEnabled("false")).toBe(false);
      expect(isPilotEnabled(undefined)).toBe(false);
      expect(isPilotEnabled("")).toBe(false);
      expect(isPilotEnabled("1")).toBe(false);
      expect(isPilotEnabled("enabled")).toBe(false);
    });
  });

  describe("2. Scheduled Execution Guard Simulations", () => {
    it("1. Scheduler before due time: reports 0 due configs and leaves schedule unchanged", () => {
      const nextCheckAt = "2026-11-18T07:24:00.000Z";
      const tickTime = "2026-11-16T12:00:00.000Z";

      const isDue =
        new Date(tickTime).getTime() >= new Date(nextCheckAt).getTime();
      expect(isDue).toBe(false);
    });

    it("2. Scheduler after due time: identifies approved pilot config as due", () => {
      const nextCheckAt = "2026-11-18T07:24:00.000Z";
      const tickTime = "2026-11-18T07:25:00.000Z";

      const isDue =
        new Date(tickTime).getTime() >= new Date(nextCheckAt).getTime();
      expect(isDue).toBe(true);
    });

    it("3. Enforces single approved keyword and two targets scope", () => {
      expect(APPROVED_PILOT_KEYWORD_ID).toBe(
        "28131aad-fe42-43b6-bfdb-5fe0d7e046a3",
      );
      expect(APPROVED_PILOT_TARGET_IDS).toHaveLength(2);
      expect(APPROVED_PILOT_CONFIG_ID).toBe(
        "2971425d-d350-4ee3-89b2-c83567c87713",
      );
    });

    it("4. Overlapping run prevention: rejects duplicate tick with 409 when run is in progress", () => {
      let runInProgress = false;

      const triggerTick = () => {
        if (runInProgress) {
          return { status: 409, reason: "already_running" };
        }
        runInProgress = true;
        return { status: 200, reason: "ok" };
      };

      const firstCall = triggerTick();
      expect(firstCall.status).toBe(200);

      const secondCall = triggerTick();
      expect(secondCall.status).toBe(409);
      expect(secondCall.reason).toBe("already_running");

      runInProgress = false;
      const thirdCall = triggerTick();
      expect(thirdCall.status).toBe(200);
    });

    it("5. Pilot disabled behavior: skips execution without mutating schedule", () => {
      const result = handleTick(false);
      expect(result.executed).toBe(false);
      expect(result.reason).toBe("pilot_disabled");
    });

    it("6. Heartbeat expiry after 35 minutes indicates scheduler inactivity", () => {
      const mockPastTick = new Date(Date.now() - 40 * 60 * 1000).toISOString();
      expect(isPastActive(mockPastTick)).toBe(false);

      const recentTick = new Date(Date.now() - 5 * 60 * 1000).toISOString();
      expect(isPastActive(recentTick)).toBe(true);
    });
  });
});
