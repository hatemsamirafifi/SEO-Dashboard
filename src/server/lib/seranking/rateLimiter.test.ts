/* eslint-disable */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InMemoryRateLimiterCoordinator,
  getApiKeyFingerprint,
  SeRankingRateLimiter,
} from "./rateLimiter";

describe("Rate Limiting — Priority 1: Distributed & Shared Rate Limiter", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("API Key Fingerprinting", () => {
    it("generates deterministic SHA-256 fingerprint without exposing raw key", async () => {
      const key1 = "secret-api-key-12345";
      const key2 = "secret-api-key-12345";
      const key3 = "secret-api-key-99999";

      const fp1 = await getApiKeyFingerprint(key1);
      const fp2 = await getApiKeyFingerprint(key2);
      const fp3 = await getApiKeyFingerprint(key3);

      expect(fp1).toBe(fp2);
      expect(fp1).not.toBe(fp3);
      expect(fp1).not.toContain("secret");
      expect(fp1.length).toBeGreaterThanOrEqual(16);
    });
  });

  describe("InMemoryRateLimiterCoordinator", () => {
    let limiter: InMemoryRateLimiterCoordinator;

    beforeEach(() => {
      limiter = new InMemoryRateLimiterCoordinator(50);
    });

    it("paces consecutive requests to 1 RPS (1000ms minimum interval)", async () => {
      const key = "key-a";
      const timestamps: number[] = [];

      const p1 = limiter.acquire(key, { rps: 1 }).then(() => timestamps.push(Date.now()));
      const p2 = limiter.acquire(key, { rps: 1 }).then(() => timestamps.push(Date.now()));
      const p3 = limiter.acquire(key, { rps: 1 }).then(() => timestamps.push(Date.now()));

      await vi.advanceTimersByTimeAsync(0);
      expect(timestamps).toEqual([0]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(timestamps).toEqual([0, 1000]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(timestamps).toEqual([0, 1000, 2000]);

      await Promise.all([p1, p2, p3]);
    });

    it("isolates different API keys so they do not block each other", async () => {
      const timestampsA: number[] = [];
      const timestampsB: number[] = [];

      const pA1 = limiter.acquire("org-1-key", { rps: 1 }).then(() => timestampsA.push(Date.now()));
      const pB1 = limiter.acquire("org-2-key", { rps: 1 }).then(() => timestampsB.push(Date.now()));

      await vi.advanceTimersByTimeAsync(0);
      // Both dispatch immediately on their first call
      expect(timestampsA).toEqual([0]);
      expect(timestampsB).toEqual([0]);

      await Promise.all([pA1, pB1]);
    });

    it("enforces bounded queue (max 50) and rejects excess with 429", async () => {
      const key = "heavy-key";
      const promises: Promise<void>[] = [];

      // First call runs immediately
      promises.push(limiter.acquire(key, { rps: 1, timeoutMs: 120000 }));

      // Queue 50 subsequent calls with large timeout so queue capacity triggers
      for (let i = 0; i < 50; i++) {
        promises.push(limiter.acquire(key, { rps: 1, timeoutMs: 120000 }));
      }

      // 52nd call (queue already has 50 waiting) must reject with 429
      await expect(limiter.acquire(key, { rps: 1, timeoutMs: 120000 })).rejects.toThrow(
        /Rate limit queue capacity reached/i,
      );

      // Drain timers to cleanly complete the queued calls
      await vi.advanceTimersByTimeAsync(120000);
      await Promise.allSettled(promises);
    });

    it("supports AbortSignal cancellation and frees queue slot", async () => {
      const key = "cancel-key";
      const controller = new AbortController();

      // First call dispatches immediately
      await limiter.acquire(key, { rps: 1 });

      // Second call queues
      const queuedPromise = limiter.acquire(key, { rps: 1, signal: controller.signal });
      expect(limiter.getQueueLength(key)).toBe(1);

      // Abort second call
      controller.abort();

      await expect(queuedPromise).rejects.toThrow(/aborted/i);
      expect(limiter.getQueueLength(key)).toBe(0);
    });

    it("rejects when estimated delay exceeds client timeoutMs with 504", async () => {
      const key = "timeout-key";

      // 1st call at t=0
      await limiter.acquire(key, { rps: 1 });

      // 2nd call at t=1000 (scheduled at 1000, timeout=5000)
      const p2 = limiter.acquire(key, { rps: 1, timeoutMs: 5000 });

      // 3rd call would be at t=2000, but client sets timeoutMs=1500
      await expect(
        limiter.acquire(key, { rps: 1, timeoutMs: 1500 }),
      ).rejects.toThrow(/exceeds timeout/i);

      await vi.advanceTimersByTimeAsync(5000);
      await p2;
    });
  });

  describe("Multi-worker simulation", () => {
    it("simulates multiple concurrent Worker instances sharing the same coordinator", async () => {
      const sharedLimiter = new InMemoryRateLimiterCoordinator(50);
      const sharedKey = "shared-global-key";

      // Simulate 4 independent Cloudflare Worker isolates dispatching requests simultaneously
      const workerResults: { workerId: number; timestamp: number }[] = [];

      const spawnWorkerCall = (workerId: number) => {
        return sharedLimiter.acquire(sharedKey, { rps: 1 }).then(() => {
          workerResults.push({ workerId, timestamp: Date.now() });
        });
      };

      const promises = [
        spawnWorkerCall(1),
        spawnWorkerCall(2),
        spawnWorkerCall(3),
        spawnWorkerCall(4),
      ];

      // t=0
      await vi.advanceTimersByTimeAsync(0);
      expect(workerResults).toHaveLength(1);
      expect(workerResults[0].workerId).toBe(1);

      // t=1000
      await vi.advanceTimersByTimeAsync(1000);
      expect(workerResults).toHaveLength(2);
      expect(workerResults[1].workerId).toBe(2);

      // t=2000
      await vi.advanceTimersByTimeAsync(1000);
      expect(workerResults).toHaveLength(3);

      // t=3000
      await vi.advanceTimersByTimeAsync(1000);
      expect(workerResults).toHaveLength(4);

      await Promise.all(promises);

      // Verify each dispatched with at least 1000ms delta
      for (let i = 1; i < workerResults.length; i++) {
        const delta = workerResults[i].timestamp - workerResults[i - 1].timestamp;
        expect(delta).toBeGreaterThanOrEqual(1000);
      }
    });
  });

  describe("SeRankingRateLimiter (Durable Object simulation)", () => {
    it("Durable Object acquire paces correctly and handles capacity", async () => {
      // Mock DO state & env
      const mockState = {} as any;
      const mockEnv = {} as any;
      const doLimiter = new SeRankingRateLimiter(mockState, mockEnv);

      const timestamps: number[] = [];
      const p1 = doLimiter.acquire({ rps: 1 }).then(() => timestamps.push(Date.now()));
      const p2 = doLimiter.acquire({ rps: 1 }).then(() => timestamps.push(Date.now()));

      await vi.advanceTimersByTimeAsync(0);
      expect(timestamps).toEqual([0]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(timestamps).toEqual([0, 1000]);

      await Promise.all([p1, p2]);
    });

    it("Durable Object fetch handler serves HTTP POST /acquire", async () => {
      const mockState = {} as any;
      const mockEnv = {} as any;
      const doLimiter = new SeRankingRateLimiter(mockState, mockEnv);

      const req = new Request("https://rate-limiter/acquire", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rps: 1 }),
      });

      const res = await doLimiter.fetch(req);
      expect(res.status).toBe(200);
      const json = (await res.json()) as any;
      expect(json.success).toBe(true);
    });
  });
});
