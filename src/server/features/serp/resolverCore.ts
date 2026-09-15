import {
  closeProviderCircuit,
  isProviderCircuitOpen,
  openProviderCircuit,
} from "./circuitBreaker";
import {
  assertNotCancelled,
  SerpCancelledError,
  SerpProviderError,
  type NormalizedSerpResult,
  type SerpProvider,
  type SerpProviderCall,
  type SerpSearchInput,
} from "./types";
import { providerEndpoint } from "./httpProviders";

export class SerpProvidersUnavailableError extends Error {
  constructor(public readonly calls: SerpProviderCall[]) {
    super("SERP_PROVIDERS_UNAVAILABLE");
    this.name = "SerpProvidersUnavailableError";
  }
}

export type SerpResolverEntry = {
  enabled: boolean;
  configured: boolean;
  priority: number;
  provider: SerpProvider;
};

function skippedCall(
  entry: SerpResolverEntry,
  searchInput: SerpSearchInput,
  code: "DISABLED" | "NOT_CONFIGURED" | "UNSUPPORTED_DEVICE" | "CIRCUIT_OPEN",
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
  };
}

export function createSerpResolverFromEntries(input: {
  entries: SerpResolverEntry[];
  organizationId?: string | null;
  projectId?: string | null;
}) {
  const entries = input.entries.toSorted((a, b) => a.priority - b.priority);
  return {
    async search(searchInput: SerpSearchInput): Promise<NormalizedSerpResult> {
      const calls: SerpProviderCall[] = [];
      for (const entry of entries) {
        await assertNotCancelled(searchInput);
        if (!entry.enabled) {
          calls.push(skippedCall(entry, searchInput, "DISABLED"));
          continue;
        }
        if (!entry.configured) {
          calls.push(skippedCall(entry, searchInput, "NOT_CONFIGURED"));
          continue;
        }
        if (!entry.provider.supports(searchInput)) {
          calls.push(skippedCall(entry, searchInput, "UNSUPPORTED_DEVICE"));
          continue;
        }
        if (
          isProviderCircuitOpen(
            entry.provider.id,
            input.organizationId,
            input.projectId,
          )
        ) {
          calls.push(skippedCall(entry, searchInput, "CIRCUIT_OPEN"));
          continue;
        }
        try {
          const result = await entry.provider.search(searchInput);
          calls.push(...result.calls);
          closeProviderCircuit(
            entry.provider.id,
            input.organizationId,
            input.projectId,
          );
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
          calls.push(...providerError.calls);
          if (providerError.deterministic) {
            openProviderCircuit(
              entry.provider.id,
              input.organizationId,
              input.projectId,
            );
          }
        }
      }
      throw new SerpProvidersUnavailableError(calls);
    },
  };
}
