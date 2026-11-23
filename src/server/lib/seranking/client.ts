import { classifySeRankingHttpError, SeRankingError } from "./errors";
import {
  getApiKeyFingerprint,
  getRateLimiterCoordinator,
  type RateLimiterCoordinator,
} from "./rateLimiter";
import { seRankingSubscriptionSchema } from "./schemas";
import type { SeRankingConfig, SeRankingSubscription } from "./types";

export type RequestOptions = {
  method?: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  params?: Record<string, string | number | boolean | undefined | null>;
  body?: unknown;
  signal?: AbortSignal;
  timeoutMs?: number;
  /**
   * Disables the generic 429/5xx retry loop for non-idempotent writes whose
   * commit state is ambiguous after a failure (e.g. keyword POSTs). Callers
   * must reconcile fresh provider state instead of replaying the request.
   */
  noRetry?: boolean;
};

// Global or per-instance single-flight in-memory deduplication for concurrent identical requests
const inFlightRequests = new Map<string, Promise<unknown>>();

export class SeRankingClient {
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly rps: number;
  private readonly rateLimiter: RateLimiterCoordinator;
  private apiKeyFingerprintPromise: Promise<string> | null = null;

  constructor(config: SeRankingConfig) {
    if (!config.apiKey || config.apiKey.trim().length === 0) {
      throw new SeRankingError("SE Ranking API key is required");
    }
    this.apiKey = config.apiKey.trim();
    const rawBaseUrl = config.baseUrl?.trim() || "https://api.seranking.com";
    this.baseUrl = rawBaseUrl.replace(/\/+$/, "");
    this.timeoutMs = config.timeoutMs ?? 30000;
    this.maxRetries = config.maxRetries ?? 2;
    this.rps = config.rps && config.rps > 0 ? config.rps : 1;
    this.rateLimiter = config.rateLimiter ?? getRateLimiterCoordinator();
  }

  private getFingerprint(): Promise<string> {
    if (!this.apiKeyFingerprintPromise) {
      this.apiKeyFingerprintPromise = getApiKeyFingerprint(this.apiKey);
    }
    return this.apiKeyFingerprintPromise;
  }

  private buildUrl(
    path: string,
    params?: Record<string, string | number | boolean | undefined | null>,
  ): string {
    const cleanPath = path.startsWith("/") ? path : `/${path}`;
    // If path does not start with /v1, prefix it (official SE Ranking endpoints are /v1/...)
    const fullPath = cleanPath.startsWith("/v1")
      ? cleanPath
      : `/v1${cleanPath}`;
    const url = new URL(`${this.baseUrl}${fullPath}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined && value !== null) {
          url.searchParams.set(key, String(value));
        }
      }
    }
    return url.toString();
  }

  async request<T>(path: string, options: RequestOptions = {}): Promise<T> {
    if (import.meta.env.MODE === "e2e") {
      throw new SeRankingError(
        "SE Ranking transport is disabled in browser tests.",
        503,
      );
    }
    const method = options.method ?? "GET";
    const url = this.buildUrl(path, options.params);
    const bodyStr = options.body ? JSON.stringify(options.body) : undefined;

    // Deduplication key for concurrent identical in-flight reads. The
    // credential fingerprint isolates accounts: without it, two clients with
    // different API keys issuing the same GET could share each other's
    // responses, leaking data across tenant accounts.
    const credentialFingerprint = await this.getFingerprint();
    const flightKey = `${credentialFingerprint}:${method}:${url}:${bodyStr ?? ""}`;
    if (method === "GET" && inFlightRequests.has(flightKey)) {
      // oxlint-disable-next-line typescript/no-unsafe-type-assertion
      return inFlightRequests.get(flightKey) as Promise<T>;
    }

    const executionPromise = (async () => {
      let attempt = 0;
      let lastError: unknown;

      while (attempt <= this.maxRetries) {
        attempt++;
        const fp = await this.getFingerprint();
        await this.rateLimiter.acquire(fp, {
          rps: this.rps,
          timeoutMs: options.timeoutMs ?? this.timeoutMs,
          signal: options.signal,
        });

        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          options.timeoutMs ?? this.timeoutMs,
        );
        if (options.signal) {
          options.signal.addEventListener("abort", () => controller.abort(), {
            once: true,
          });
        }

        try {
          const headers: Record<string, string> = {
            Authorization: `Token ${this.apiKey}`,
            Accept: "application/json",
          };
          if (bodyStr) {
            headers["Content-Type"] = "application/json";
          }

          const response = await fetch(url, {
            method,
            headers,
            body: bodyStr,
            signal: controller.signal,
          });

          clearTimeout(timeoutId);

          let parsedBody: unknown;
          const contentType = response.headers.get("content-type") ?? "";
          if (contentType.includes("application/json")) {
            parsedBody = await response.json().catch(() => null);
          } else {
            parsedBody = await response.text().catch(() => null);
          }

          if (!response.ok) {
            const classified = classifySeRankingHttpError(
              response.status,
              parsedBody,
            );
            // Retry on 429 or 5xx if attempts remain. Non-idempotent writes
            // opted into noRetry surface immediately so the caller can
            // reconcile fresh state instead of replaying a possibly
            // committed request.
            if (
              !options.noRetry &&
              (response.status === 429 || response.status >= 500) &&
              attempt <= this.maxRetries
            ) {
              const backoff = Math.min(
                1000 * Math.pow(2, attempt - 1) + Math.random() * 200,
                5000,
              );
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
            throw classified;
          }

          // oxlint-disable-next-line typescript/no-unsafe-type-assertion
          return parsedBody as T;
        } catch (error) {
          clearTimeout(timeoutId);
          lastError = error;

          if (controller.signal.aborted && !options.signal?.aborted) {
            lastError = new SeRankingError(
              `SE Ranking request timed out after ${options.timeoutMs ?? this.timeoutMs}ms`,
              504,
            );
          }

          if (
            !options.noRetry &&
            lastError instanceof SeRankingError &&
            (lastError.statusCode === 429 ||
              (lastError.statusCode && lastError.statusCode >= 500))
          ) {
            if (attempt <= this.maxRetries) {
              const backoff = Math.min(
                1000 * Math.pow(2, attempt - 1) + Math.random() * 200,
                5000,
              );
              await new Promise((r) => setTimeout(r, backoff));
              continue;
            }
          }
          throw lastError;
        }
      }

      throw lastError;
    })();

    if (method === "GET") {
      inFlightRequests.set(flightKey, executionPromise);
      executionPromise
        .catch(() => {})
        .finally(() => {
          inFlightRequests.delete(flightKey);
        });
    }

    return executionPromise;
  }

  async getSubscription(): Promise<SeRankingSubscription> {
    const raw = await this.request<unknown>("/account/subscription", {
      method: "GET",
    });
    return seRankingSubscriptionSchema.parse(raw);
  }
}
