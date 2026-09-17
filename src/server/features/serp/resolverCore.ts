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
    circuitReason: circuit?.reason ?? null,
    circuitOpenedAt: circuit ? new Date(circuit.openedAt).toISOString() : null,
    circuitExpiresAt: circuit
      ? new Date(circuit.expiresAt).toISOString()
      : null,
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
        const circuit = getProviderCircuitState(identity);
        if (circuit) {
          calls.push(skippedCall(entry, searchInput, "CIRCUIT_OPEN", circuit));
          continue;
        }
        try {
          const result = await entry.provider.search(searchInput);
          calls.push(...result.calls);
          closeProviderCircuit(identity);
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
            openProviderCircuit(identity, providerError.code);
          }
        }
      }
      throw new SerpProvidersUnavailableError(calls);
    },
  };
}
