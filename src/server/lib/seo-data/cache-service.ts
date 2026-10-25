import {
  buildCacheKey,
  getCached,
  getStaleCached,
  setCached,
} from "@/server/lib/r2-cache";
import { getCacheTtl } from "./config";
import { resolvePlannerCacheIdentity } from "./providers/google-ads-planner-access";
import type { SEODataRequest } from "./types";
import { z, type ZodTypeAny } from "zod";

/**
 * Centralized cache service for SEO data. Wraps the existing R2 cache
 * primitives with per-data-type TTL configuration and deterministic key
 * generation that includes all parameters that materially affect the result.
 */

// Module-level functions rather than a class — the existing codebase style
// (see r2-cache.ts) uses free functions, not static-only classes.

/** Keyword data is served first-party through the project's Google Ads
 *  connection, so entries carry a provenance envelope and are keyed by the
 *  planner identity the data was produced under. Bump this version whenever
 *  the normalized planner payload shape changes: older entries then read as
 *  misses and self-heal on the next refresh. */
export const KEYWORD_CACHE_VERSION = "seo-keyword-v1";

/** Data types whose payloads travel inside the versioned provider envelope
 *  and whose cache keys embed the planner identity. */
const KEYWORD_CACHE_DATA_TYPES = new Set(["keyword_ideas", "keyword_metrics"]);

export function isKeywordCacheDataType(dataType: string): boolean {
  return KEYWORD_CACHE_DATA_TYPES.has(dataType);
}

/** Envelope wrapping first-party keyword payloads: provenance (provider +
 *  fetch time) travels with the data so freshness policy and sourcing stay
 *  decidable after a read. */
const KEYWORD_CACHE_ENVELOPE_SCHEMA = z
  .object({
    seoCacheVersion: z.string(),
    provider: z.string(),
    fetchedAt: z.iso.datetime(),
    data: z.unknown(),
  })
  .passthrough();

/** Read provenance from a cached keyword envelope. A malformed envelope, a
 *  version mismatch, schema drift in the payload, or an entry older than the
 *  caller's `maxAgeSeconds` all read as a miss (legacy raw payloads kept
 *  their shape, so envelope migration is a zero-downtime self-heal). */
function readKeywordEnvelope<T>(
  raw: unknown,
  schema: ZodTypeAny,
  maxAgeSeconds: number | undefined,
):
  | { ok: false }
  | { ok: true; data: T; cacheProvider: string; fetchedAt: string } {
  const envelope = KEYWORD_CACHE_ENVELOPE_SCHEMA.safeParse(raw);
  if (!envelope.success) return { ok: false };
  if (envelope.data.seoCacheVersion !== KEYWORD_CACHE_VERSION) {
    return { ok: false };
  }
  if (maxAgeSeconds !== undefined) {
    // 0 means the caller explicitly wants fresh data — every envelope misses.
    if (maxAgeSeconds <= 0) return { ok: false };
    const fetchedMs = Date.parse(envelope.data.fetchedAt);
    const ageSeconds = (Date.now() - fetchedMs) / 1000;
    if (Number.isFinite(ageSeconds) && ageSeconds > maxAgeSeconds) {
      return { ok: false };
    }
  }
  const payload = schema.safeParse(envelope.data.data);
  if (!payload.success) return { ok: false };
  return {
    ok: true,
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safeParse validated the value against the caller's keyword schema
    data: payload.data as T,
    cacheProvider: envelope.data.provider,
    fetchedAt: envelope.data.fetchedAt,
  };
}

/**
 * Build a deterministic cache key from the request. Includes all parameters
 * that materially affect the result: data type, keyword/domain/url,
 * location, language, device, date range, and constraints.
 *
 * Format: {dataType}:{organizationId}:{sha256(params)}
 */
async function buildKey(request: SEODataRequest): Promise<string> {
  const constraints = request.constraints
    ? { ...request.constraints }
    : undefined;
  if (request.dataType === "domain_overview" && constraints) {
    delete constraints.projectId;
  }
  // A backlink *summary* call bills and returns purely on the domain target —
  // `projectId` in constraints is routing metadata (see
  // dataforseo-provider#routeBacklinksRequest) and does not affect the paid
  // result. Dropping it lets the dashboard and BacklinksService share one
  // cached entry per (org, domain). Organization isolation is unaffected:
  // organizationId is always part of the key below.
  if (
    request.dataType === "backlinks" &&
    constraints &&
    constraints.backlinkCall === "summary"
  ) {
    delete constraints.projectId;
  }
  // A competitive-metrics call bills and returns purely on the target (+
  // metric family): `projectId` is routing metadata and does not affect the
  // result. Dropping it lets analyses of different keywords (and projects in
  // the same org) share one cached entry per target. Organization isolation
  // is unaffected: organizationId is always part of the key below.
  if (request.dataType === "competitive_metrics" && constraints) {
    delete constraints.projectId;
  }

  const params: Record<string, unknown> = {
    dataType: request.dataType,
    organizationId: request.billingCustomer.organizationId,
    keyword: request.keyword,
    keywords: request.keywords,
    domain: request.domain,
    url: request.url,
    urls: request.urls,
    locationCode: request.locationCode,
    languageCode: request.languageCode,
    device: request.device,
    dateFrom: request.dateFrom,
    dateTo: request.dateTo,
    constraints,
  };

  // Keyword data is produced first-party through the project's planner
  // connection: embed that identity so entries written under one Ads
  // account never answer for another, and unconnected projects share one
  // explicit `{customer: null}` subtree. Project scope differs by flow —
  // keyword_ideas results are the market's (project-agnostic), while
  // refresh-style keyword_metrics reads stay scoped to the requesting
  // project's persisted snapshot.
  if (KEYWORD_CACHE_DATA_TYPES.has(request.dataType)) {
    params.planner = await resolvePlannerCacheIdentity({
      projectId: request.billingCustomer.projectId,
      organizationId: request.billingCustomer.organizationId,
    });
    if (request.dataType === "keyword_ideas" && constraints) {
      delete constraints.projectId;
    }
  }

  return buildCacheKey(`seo:${request.dataType}`, params);
}

/**
 * Read a cached value. Returns null on miss, expiry, or schema validation
 * failure (schema drift between writes and reads is treated as a miss).
 */
async function get<T>(
  request: SEODataRequest,
  schema: ZodTypeAny,
): Promise<{ data: T; key: string } | null> {
  const key = await buildKey(request);
  const raw = await getCached(key);
  if (raw === null) return null;

  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;

  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safeParse narrows to T
  return { data: parsed.data as T, key };
}

/**
 * Write a value to the cache with the TTL configured for its data type.
 * Uses `waitUntil` semantics — callers should wrap in `waitUntil` if the
 * response is already sent (the existing pattern in the codebase).
 *
 * Keyword data types are written inside the provenance envelope: pass the
 * serving provider's name (and, when known, its fetch timestamp) so cached
 * entries stay attributable. Non-keyword types store the raw payload.
 */
async function set(
  request: SEODataRequest,
  key: string,
  data: unknown,
  precedents?: { provider: string; fetchedAt?: string },
): Promise<void> {
  const ttl = await getCacheTtl(request.dataType);
  const payload = KEYWORD_CACHE_DATA_TYPES.has(request.dataType)
    ? {
        seoCacheVersion: KEYWORD_CACHE_VERSION,
        provider: precedents?.provider ?? "unknown",
        fetchedAt: precedents?.fetchedAt ?? new Date().toISOString(),
        data,
      }
    : data;
  await setCached(key, payload, ttl);
}

/**
 * Full cache-first flow: check cache, return on hit; on miss, call the
 * fetcher, cache the result, and return it. The fetcher receives the cache
 * key so it can reuse it for the write.
 *
 * Keyword data types additionally honor `maxAgeSeconds` against the
 * envelope's fetch timestamp and surface the cached entry's provenance on a
 * hit (`cacheProvider` / `fetchedAt`).
 */
export type SeoCacheQueryResult<T> = {
  data: T;
  fromCache: boolean;
  key: string;
  /** Cached provenance — set only for keyword data types served from cache. */
  cacheProvider?: string;
  fetchedAt?: string;
};

async function getOrFetch<T>(
  request: SEODataRequest,
  schema: ZodTypeAny,
  fetcher: (key: string) => Promise<T>,
  maxAgeSeconds?: number,
): Promise<SeoCacheQueryResult<T>> {
  const key = await buildKey(request);

  const raw = await getCached(key);
  if (raw !== null) {
    const envelopeHit = KEYWORD_CACHE_DATA_TYPES.has(request.dataType)
      ? readKeywordEnvelope<T>(raw, schema, maxAgeSeconds)
      : { ok: false as const };
    if (envelopeHit.ok) {
      return {
        data: envelopeHit.data,
        fromCache: true,
        key,
        cacheProvider: envelopeHit.cacheProvider,
        fetchedAt: envelopeHit.fetchedAt,
      };
    }
    if (!KEYWORD_CACHE_DATA_TYPES.has(request.dataType)) {
      const parsed = schema.safeParse(raw);
      if (parsed.success) {
        // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safeParse narrows to T
        return { data: parsed.data as T, fromCache: true, key };
      }
    }
  }

  const data = await fetcher(key);
  return { data, fromCache: false, key };
}

export const SeoCacheService = {
  buildKey,
  get,
  getStale,
  set,
  getOrFetch,
};

/**
 * Read a cached value IGNORING expiry (stale fallback). Returns null on
 * miss, corrupt JSON, or schema mismatch. Total — never throws. Callers
 * MUST mark served values stale; the value is the last-known observation,
 * not a fresh fact.
 */
async function getStale<T>(
  request: SEODataRequest,
  schema: ZodTypeAny,
): Promise<{ data: T; key: string } | null> {
  const key = await buildKey(request);
  const raw = await getStaleCached(key);
  if (raw === null) return null;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) return null;
  // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- safeParse narrows to T
  return { data: parsed.data as T, key };
}

/**
 * A passthrough schema that accepts any valid JSON-serializable value.
 * Used when a provider's result shape is not easily narrowed to a Zod schema.
 */
export const passthroughSchema = z.unknown();
