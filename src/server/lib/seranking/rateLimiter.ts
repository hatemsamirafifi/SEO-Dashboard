import { SeRankingError } from "./errors";

export type RateLimiterOptions = {
  rps?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
};

export interface RateLimiterCoordinator {
  acquire(keyFingerprint: string, options?: RateLimiterOptions): Promise<void>;
  getQueueLength?(keyFingerprint: string): number;
  reset?(keyFingerprint?: string): void;
}

export async function getApiKeyFingerprint(apiKey: string): Promise<string> {
  const payload = new TextEncoder().encode(apiKey.trim());
  const digest = await crypto.subtle.digest("SHA-256", payload);
  return Array.from(new Uint8Array(digest))
    .slice(0, 16)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

type KeyLimiterState = {
  nextAllowedTime: number;
  queueLength: number;
};

export class InMemoryRateLimiterCoordinator implements RateLimiterCoordinator {
  private readonly state = new Map<string, KeyLimiterState>();
  private readonly maxQueue: number;

  constructor(maxQueue = 50) {
    this.maxQueue = maxQueue;
  }

  getQueueLength(keyFingerprint: string): number {
    return this.state.get(keyFingerprint)?.queueLength ?? 0;
  }

  reset(keyFingerprint?: string): void {
    if (keyFingerprint) {
      this.state.delete(keyFingerprint);
    } else {
      this.state.clear();
    }
  }

  async acquire(
    keyFingerprint: string,
    options?: RateLimiterOptions,
  ): Promise<void> {
    if (options?.signal?.aborted) {
      throw new SeRankingError(
        "Request aborted before acquiring rate limit slot",
        499,
      );
    }

    let record = this.state.get(keyFingerprint);
    if (!record) {
      record = { nextAllowedTime: 0, queueLength: 0 };
      this.state.set(keyFingerprint, record);
    }

    const now = Date.now();
    // If previous slot is already in the past, reset nextAllowedTime to now
    const baseTime = Math.max(now, record.nextAllowedTime);

    // If wait time is > 0, it means this call will have to wait in the queue
    const isQueued = baseTime > now;
    if (isQueued && record.queueLength >= this.maxQueue) {
      throw new SeRankingError(
        `Rate limit queue capacity reached (max ${this.maxQueue} concurrent requests). Try again later.`,
        429,
      );
    }

    const rps = options?.rps && options.rps > 0 ? options.rps : 1;
    const minIntervalMs = Math.round(1000 / rps);
    const timeoutMs = options?.timeoutMs ?? 30000;

    const scheduledTime = baseTime;
    const delay = scheduledTime - now;

    if (delay > timeoutMs) {
      throw new SeRankingError(
        `SE Ranking request timed out in rate limit queue: wait time (${delay}ms) exceeds timeout (${timeoutMs}ms)`,
        504,
      );
    }

    // Reserve slot
    record.nextAllowedTime = scheduledTime + minIntervalMs;

    if (delay <= 0) {
      return;
    }

    record.queueLength++;

    return new Promise<void>((resolve, reject) => {
      let settled = false;

      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        if (record) record.queueLength = Math.max(0, record.queueLength - 1);
        resolve();
      }, delay);

      if (options?.signal) {
        options.signal.addEventListener(
          "abort",
          () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (record)
              record.queueLength = Math.max(0, record.queueLength - 1);
            reject(
              new SeRankingError(
                "Request aborted while waiting in rate limit queue",
                499,
              ),
            );
          },
          { once: true },
        );
      }
    });
  }
}

// Global process-wide coordinator instance for in-memory fallback
export const globalInMemoryRateLimiter = new InMemoryRateLimiterCoordinator(50);

/**
 * Cloudflare Durable Object implementation for distributed global rate limiting
 * across multiple Workers and isolates worldwide.
 */
export class SeRankingRateLimiter {
  private nextAllowedTime = 0;
  private queueCount = 0;
  private readonly maxQueue = 50;

  constructor(
    protected ctx?: unknown,
    protected env?: unknown,
  ) {}

  async acquire(options?: {
    rps?: number;
    timeoutMs?: number;
  }): Promise<{ success: boolean; waitMs: number }> {
    const rps = options?.rps && options.rps > 0 ? options.rps : 1;
    const minIntervalMs = Math.round(1000 / rps);
    const timeoutMs = options?.timeoutMs ?? 30000;

    const now = Date.now();
    const scheduledTime = Math.max(now, this.nextAllowedTime);
    const delay = scheduledTime - now;

    if (delay > 0 && this.queueCount >= this.maxQueue) {
      throw new SeRankingError(
        `Rate limit queue capacity reached (max ${this.maxQueue} concurrent requests). Try again later.`,
        429,
      );
    }

    if (delay > timeoutMs) {
      throw new SeRankingError(
        `SE Ranking request timed out in rate limit queue: wait time (${delay}ms) exceeds timeout (${timeoutMs}ms)`,
        504,
      );
    }

    this.nextAllowedTime = scheduledTime + minIntervalMs;

    if (delay > 0) {
      this.queueCount++;
      try {
        await new Promise((resolve) => setTimeout(resolve, delay));
      } finally {
        this.queueCount = Math.max(0, this.queueCount - 1);
      }
    }

    return { success: true, waitMs: delay };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.method === "POST") {
      try {
        const body = (await request.json().catch(() => ({}))) as {
          rps?: number;
          timeoutMs?: number;
        };
        const result = await this.acquire(body);
        return Response.json(result);
      } catch (err: unknown) {
        if (err instanceof SeRankingError) {
          return Response.json(
            { error: err.message, statusCode: err.statusCode },
            { status: err.statusCode ?? 500 },
          );
        }
        return Response.json({ error: String(err) }, { status: 500 });
      }
    }
    return Response.json({
      queueCount: this.queueCount,
      nextAllowedTime: this.nextAllowedTime,
    });
  }
}

export class CloudflareDoRateLimiterCoordinator implements RateLimiterCoordinator {
  // oxlint-disable-next-line typescript/no-explicit-any
  constructor(private readonly namespace: any) {}

  async acquire(
    keyFingerprint: string,
    options?: RateLimiterOptions,
  ): Promise<void> {
    const id = this.namespace.idFromName(keyFingerprint);
    const stub = this.namespace.get(id);

    // Prefer RPC method if supported directly on stub
    if (typeof stub.acquire === "function") {
      await stub.acquire({
        rps: options?.rps,
        timeoutMs: options?.timeoutMs,
      });
      return;
    }

    // Fallback to DO fetch
    const response = await stub.fetch("https://rate-limiter/acquire", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        rps: options?.rps,
        timeoutMs: options?.timeoutMs,
      }),
      signal: options?.signal,
    });

    if (!response.ok) {
      const data = (await response.json().catch(() => ({}))) as {
        error?: string;
        statusCode?: number;
      };
      throw new SeRankingError(
        data.error ?? "Rate limiter rejected request",
        data.statusCode ?? response.status,
      );
    }
  }
}

/**
 * Returns the effective rate limiter coordinator for the current execution runtime:
 * - Uses Cloudflare Durable Object if env.SE_RANKING_RATE_LIMITER is bound.
 * - Otherwise falls back to global in-memory queue coordinator.
 */
export function getRateLimiterCoordinator(
  customEnv?: unknown,
): RateLimiterCoordinator {
  try {
    // Check if customEnv has SE_RANKING_RATE_LIMITER
    const envObj =
      typeof customEnv === "object" && customEnv !== null
        ? (customEnv as { SE_RANKING_RATE_LIMITER?: unknown })
        : undefined;
    if (envObj?.SE_RANKING_RATE_LIMITER) {
      return new CloudflareDoRateLimiterCoordinator(
        envObj.SE_RANKING_RATE_LIMITER,
      );
    }
    // Check global cloudflare:workers env if running inside Worker runtime
    if (typeof globalThis !== "undefined") {
      // oxlint-disable-next-line typescript/no-explicit-any
      const cfEnv = (globalThis as any).__env__ || (globalThis as any).env;
      if (cfEnv?.SE_RANKING_RATE_LIMITER) {
        return new CloudflareDoRateLimiterCoordinator(
          cfEnv.SE_RANKING_RATE_LIMITER,
        );
      }
    }
  } catch {
    // Non-Cloudflare environment
  }
  return globalInMemoryRateLimiter;
}
