import type { createDataforseoClient } from "@/server/lib/dataforseo";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  DEFAULT_SERP_PRIORITIES,
  resolveEffectiveSerpProviderConfig,
} from "@/server/features/settings/services/SerpProviderSettingsService";
import { AppError } from "@/server/lib/errors";
import { ProviderUnavailableError } from "@/server/lib/seo-data/errors";
import { createHttpSerpProvider } from "./httpProviders";
import {
  SerpProviderError,
  type SerpProvider,
  type SerpProviderCall,
} from "./types";
import {
  createSerpResolverFromEntries,
  type SerpResolverEntry,
} from "./resolverCore";
import { fingerprintProviderCredential } from "./circuitBreaker";

type DataforseoClient = ReturnType<typeof createDataforseoClient>;

/**
 * Normalize a raw DataForSEO SDK error into the central provider failure
 * vocabulary. Deterministic failures (auth, paused account, credits) are
 * marked so the central retry policy never repeats them; everything else —
 * transport, 5xx, timeouts, malformed responses — stays retryable.
 */
function classifyDataforseoFailure(error: unknown): {
  code: string;
  deterministic: boolean;
} {
  // Structured AppError codes carry the provider's own classification.
  if (error instanceof AppError) {
    switch (error.code) {
      case "DATAFORSEO_ACCOUNT_PAUSED":
        return { code: "DATAFORSEO_ACCOUNT_PAUSED", deterministic: true };
      case "DATAFORSEO_AUTH_FAILED":
      case "UNAUTHENTICATED":
        return { code: "AUTH_FAILED", deterministic: true };
      case "PAYMENT_REQUIRED":
        return { code: "CREDITS_UNAVAILABLE", deterministic: true };
      case "RATE_LIMITED":
        return { code: "RATE_LIMITED", deterministic: false };
      case "UPSTREAM_UNAVAILABLE":
        return { code: "PROVIDER_UNAVAILABLE", deterministic: false };
      default:
        break;
    }
  }
  if (error instanceof ProviderUnavailableError) {
    return { code: "PROVIDER_DISABLED", deterministic: true };
  }
  // Fallback for unstructured SDK/network errors: inspect the message.
  const message = error instanceof Error ? error.message : String(error);
  if (/40201|paused/i.test(message)) {
    return { code: "DATAFORSEO_ACCOUNT_PAUSED", deterministic: true };
  }
  if (/401|auth|credential|invalid api key/i.test(message)) {
    return { code: "AUTH_FAILED", deterministic: true };
  }
  if (/40200|402|credit|quota exhausted/i.test(message)) {
    return { code: "CREDITS_UNAVAILABLE", deterministic: true };
  }
  // Ordinary transport/upstream failures remain retryable.
  return { code: "PROVIDER_FAILURE", deterministic: false };
}

function dataforseoProvider(client: DataforseoClient): SerpProvider {
  return {
    id: "dataforseo",
    supports: () => true,
    async search(input) {
      const startedAt = Date.now();
      try {
        const result = await client.serp.rankCheck({
          keyword: input.keyword,
          keywordId: input.keywordId,
          locationCode: 0,
          locationName: input.location.locationName,
          languageCode: input.location.languageCode,
          device: input.device,
          targetDomain: input.targetDomain,
          depth: input.depth,
        });
        const call: SerpProviderCall = {
          provider: "dataforseo",
          endpoint: "/v3/serp/google/organic/live/advanced",
          status: "success",
          httpStatus: 200,
          errorCode: null,
          durationMs: Date.now() - startedAt,
          resultCount: null,
          requestedDepth: input.depth,
          inspectedDepth: input.depth,
          pagesRequested: 1,
          resultCompleteness:
            result.position == null ? "complete" : "target_found",
          dispatched: true,
        };
        return {
          ...result,
          title: null,
          domain: result.url ? new URL(result.url).hostname : null,
          provider: "dataforseo" as const,
          inspectedDepth: input.depth,
          calls: [call],
        };
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") throw error;
        const { code, deterministic } = classifyDataforseoFailure(error);
        throw new SerpProviderError(
          "dataforseo",
          code,
          [
            {
              provider: "dataforseo",
              endpoint: "/v3/serp/google/organic/live/advanced",
              status: "failed",
              httpStatus: null,
              errorCode: code,
              durationMs: Date.now() - startedAt,
              resultCount: null,
              requestedDepth: input.depth,
              inspectedDepth: null,
              pagesRequested: 1,
              resultCompleteness: "not_applicable",
              dispatched: true,
            },
          ],
          `DataForSEO request failed: ${code}`,
          { deterministic },
        );
      }
    },
  };
}

export async function createRankSerpResolver(input: {
  client: DataforseoClient;
  organizationId: string;
  projectId?: string | null;
  fetchFn?: typeof fetch;
}) {
  const [dataforseo, serper, zenserp] = await Promise.all([
    resolveEffectiveDataforseoConfig(input),
    resolveEffectiveSerpProviderConfig({ ...input, provider: "serper" }),
    resolveEffectiveSerpProviderConfig({ ...input, provider: "zenserp" }),
  ]);
  const configuredOrder = (await getOptionalEnvValue("SERP_PROVIDER_ORDER"))
    ?.split(",")
    .map((value) => value.trim())
    .filter((value) => ["dataforseo", "serper", "zenserp"].includes(value));
  const envPriority = (provider: string, fallback: number, source: string) => {
    if (source === "project" || source === "organization") return fallback;
    const index = configuredOrder?.indexOf(provider) ?? -1;
    return index >= 0 ? index + 1 : fallback;
  };
  const [dataforseoFingerprint, serperFingerprint, zenserpFingerprint] =
    await Promise.all([
      fingerprintProviderCredential("dataforseo", [
        dataforseo.login,
        dataforseo.password,
      ]),
      fingerprintProviderCredential("serper", [serper.apiKey]),
      fingerprintProviderCredential("zenserp", [zenserp.apiKey]),
    ]);
  const entries: SerpResolverEntry[] = [
    {
      enabled: dataforseo.enabled,
      configured: dataforseo.configured,
      priority: envPriority(
        "dataforseo",
        dataforseo.priority ?? DEFAULT_SERP_PRIORITIES.dataforseo,
        dataforseo.source,
      ),
      provider: dataforseoProvider(input.client),
      circuitBreakerEnabled: dataforseo.circuitBreakerEnabled,
      maxRetries: dataforseo.maxRetries,
      credentialFingerprint: dataforseoFingerprint,
      circuitProjectId:
        dataforseo.source === "project" ? input.projectId : null,
    },
    {
      enabled: serper.enabled,
      configured: serper.configured,
      priority: envPriority("serper", serper.priority, serper.source),
      provider: createHttpSerpProvider({
        id: "serper",
        apiKey: serper.apiKey ?? "",
        fetchFn: input.fetchFn,
      }),
      circuitBreakerEnabled: serper.circuitBreakerEnabled,
      maxRetries: serper.maxRetries,
      credentialFingerprint: serperFingerprint,
      circuitProjectId: serper.source === "project" ? input.projectId : null,
    },
    {
      enabled: zenserp.enabled,
      configured: zenserp.configured,
      priority: envPriority("zenserp", zenserp.priority, zenserp.source),
      provider: createHttpSerpProvider({
        id: "zenserp",
        apiKey: zenserp.apiKey ?? "",
        fetchFn: input.fetchFn,
      }),
      circuitBreakerEnabled: zenserp.circuitBreakerEnabled,
      maxRetries: zenserp.maxRetries,
      credentialFingerprint: zenserpFingerprint,
      circuitProjectId: zenserp.source === "project" ? input.projectId : null,
    },
  ];

  return createSerpResolverFromEntries({
    entries,
    organizationId: input.organizationId,
    projectId: input.projectId,
  });
}

export type RankSerpResolver = Awaited<
  ReturnType<typeof createRankSerpResolver>
>;
