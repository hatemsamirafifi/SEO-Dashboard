export type SerpProviderId = "dataforseo" | "serper" | "zenserp";
export type SerpDevice = "desktop" | "mobile";

/* ------------------------------------------------------------------ *
 * Frozen normalized SerpSnapshot contract (spec 003, hard gate G4).
 *
 * THE single normalized SERP model. All downstream consumers (007
 * enrichment, 011 features UI, detectors) import these Zod schemas and
 * types — never raw provider JSON, never a second resolver, never
 * provider-specific UI models. Provider fields are provenance, not
 * identity. Absent feature families stay absent (undefined), never
 * null-coerced empties. Metric vocabulary is provider-accurate only:
 * DataForSEO Domain Rank / Page Rank, referring domains, backlinks,
 * provider-supported spam/risk, estimated traffic — no DA/PA/DR/TF/CF.
 * ------------------------------------------------------------------ */
import { z } from "zod";

/** Canonical location identity: DataForSEO location code is primary;
 *  country/location names are display/cross-check fields. */
export type CanonicalSerpLocation = {
  locationCode: number;
  locationName: string;
  countryCode: string;
};

/** Feature family names observed in normalized snapshots. `featureRefs`
 *  on organic results reference these keys. */
export const SERP_FEATURE_KEYS = [
  "featured_result",
  "people_also_ask",
  "related_searches",
  "local_pack",
  "images",
  "videos",
  "shopping",
  "news",
  "knowledge_graph",
  "sitelinks",
] as const;
export type SerpFeatureKey = (typeof SERP_FEATURE_KEYS)[number];

const isoFullTimestamp = z
  .string()
  .refine(
    (value) => !Number.isNaN(Date.parse(value)) && value.includes("T"),
    "Full ISO timestamp required (date-only rejected)",
  );

const organicResultSchema = z.object({
  position: z.number().int().positive(),
  title: z.string().nullish(),
  url: z.string(),
  domain: z.string(),
  /** e.g. "organic", "sitelinks-augmented" — raw provider classification. */
  resultType: z.string().nullish(),
  /** Associated feature keys (see SERP_FEATURE_KEYS). */
  featureRefs: z.array(z.string()).default([]),
});
export type SerpOrganicResult = z.infer<typeof organicResultSchema>;

const featuredResultSchema = z.object({
  title: z.string(),
  url: z.string().nullish(),
  domain: z.string().nullish(),
  snippet: z.string(),
});

const paaItemSchema = z.object({
  question: z.string(),
  url: z.string().nullish(),
  /** Optional observed placement metadata; rendering policy is decided in
   *  the features UI package, never in consumers. */
  placement: z.number().int().nonnegative().nullish(),
});

const localPackItemSchema = z.object({
  title: z.string(),
  url: z.string().nullish(),
  domain: z.string().nullish(),
  address: z.string().nullish(),
  rating: z.number().nullish(),
  reviewCount: z.number().int().nullish(),
});

const imageItemSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  domain: z.string().nullish(),
});

const videoItemSchema = z.object({
  url: z.string(),
  title: z.string().nullish(),
  domain: z.string().nullish(),
});

const shoppingItemSchema = z.object({
  title: z.string(),
  url: z.string().nullish(),
  domain: z.string().nullish(),
  /** Provider-observed price string; never invented when absent. */
  price: z.string().nullish(),
});

const newsItemSchema = z.object({
  title: z.string(),
  url: z.string().nullish(),
  domain: z.string().nullish(),
  sourceName: z.string().nullish(),
  publishedAt: isoFullTimestamp.nullish(),
});

const knowledgeGraphSchema = z.object({
  title: z.string(),
  url: z.string().nullish(),
  domain: z.string().nullish(),
  description: z.string().nullish(),
});

const sitelinksItemSchema = z.object({
  url: z.string(),
  domain: z.string().nullish(),
  title: z.string().nullish(),
});

/** Only OBSERVED families appear as keys; unobserved families are absent
 *  (undefined) — the schema distinguishes "not present" from "present and
 *  empty" so failure can never be rendered as a fact (P8). */
const featureSetSchema = z
  .object({
    featuredResult: featuredResultSchema.optional(),
    peopleAlsoAsk: z.object({ items: z.array(paaItemSchema) }).optional(),
    relatedSearches: z.object({ items: z.array(z.string()) }).optional(),
    localPack: z.object({ items: z.array(localPackItemSchema) }).optional(),
    images: z.object({ items: z.array(imageItemSchema) }).optional(),
    videos: z.object({ items: z.array(videoItemSchema) }).optional(),
    shopping: z.object({ items: z.array(shoppingItemSchema) }).optional(),
    news: z.object({ items: z.array(newsItemSchema) }).optional(),
    knowledgeGraph: knowledgeGraphSchema.optional(),
    sitelinks: z.object({ items: z.array(sitelinksItemSchema) }).optional(),
  })
  .strict();
export type SerpFeatureSet = z.infer<typeof featureSetSchema>;

const snapshotShape = {
  keyword: z.string().min(1),
  engine: z.enum(["google"]),
  location: z.object({
    locationCode: z.number().int().positive(),
    locationName: z.string(),
    countryCode: z.string().min(1),
  }),
  language: z.string().min(1),
  device: z.enum(["desktop", "mobile"]),
  /** OpenSEO observation time (fetch). Distinct from provider snapshot. */
  checkedAt: isoFullTimestamp,
  /** Provider-snapshot time. Freshness policy must consult this, not fetch
   *  time alone (P19). */
  providerSnapshotAt: isoFullTimestamp,
  /** Position-ordered for display; never a merge identity. */
  organicResults: z.array(organicResultSchema),
  /** Only observed families present; absent families stay absent. */
  features: featureSetSchema,
  /** Provenance only — never part of the logical identity. */
  provider: z.enum(["dataforseo", "serper", "zenserp"]),
  providerStatus: z.string(),
  /** Integrity/dedup/validation aid — never replaces logical identity. */
  contentHash: z.string().nullish(),
};

export const serpSnapshotSchema = z.object(snapshotShape).strict();
export type SerpSnapshot = z.infer<typeof serpSnapshotSchema>;

/** Canonical form for identity dimensions (spec FR-002): trimmed keyword,
 *  lowercased engine/language/device, location passed through validated. */
export function canonicalSerpSnapshot(input: {
  keyword: string;
  engine: string;
  location: CanonicalSerpLocation;
  language: string;
  device: string;
  checkedAt: string;
  providerSnapshotAt?: string;
  [key: string]: unknown;
}): {
  keyword: string;
  engine: string;
  location: CanonicalSerpLocation;
  language: string;
  device: string;
  checkedAt: string;
} {
  return {
    keyword: input.keyword.trim(),
    engine: input.engine.toLowerCase(),
    location: {
      locationCode: input.location.locationCode,
      locationName: input.location.locationName,
      countryCode: input.location.countryCode.toUpperCase(),
    },
    language: input.language.toLowerCase(),
    device: input.device.toLowerCase(),
    checkedAt: input.checkedAt,
  };
}

/** SerpSnapshot logical identity key (FR-002): canonicalized
 *  (keyword, engine, location, language, device, checkedAt) — provider,
 *  providerStatus, contentHash, and projectId (tenancy/storage) excluded. */
export function serpSnapshotIdentityKey(snapshot: {
  keyword: string;
  engine: string;
  location: CanonicalSerpLocation;
  language: string;
  device: string;
  checkedAt: string;
}): string {
  const canonical = canonicalSerpSnapshot(snapshot);
  return [
    canonical.keyword,
    canonical.engine,
    canonical.location.locationCode,
    canonical.location.countryCode,
    canonical.location.locationName,
    canonical.language,
    canonical.device,
    canonical.checkedAt,
  ].join("|");
}

export type SerpProviderSkipReason =
  | "DISABLED"
  | "MISSING_CREDENTIALS"
  | "CIRCUIT_OPEN"
  | "UNSUPPORTED_DEVICE"
  | "UNSUPPORTED_LOCATION"
  | "CANCELLED"
  | "INVALID_CONFIGURATION";

export type NormalizedSerpLocation = {
  countryCode: string;
  languageCode: string;
  locationName: string;
};

export type SerpSearchInput = {
  keywordId: string;
  keyword: string;
  targetDomain: string;
  location: NormalizedSerpLocation;
  device: SerpDevice;
  depth: number;
  signal?: AbortSignal;
  isCancelled?: () => Promise<boolean>;
};

export type SerpProviderCall = {
  provider: SerpProviderId;
  endpoint: string;
  status: "success" | "failed" | "insufficient_depth" | "skipped";
  httpStatus: number | null;
  errorCode: string | null;
  durationMs: number;
  resultCount: number | null;
  requestedDepth: number;
  inspectedDepth: number | null;
  pagesRequested: number;
  resultCompleteness:
    | "partial"
    | "complete"
    | "target_found"
    | "insufficient_depth"
    | "not_applicable";
  dispatched: boolean;
  /** Whether circuit-breaker protection was active for this provider call. */
  circuitBreakerEnabled?: boolean;
  /** 1-based attempt within this provider's retry sequence. */
  attempt?: number;
  /** Configured maximum additional retries for this provider (0-5). */
  maxRetries?: number;
  /** Whether the failure that ended this call is classified retryable. */
  retryable?: boolean;
  /** Provider-supplied Retry-After (bounded) in ms, when present. */
  retryAfterMs?: number | null;
  skipReason?: SerpProviderSkipReason | null;
  circuitReason?: string | null;
  circuitOpenedAt?: string | null;
  circuitExpiresAt?: string | null;
};

export type NormalizedSerpResult = {
  keywordId: string;
  keyword: string;
  position: number | null;
  url: string | null;
  title: string | null;
  domain: string | null;
  serpFeatures: string[];
  provider: SerpProviderId;
  inspectedDepth: number;
  calls: SerpProviderCall[];
};

export class SerpProviderError extends Error {
  constructor(
    public readonly provider: SerpProviderId,
    public readonly code: string,
    public readonly calls: SerpProviderCall[],
    message: string,
    options: {
      deterministic?: boolean;
      /** Provider-supplied Retry-After wait in ms (already bounded), if any. */
      retryAfterMs?: number | null;
    } = {},
  ) {
    super(message);
    this.name = "SerpProviderError";
    this.deterministic = options.deterministic ?? false;
    this.retryAfterMs = options.retryAfterMs ?? null;
  }

  /** True when retrying the identical request can never succeed. */
  readonly deterministic: boolean;
  /** Provider-supplied Retry-After wait in ms (already bounded), if any. */
  readonly retryAfterMs: number | null;
}

export class SerpCancelledError extends Error {
  constructor(public readonly calls: SerpProviderCall[] = []) {
    super("Rank check cancelled");
    this.name = "AbortError";
  }
}

export interface SerpProvider {
  id: SerpProviderId;
  supports: (input: SerpSearchInput) => boolean;
  search: (input: SerpSearchInput) => Promise<NormalizedSerpResult>;
}

export async function assertNotCancelled(input: SerpSearchInput) {
  if (input.signal?.aborted || (await input.isCancelled?.())) {
    throw new SerpCancelledError();
  }
}

export function normalizedDomain(url: string): string | null {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return null;
  }
}

export function domainMatches(candidate: string, target: string): boolean {
  const normalizedTarget = target.toLowerCase().replace(/^www\./, "");
  return (
    candidate === normalizedTarget || candidate.endsWith(`.${normalizedTarget}`)
  );
}

/* ------------------------------------------------------------------ *
 * Competitive enrichment contract (spec 007). Additive to the frozen
 * SerpSnapshot model above — the snapshot shape itself is untouched.
 *
 * Required core metrics (Domain Rank, Page Rank, referring domains,
 * backlinks) decide the per-row status; optional metrics (estimated
 * traffic, spam/risk) render explicitly unavailable when the provider
 * omits them — never zero, never fabricated. Explicit provider-returned
 * zeros are valid values. ETV is keyword-scoped snapshot data and never
 * belongs in the target cache.
 * ------------------------------------------------------------------ */

/** Per-row enrichment status, derived ONLY from core-metric presence. */
export const serpEnrichmentStatuses = [
  "available",
  "partial",
  "unavailable",
  "failed",
] as const;
export type SerpEnrichmentStatus = (typeof serpEnrichmentStatuses)[number];

export const competitiveMetricsSchema = z
  .object({
    domainRank: z.number().nullish(),
    pageRank: z.number().nullish(),
    referringDomains: z.number().nullish(),
    backlinks: z.number().nullish(),
    estimatedTraffic: z.number().nullish(),
    spamScore: z.number().nullish(),
    status: z.enum(serpEnrichmentStatuses),
    provider: z.enum(["dataforseo", "serper", "zenserp"]).nullish(),
    /** Provider-snapshot time. Freshness policy must consult this, not fetch
     *  time alone (P19). */
    providerSnapshotAt: isoFullTimestamp.nullish(),
    /** OpenSEO observation time (fetch). */
    fetchedAt: isoFullTimestamp.nullish(),
    /** True when values come from a stale-cache fallback after a failed
     *  refresh (spec 007): last-known observation, not a fresh fact. Absent
     *  or false means fresh. */
    stale: z.boolean().nullish(),
  })
  .strict();
export type CompetitiveMetrics = z.infer<typeof competitiveMetricsSchema>;

/** One deduplicated Top-10 result target sent for metric resolution. */
export type EnrichmentTarget = {
  /** Normalized URL/domain identity shared across duplicate rows. */
  identity: string;
  /** Snapshot positions this target backs (display only — never identity). */
  sourcePositions: number[];
  /** Which provider call resolves this target. */
  metricFamily: "summary" | "domain_pages";
};

/**
 * Derive the row status from core-metric presence. Optional metrics never
 * decide the status; "failed" is set by the caller on the request/error
 * path, never derived here.
 */
export function enrichmentStatusOf(metrics: {
  domainRank?: number | null;
  pageRank?: number | null;
  referringDomains?: number | null;
  backlinks?: number | null;
}): Exclude<SerpEnrichmentStatus, "failed"> {
  const core = [
    metrics.domainRank,
    metrics.pageRank,
    metrics.referringDomains,
    metrics.backlinks,
  ];
  const present = core.filter(
    (value): value is number => typeof value === "number",
  ).length;
  if (present === core.length) return "available";
  if (present > 0) return "partial";
  return "unavailable";
}
