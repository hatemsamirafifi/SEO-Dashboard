import type { createDataforseoClient } from "@/server/lib/dataforseo";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  DEFAULT_SERP_PRIORITIES,
  resolveEffectiveSerpProviderConfig,
} from "@/server/features/settings/services/SerpProviderSettingsService";
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

type DataforseoClient = ReturnType<typeof createDataforseoClient>;

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
        const message = error instanceof Error ? error.message : String(error);
        const deterministic = /40201|paused|auth|credential|credit/i.test(
          message,
        );
        const code = /40201|paused/i.test(message)
          ? "DATAFORSEO_ACCOUNT_PAUSED"
          : /auth|credential/i.test(message)
            ? "AUTH_FAILED"
            : /credit/i.test(message)
              ? "CREDITS_UNAVAILABLE"
              : "PROVIDER_FAILURE";
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
          deterministic,
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
