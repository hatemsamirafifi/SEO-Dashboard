import type { SeRankingClient } from "./client";
import {
  seRankingSystemEngineSchema,
  type SeRankingSystemEngine,
} from "./projectSchemas";
import { countryCodeToSeRankingSource } from "./region-map";

interface CatalogCache<T> {
  data: T | null;
  fetchedAt: number;
}

const CACHE_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
let enginesCache: CatalogCache<SeRankingSystemEngine[]> = {
  data: null,
  fetchedAt: 0,
};

// Known baseline engine IDs as reliable defaults
const FALLBACK_ENGINES: Record<
  string,
  { desktop: number; mobile: number; name: string }
> = {
  us: { desktop: 200, mobile: 600, name: "Google USA" },
  eg: { desktop: 339, mobile: 739, name: "Google Egypt" },
  sa: { desktop: 340, mobile: 740, name: "Google Saudi Arabia" },
  ae: { desktop: 202, mobile: 602, name: "Google United Arab Emirates" },
  uk: { desktop: 204, mobile: 604, name: "Google United Kingdom" },
  gb: { desktop: 204, mobile: 604, name: "Google United Kingdom" },
  de: { desktop: 205, mobile: 605, name: "Google Germany" },
  fr: { desktop: 206, mobile: 606, name: "Google France" },
};

export async function getSystemSearchEngines(
  client: SeRankingClient,
  forceRefresh = false,
): Promise<SeRankingSystemEngine[]> {
  const now = Date.now();
  if (
    !forceRefresh &&
    enginesCache.data &&
    now - enginesCache.fetchedAt < CACHE_TTL_MS
  ) {
    return enginesCache.data;
  }

  try {
    const raw = await client.request<unknown[]>(
      "/project-management/system/search-engines",
      { method: "GET" },
    );
    if (Array.isArray(raw)) {
      const parsed = raw
        .map((item) => {
          const res = seRankingSystemEngineSchema.safeParse(item);
          return res.success ? res.data : null;
        })
        .filter((item): item is SeRankingSystemEngine => item !== null);

      if (parsed.length > 0) {
        enginesCache = { data: parsed, fetchedAt: now };
        return parsed;
      }
    }
  } catch {
    // If upstream catalog fetch fails, fallback to cached or default
    if (enginesCache.data) {
      return enginesCache.data;
    }
  }

  return [];
}

export async function resolveEngineCatalogId(
  client: SeRankingClient,
  params: {
    countryCode: string;
    device: "desktop" | "mobile";
  },
): Promise<{
  searchEngineId: number;
  engineName: string;
}> {
  const country = countryCodeToSeRankingSource(params.countryCode);
  const engines = await getSystemSearchEngines(client);

  const isMobile = params.device === "mobile";

  // Try matching from live catalog
  if (engines.length > 0) {
    const match = engines.find((e) => {
      const name = e.name.toLowerCase();
      const mobileMatch = isMobile
        ? name.includes("mobile") || e.is_mobile === 1
        : !name.includes("mobile") && (e.is_mobile === 0 || !e.is_mobile);

      const countryMatch =
        (e.country_code && e.country_code.toLowerCase() === country) ||
        name.includes(country);

      return countryMatch && mobileMatch;
    });

    if (match) {
      return {
        searchEngineId: match.id,
        engineName: match.name,
      };
    }
  }

  // Fallback to known baseline catalog
  const fallback = FALLBACK_ENGINES[country] ?? FALLBACK_ENGINES.us;
  const searchEngineId = isMobile ? fallback.mobile : fallback.desktop;
  const engineName = `${fallback.name} (${params.device})`;

  return {
    searchEngineId,
    engineName,
  };
}

export function clearCatalogCache(): void {
  enginesCache = { data: null, fetchedAt: 0 };
}
