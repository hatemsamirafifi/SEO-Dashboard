import {
  closeProviderCircuit,
  getProviderCircuitState,
  openProviderCircuit,
  type ProviderCircuitIdentity,
} from "./circuitBreaker";
import {
  assertNotCancelled,
  SerpCancelledError,
  SerpProviderError,
  type NormalizedSerpResult,
  type SerpProvider,
  type SerpProviderCall,
  type SerpProviderSkipReason,
  type SerpSearchInput,
} from "./types";
import { providerEndpoint } from "./httpProviders";
import {
  classifyProviderFailure,
  clampProviderRetries,
  retryBackoffMs,
  waitWithCancellation,
} from "./retryPolicy";

export class SerpProvidersUnavailableError extends Error {
  public readonly providerDiagnostics: Array<{
    provider: string;
    reason: string;
  }>;

  constructor(public readonly calls: SerpProviderCall[]) {
    const latestByProvider = new Map<string, SerpProviderCall>();
    for (const call of calls) latestByProvider.set(call.provider, call);
    const diagnostics = [...latestByProvider.values()].map((call) => ({
      provider: providerLabel(call.provider),
      reason: call.skipReason ?? call.errorCode ?? call.status.toUpperCase(),
    }));
    const summary = calls.some((call) => call.dispatched)
      ? "SERP providers were attempted but none returned a usable result."
      : "No eligible SERP provider was available.";
    super(
      `SERP_PROVIDERS_UNAVAILABLE: ${summary} ${diagnostics
        .map((item) => `${item.provider}: ${item.reason}`)
        .join("; ")}`,
    );
    this.name = "SerpProvidersUnavailableError";
    this.providerDiagnostics = diagnostics;
  }
}

export type SerpResolverEntry = {
  enabled: boolean;
  configured: boolean;
  priority: number;
  provider: SerpProvider;
  /** Per-provider circuit-breaker opt-out; defaults to enabled. */
  circuitBreakerEnabled?: boolean;
  /** Max additional attempts for temporary failures (0-5); default 2. */
  maxRetries?: number;
  credentialFingerprint?: string | null;
  circuitProjectId?: string | null;
};

function providerLabel(provider: SerpProvider["id"]): string {
  if (provider === "dataforseo") return "DataForSEO";
  if (provider === "serper") return "Serper.dev";
  return "Zenserp";
}

function circuitIdentity(
  entry: SerpResolverEntry,
  input: { organizationId?: string | null; projectId?: string | null },
): ProviderCircuitIdentity {
  return {
    provider: entry.provider.id,
    organizationId: input.organizationId,
    projectId:
      entry.circuitProjectId === undefined
        ? input.projectId
        : entry.circuitProjectId,
    credentialFingerprint: entry.credentialFingerprint,
  };
}

function skippedCall(
  entry: SerpResolverEntry,
  searchInput: SerpSearchInput,
  code: SerpProviderSkipReason,
  circuit?: ReturnType<typeof getProviderCircuitState>,
): SerpProviderCall {
  return {
    provider: entry.provider.id,
    endpoint: providerEndpoint(entry.provider.id),
    status: "skipped",
    httpStatus: null,
    errorCode: code,
    durationMs: 0,
    resultCount: null,
    requestedDepth: searchInput.depth,
    inspectedDepth: null,
    pagesRequested: 0,
    resultCompleteness: "not_applicable",
    dispatched: false,
    skipReason: code,
    circuitBreakerEnabled: entry.circuitBreakerEnabled ?? true,
    maxRetries: clampProviderRetries(entry.maxRetries),
    circuitReason: circuit?.reason ?? null,
    circuitOpenedAt: circuit ? new Date(circuit.openedAt).toISOString() : null,
    circuitExpiresAt: circuit
      ? new Date(circuit.expiresAt).toISOString()
      : null,
  };
}

/**
 * Stamp provider-emitted calls with the resolver-owned retry attribution:
 * which attempt this call was, the provider's configured max retries, and the
 * per-provider circuit-breaker setting. Provider adapters cannot know these.
 */
function annotateCalls(
  calls: SerpProviderCall[],
  attribution: {
    circuitBreakerEnabled: boolean;
    maxRetries: number;
    fromAttempt: number;
    retryable?: boolean;
    retryAfterMs?: number | null;
  },
): SerpProviderCall[] {
  return calls.map((call) => ({
    ...call,
    circuitBreakerEnabled: attribution.circuitBreakerEnabled,
    maxRetries: attribution.maxRetries,
    attempt: attribution.fromAttempt,
    ...(attribution.retryable === undefined
      ? {}
      : { retryable: attribution.retryable, retryAfterMs: attribution.retryAfterMs ?? null }),
  }));
}

export function createSerpResolverFromEntries(input: {
  entries: SerpResolverEntry[];
  organizationId?: string | null;
  projectId?: string | null;
  /**
   * Test seam for the wait between retries. Production callers omit it and get
   * the default policy backoff; tests inject a near-zero wait.
   */
  retryWaitMs?: number;
}) {
  const entries = input.entries.toSorted((a, b) => a.priority - b.priority);
  return {
    async search(searchInput: SerpSearchInput): Promise<NormalizedSerpResult> {
      const calls: SerpProviderCall[] = [];
      for (const [index, entry] of entries.entries()) {
        try {
          await assertNotCancelled(searchInput);
        } catch (error) {
          if (error instanceof SerpCancelledError) {
            calls.push(
              ...entries
                .slice(index)
                .map((remaining) =>
                  skippedCall(remaining, searchInput, "CANCELLED"),
                ),
            );
            throw new SerpCancelledError(calls);
          }
          throw error;
        }
        if (!entry.enabled) {
          calls.push(skippedCall(entry, searchInput, "DISABLED"));
          continue;
        }
        if (!entry.configured) {
          calls.push(skippedCall(entry, searchInput, "MISSING_CREDENTIALS"));
          continue;
        }
        if (!entry.provider.supports(searchInput)) {
          calls.push(skippedCall(entry, searchInput, "UNSUPPORTED_DEVICE"));
          continue;
        }
        const identity = circuitIdentity(entry, input);
        const circuitBreakerEnabled = entry.circuitBreakerEnabled ?? true;
        const maxRetries = clampProviderRetries(entry.maxRetries);
        // A stale OPEN circuit must never bypass a provider whose breaker is
        // disabled; with protection off, memory state is simply ignored.
        const circuit = circuitBreakerEnabled
          ? getProviderCircuitState(identity)
          : null;
        if (circuit) {
          calls.push(skippedCall(entry, searchInput, "CIRCUIT_OPEN", circuit));
          continue;
        }

        // Retry sequence: all of this provider's applicable retries run to
        // exhaustion (or a deterministic failure) BEFORE falling back to the
        // next provider. Providers are never interleaved.
        let lastProviderError: SerpProviderError | null = null;
        let retriesAttempted = 0;
        for (
          let attempt = 1;
          attempt <= maxRetries + 1;
          attempt++
        ) {
          // Cancellation is checked before every retry. Attempt 1 is already
          // covered by the loop-top check above.
          try {
            if (attempt > 1) await assertNotCancelled(searchInput);
          } catch (error) {
            if (!(error instanceof SerpCancelledError)) throw error;
            calls.push(skippedCall(entry, searchInput, "CANCELLED"));
            throw new SerpCancelledError(calls);
          }
          let waitMs: number;
          try {
            const result = await entry.provider.search(searchInput);
            calls.push(
              ...annotateCalls(result.calls, {
                circuitBreakerEnabled,
                maxRetries,
                fromAttempt: attempt,
              }),
            );
            if (circuitBreakerEnabled) {
              closeProviderCircuit(identity);
            }
            return { ...result, calls };
          } catch (error) {
            if (
              error instanceof SerpCancelledError ||
              (error instanceof Error && error.name === "AbortError")
            )
              throw error;
            const providerError =
              error instanceof SerpProviderError
                ? error
                : new SerpProviderError(
                    entry.provider.id,
                    "PROVIDER_FAILURE",
                    [],
                    "Provider request failed",
                  );
            const classification =
              classifyProviderFailure(providerError);
            // An adapter may throw without emitting call records; synthesize
            // one so Provider Calls counts every dispatched attempt truthfully.
            const errorCalls = providerError.calls.length
              ? providerError.calls
              : [
                  {
                    provider: entry.provider.id,
                    endpoint: providerEndpoint(entry.provider.id),
                    status: "failed" as const,
                    httpStatus: null,
                    errorCode: providerError.code,
                    durationMs: 0,
                    resultCount: null,
                    requestedDepth: searchInput.depth,
                    inspectedDepth: null,
                    pagesRequested: 0,
                    resultCompleteness: "not_applicable" as const,
                    dispatched: true,
                  },
                ];
            calls.push(
              ...annotateCalls(errorCalls, {
                circuitBreakerEnabled,
                maxRetries,
                fromAttempt: attempt,
                retryable: classification.retryable,
                retryAfterMs: providerError.retryAfterMs,
              }),
            );
            lastProviderError = providerError;

            // Deterministic API/account/configuration failures can never be
            // rescued by retrying the identical request — stop immediately and
            // let failover proceed to the next provider.
            if (!classification.retryable) break;

            if (retriesAttempted >= maxRetries) break;
            retriesAttempted++;
            // Backoff between retries is cancellable: an abort during the wait
            // must prevent the next request from ever being dispatched.
            waitMs =
              input.retryWaitMs !== undefined
                ? input.retryWaitMs
                : (providerError.retryAfterMs ?? retryBackoffMs(attempt));
          }
          try {
            await waitWithCancellation(waitMs, searchInput.signal);
          } catch (waitError) {
            if (
              !(waitError instanceof SerpCancelledError) &&
              !(waitError instanceof Error && waitError.name === "AbortError")
            ) {
              throw waitError;
            }
            calls.push(skippedCall(entry, searchInput, "CANCELLED"));
            throw new SerpCancelledError(calls);
          }
        }

        // Retries exhausted (or deterministic failure): circuit logic applies
        // only after the retry decision is complete.
        if (
          lastProviderError &&
          circuitBreakerEnabled &&
          lastProviderError.deterministic
        ) {
          openProviderCircuit(identity, lastProviderError.code);
        }
      }
      throw new SerpProvidersUnavailableError(calls);
    },
  };
}
