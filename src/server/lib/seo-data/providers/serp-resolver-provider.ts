import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db";
import { serpOrganicSnapshots } from "@/db/schema";
import { fingerprintProviderCredential } from "@/server/features/serp/circuitBreaker";
import { createHttpSerpProvider } from "@/server/features/serp/httpProviders";
import {
  createSerpResolverFromEntries,
  SerpProvidersUnavailableError,
  type SerpResolverEntry,
} from "@/server/features/serp/resolverCore";
import type {
  NormalizedSerpResult,
  SerpFeatureSet,
} from "@/server/features/serp/types";
import { resolveEffectiveDataforseoConfig } from "@/server/features/settings/services/DataforseoSettingsService";
import {
  DEFAULT_SERP_PRIORITIES,
  resolveEffectiveSerpProviderConfig,
} from "@/server/features/settings/services/SerpProviderSettingsService";
import type { SerpLiveItem } from "@/server/lib/dataforseo/serp";
import { AppError } from "@/server/lib/errors";
import { getOptionalEnvValue } from "@/server/lib/runtime-env";
import {
  getIsoCountryCode,
  LOCATION_OPTIONS,
} from "@/shared/keyword-locations";
import {
  ProviderUnavailableError,
  ProviderUnsupportedError,
  SerpNoProviderConfiguredError,
  type SerpProviderDiagnostic,
} from "../errors";
import type { SEODataProvider, SEODataRequest } from "../types";

export { SerpNoProviderConfiguredError, type SerpProviderDiagnostic };

function mapFeaturesToLiveItems(
  features: SerpFeatureSet | undefined,
): SerpLiveItem[] {
  if (!features) return [];
  const items: SerpLiveItem[] = [];

  if (features.featuredResult) {
    items.push({
      type: "featured_snippet",
      title: features.featuredResult.title,
      url: features.featuredResult.url ?? null,
      domain: features.featuredResult.domain ?? null,
      description: features.featuredResult.snippet,
    });
  }
  if (features.peopleAlsoAsk) {
    for (const paa of features.peopleAlsoAsk.items) {
      items.push({
        type: "people_also_ask",
        title: paa.question,
        url: paa.url ?? null,
        rank_absolute: paa.placement ?? null,
      });
    }
  }
  if (features.relatedSearches) {
    for (const query of features.relatedSearches.items) {
      items.push({
        type: "related_searches",
        title: query,
      });
    }
  }
  if (features.localPack) {
    for (const place of features.localPack.items) {
      items.push({
        type: "local_pack",
        title: place.title,
        url: place.url ?? null,
        domain: place.domain ?? null,
        ...(place.address ? { address: place.address } : {}),
        ...(place.rating != null ? { rating: place.rating } : {}),
        ...(place.reviewCount != null
          ? { review_count: place.reviewCount }
          : {}),
      });
    }
  }
  if (features.knowledgeGraph) {
    items.push({
      type: "knowledge_graph",
      title: features.knowledgeGraph.title,
      url: features.knowledgeGraph.url ?? null,
      domain: features.knowledgeGraph.domain ?? null,
      description: features.knowledgeGraph.description ?? null,
    });
  }
  return items;
}

function mapNormalizedResultToLiveItems(
  result: NormalizedSerpResult,
  fetchedAt: string,
): SerpLiveItem[] {
  const organicItems: SerpLiveItem[] = (result.organicResults ?? []).map(
    (entry) => ({
      type: "organic",
      rank_group: entry.position,
      rank_absolute: entry.position,
      title: entry.title ?? "",
      url: entry.url,
      domain: entry.domain,
      description: result.organicDescriptions?.[entry.position] ?? "",
      _provider: result.provider,
      _fetchedAt: fetchedAt,
    }),
  );

  const featureItems = mapFeaturesToLiveItems(result.observedFeatures);
  return [...organicItems, ...featureItems];
}

async function getStoredOrganicSnapshotItems(input: {
  projectId: string | null;
  keyword: string;
  locationCode: number;
  languageCode: string;
  device: "desktop" | "mobile";
}): Promise<SerpLiveItem[] | null> {
  if (!input.projectId) return null;
  try {
    const rows = await db
      .select({
        runId: serpOrganicSnapshots.runId,
        position: serpOrganicSnapshots.position,
        url: serpOrganicSnapshots.url,
        title: serpOrganicSnapshots.title,
        domain: serpOrganicSnapshots.domain,
        provider: serpOrganicSnapshots.provider,
        observedAt: serpOrganicSnapshots.observedAt,
      })
      .from(serpOrganicSnapshots)
      .where(
        and(
          eq(serpOrganicSnapshots.projectId, input.projectId),
          eq(serpOrganicSnapshots.keyword, input.keyword),
          eq(serpOrganicSnapshots.locationCode, input.locationCode),
          eq(serpOrganicSnapshots.languageCode, input.languageCode),
          eq(serpOrganicSnapshots.device, input.device),
        ),
      )
      .orderBy(
        desc(serpOrganicSnapshots.observedAt),
        serpOrganicSnapshots.position,
      )
      .limit(20);

    if (rows.length === 0) return null;
    const latestRunId = rows[0].runId;
    const runRows = rows
      .filter((row) => row.runId === latestRunId)
      .toSorted((a, b) => a.position - b.position);

    return runRows.map((row) => ({
      type: "organic",
      rank_group: row.position,
      rank_absolute: row.position,
      title: row.title ?? "",
      url: row.url,
      domain: row.domain ?? "",
      description: "",
      _provider: row.provider || "internal",
      _fetchedAt: row.observedAt,
    }));
  } catch {
    return null;
  }
}

function toDispatchedAppError(
  error: SerpProvidersUnavailableError,
): AppError | null {
  const dispatchedFailure = error.calls.findLast((call) => call.dispatched);
  if (!dispatchedFailure) return null;

  const providerName =
    dispatchedFailure.provider === "serper" ? "Serper.dev" : "Zenserp";
  const code = dispatchedFailure.errorCode ?? "PROVIDER_FAILURE";

  if (code === "AUTH_FAILED") {
    return new AppError(
      "UNAUTHENTICATED",
      `${providerName} authentication failed`,
      {
        publicMessage: `${providerName} rejected the API key. Check your ${providerName} credentials in Settings.`,
      },
    );
  }
  if (code === "QUOTA_EXHAUSTED") {
    return new AppError(
      "INSUFFICIENT_CREDITS",
      `${providerName} quota exhausted`,
      {
        publicMessage: `${providerName} quota or credits are exhausted. Add credits or switch SERP providers in Settings.`,
      },
    );
  }
  if (code === "RATE_LIMITED") {
    return new AppError("RATE_LIMITED", `${providerName} rate limited`, {
      publicMessage: `${providerName} rate limit reached. Please wait a moment and retry.`,
    });
  }
  return new AppError(
    "UPSTREAM_UNAVAILABLE",
    `${providerName} failed with ${code}`,
    {
      publicMessage: `${providerName} SERP request failed (${code}). Please retry in a moment.`,
    },
  );
}

export function createSerpResolverProvider(): SEODataProvider {
  return {
    name: "serp_resolver",

    supports(request: SEODataRequest): boolean {
      return request.dataType === "serp" && Boolean(request.keyword?.trim());
    },

    async get(request: SEODataRequest): Promise<SerpLiveItem[]> {
      const keyword = request.keyword?.trim();
      if (!keyword) {
        throw new ProviderUnsupportedError(
          "serp_resolver",
          request.dataType,
          "SERP resolver requires a keyword",
        );
      }

      const organizationId = request.billingCustomer.organizationId;
      const projectId =
        request.billingCustomer.projectId ??
        (typeof request.constraints?.projectId === "string"
          ? request.constraints.projectId
          : null);
      const locationCode = request.locationCode ?? 2840;
      const languageCode = request.languageCode ?? "en";
      const device = request.device ?? "desktop";

      const [dataforseo, serper, zenserp, configuredOrderRaw] =
        await Promise.all([
          resolveEffectiveDataforseoConfig({ organizationId, projectId }),
          resolveEffectiveSerpProviderConfig({
            organizationId,
            projectId,
            provider: "serper",
          }),
          resolveEffectiveSerpProviderConfig({
            organizationId,
            projectId,
            provider: "zenserp",
          }),
          getOptionalEnvValue("SERP_PROVIDER_ORDER"),
        ]);

      const configuredOrder = configuredOrderRaw
        ?.split(",")
        .map((value) => value.trim())
        .filter((value) => ["dataforseo", "serper", "zenserp"].includes(value));

      const envPriority = (
        provider: string,
        fallback: number,
        source: string,
      ) => {
        if (source === "project" || source === "organization") return fallback;
        const index = configuredOrder?.indexOf(provider) ?? -1;
        return index >= 0 ? index + 1 : fallback;
      };

      // If DataForSEO is enabled, configured, and has strictly higher priority
      // (lower number) than any enabled HTTP SERP provider, defer to the
      // router's dataforseo provider step.
      const dfsPriority = envPriority(
        "dataforseo",
        dataforseo.priority ?? DEFAULT_SERP_PRIORITIES.dataforseo,
        dataforseo.source,
      );
      const serperPriority = envPriority(
        "serper",
        serper.priority,
        serper.source,
      );
      const zenserpPriority = envPriority(
        "zenserp",
        zenserp.priority,
        zenserp.source,
      );

      const bestHttpPriority = Math.min(
        serper.enabled && serper.configured ? serperPriority : Infinity,
        zenserp.enabled && zenserp.configured ? zenserpPriority : Infinity,
      );

      if (
        dataforseo.enabled &&
        dataforseo.configured &&
        dfsPriority < bestHttpPriority
      ) {
        throw new ProviderUnavailableError(
          "serp_resolver",
          "Deferring to higher-priority DataForSEO SERP provider",
        );
      }

      const [serperFingerprint, zenserpFingerprint] = await Promise.all([
        fingerprintProviderCredential("serper", [serper.apiKey]),
        fingerprintProviderCredential("zenserp", [zenserp.apiKey]),
      ]);

      const entries: SerpResolverEntry[] = [
        {
          enabled: serper.enabled,
          configured: serper.configured,
          priority: serperPriority,
          provider: createHttpSerpProvider({
            id: "serper",
            apiKey: serper.apiKey ?? "",
          }),
          circuitBreakerEnabled: serper.circuitBreakerEnabled,
          maxRetries: serper.maxRetries,
          credentialFingerprint: serperFingerprint,
          circuitProjectId: serper.source === "project" ? projectId : null,
        },
        {
          enabled: zenserp.enabled,
          configured: zenserp.configured,
          priority: zenserpPriority,
          provider: createHttpSerpProvider({
            id: "zenserp",
            apiKey: zenserp.apiKey ?? "",
          }),
          circuitBreakerEnabled: zenserp.circuitBreakerEnabled,
          maxRetries: zenserp.maxRetries,
          credentialFingerprint: zenserpFingerprint,
          circuitProjectId: zenserp.source === "project" ? projectId : null,
        },
      ];

      const resolver = createSerpResolverFromEntries({
        entries,
        organizationId,
        projectId,
      });

      const countryCode = getIsoCountryCode(locationCode).toUpperCase();
      const countryName =
        LOCATION_OPTIONS.find((option) => option.code === locationCode)
          ?.label ?? countryCode;

      try {
        const result = await resolver.search({
          keywordId: `serp:${keyword}`,
          keyword,
          targetDomain: "",
          location: {
            countryCode,
            languageCode,
            locationName: countryName,
          },
          device,
          depth: 10,
        });
        const fetchedAt = new Date().toISOString();
        return mapNormalizedResultToLiveItems(result, fetchedAt);
      } catch (error) {
        // Before failing, check if we have stored organic snapshots from a previous rank check
        const stored = await getStoredOrganicSnapshotItems({
          projectId,
          keyword,
          locationCode,
          languageCode,
          device,
        });
        if (stored && stored.length > 0) {
          return stored;
        }

        if (error instanceof SerpProvidersUnavailableError) {
          if (!dataforseo.enabled || !dataforseo.configured) {
            const dispatchedAppErr = toDispatchedAppError(error);
            if (dispatchedAppErr) {
              throw dispatchedAppErr;
            }
          }
          const dfsReason = !dataforseo.enabled
            ? "DISABLED"
            : !dataforseo.configured
              ? "MISSING_CREDENTIALS"
              : "AVAILABLE";
          const diagnostics: SerpProviderDiagnostic[] = [
            { provider: "DataForSEO", reason: dfsReason },
            ...error.providerDiagnostics,
          ];
          throw new SerpNoProviderConfiguredError(
            `No SERP provider is configured or enabled (${diagnostics
              .map((d) => `${d.provider}: ${d.reason}`)
              .join(", ")})`,
            diagnostics,
          );
        }
        throw error;
      }
    },
  };
}
