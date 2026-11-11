import { z } from "zod";
import { AppError } from "@/server/lib/errors";

/**
 * Normalizes a remote SE Ranking keyword ID to a string without precision loss.
 * SE Ranking list endpoints can return string IDs (including large 64-bit numeric strings),
 * whereas numeric write endpoints validate safe integers at conversion time.
 */
export const seRemoteKeywordIdSchema = z
  .union([z.string(), z.number()])
  .transform((val, ctx) => {
    if (typeof val === "number") {
      if (!Number.isSafeInteger(val) || val < 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Unsafe numeric SE Ranking keyword ID: ${String(val)}`,
        });
        return z.NEVER;
      }
      return String(val);
    }
    const trimmed = val.trim();
    if (trimmed.length === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "SE Ranking keyword ID cannot be empty",
      });
      return z.NEVER;
    }
    return trimmed;
  });

/**
 * Validates and converts a stored normalized string keyword ID to a numeric integer
 * at SE Ranking write-endpoint boundaries.
 */
export function toNumericRemoteKeywordId(rawId: string): number {
  const trimmed = rawId.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `SE Ranking write endpoint requires a numeric keyword ID, got "${rawId}"`,
    );
  }
  const num = Number(trimmed);
  if (!Number.isSafeInteger(num)) {
    throw new AppError(
      "VALIDATION_ERROR",
      `SE Ranking keyword ID "${rawId}" exceeds safe integer precision`,
    );
  }
  return num;
}

// Schema for Project (Site) in SE Ranking
export const seRankingSiteSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    title: z.string().optional().default(""),
    url: z.string().optional(),
    name: z.string().optional(),
    depth: z.coerce.number().optional().default(100),
    subdomain_match: z.coerce.number().optional().default(0),
    exact_url: z.coerce.number().optional().default(0),
    keyword_count: z.coerce.number().optional().default(0),
    check_frequency: z.string().optional(),
    check_freq: z.string().optional(),
    status: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    id: data.id,
    title: data.title || data.name || "",
    url: data.url || data.name || "",
    depth: data.depth,
    keywordCount: data.keyword_count,
    checkFrequency: data.check_frequency ?? data.check_freq,
    status: data.status,
  }));

export type SeRankingSite = z.infer<typeof seRankingSiteSchema>;

// Catalog Search Engine
export const seRankingSystemEngineSchema = z
  .object({
    id: z.coerce.number().int().positive(),
    name: z.string(),
    regionid: z.coerce.number().optional().default(0),
    country_code: z.string().optional(),
    is_mobile: z.coerce.number().optional(),
  })
  .passthrough();

export type SeRankingSystemEngine = z.infer<typeof seRankingSystemEngineSchema>;

// Project Search Engine Configuration
export const seRankingSiteEngineSchema = z
  .object({
    site_engine_id: z.coerce.number().int().positive().optional(),
    id: z.coerce.number().int().positive().optional(),
    search_engine_id: z.coerce.number().int().positive(),
    name: z.string().optional(),
    region_id: z.coerce.number().optional().default(0),
    region_name: z.string().optional(),
    lang_code: z.string().optional(),
    device: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    siteEngineId: data.site_engine_id ?? data.id ?? 0,
    searchEngineId: data.search_engine_id,
    name: data.name ?? "",
    regionId: data.region_id,
    regionName: data.region_name ?? "",
    langCode: data.lang_code ?? "",
    device: data.device ?? "",
  }));

export type SeRankingSiteEngine = z.infer<typeof seRankingSiteEngineSchema>;

// Project Keyword (string-normalized ID preserved cleanly without precision loss)
export const seRankingProjectKeywordSchema = z
  .object({
    id: seRemoteKeywordIdSchema,
    name: z.string().optional(),
    keyword: z.string().optional(),
    group_id: z.coerce.number().optional(),
    target_url: z.string().optional(),
  })
  .passthrough()
  .transform((data) => ({
    id: data.id,
    keyword: data.name ?? data.keyword ?? "",
    groupId: data.group_id,
    targetUrl: data.target_url,
  }));

export type SeRankingProjectKeyword = z.infer<
  typeof seRankingProjectKeywordSchema
>;

function extractLandingUrl(raw: unknown): string | null {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const candidate = extractLandingUrl(item);
      if (candidate) return candidate;
    }
    return null;
  }
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.url === "string" && rec.url.trim().length > 0) {
      return rec.url.trim();
    }
    if (
      typeof rec.landing_page === "string" &&
      rec.landing_page.trim().length > 0
    ) {
      return rec.landing_page.trim();
    }
  }
  return null;
}

function normalizeSerpFeatures(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  const features: string[] = [];
  for (const entry of raw) {
    if (typeof entry === "string" && entry.trim().length > 0) {
      features.push(entry.trim());
    } else if (entry && typeof entry === "object") {
      const rec = entry as Record<string, unknown>;
      const label = rec.type ?? rec.name ?? rec.code;
      if (typeof label === "string" && label.trim().length > 0) {
        features.push(label.trim());
      }
    }
  }
  return features;
}

const sePositionEntrySchema = z
  .object({
    date: z.string().optional(),
    pos: z.coerce.number().nullable().optional(),
    position: z.coerce.number().nullable().optional(),
    change: z.coerce.number().nullable().optional(),
    landing_page: z.string().nullable().optional(),
    landing_pages: z.unknown().optional(),
    url: z.string().nullable().optional(),
    serp_features: z.unknown().optional(),
  })
  .passthrough();

export type SeRankingPositionEntry = z.infer<typeof sePositionEntrySchema>;

// Position Observation item returned by GET /project-management/sites/positions
export const seRankingPositionItemSchema = z
  .object({
    keyword_id: seRemoteKeywordIdSchema.optional(),
    id: seRemoteKeywordIdSchema.optional(),
    site_engine_id: z.coerce.number().int().positive().optional(),
    name: z.string().optional(),
    keyword: z.string().optional(),
    position: z.coerce.number().nullable().optional(),
    pos: z.coerce.number().nullable().optional(),
    landing_page: z.string().nullable().optional(),
    landing_pages: z.unknown().optional(),
    url: z.string().nullable().optional(),
    date: z.string().optional(),
    serp_features: z.unknown().optional(),
    positions: z.unknown().optional(),
  })
  .passthrough()
  .transform((data) => ({
    ...data,
    normalizedKeywordId: data.keyword_id ?? data.id ?? null,
    normalizedKeyword: (data.keyword ?? data.name ?? "").trim(),
    serpFeaturesList: normalizeSerpFeatures(data.serp_features),
  }));

export type SeRankingPositionItem = z.infer<typeof seRankingPositionItemSchema>;

export const seRankingSiteEnginePositionsSchema = z
  .object({
    site_engine_id: z.coerce.number().optional(),
    id: z.coerce.number().optional(),
    keywords: z.array(seRankingPositionItemSchema).optional().default([]),
  })
  .passthrough();

export type SeRankingSiteEnginePositions = z.infer<
  typeof seRankingSiteEnginePositionsSchema
>;

export interface NormalizedSeRankingObservation {
  observed: boolean;
  /** Positive integer rank position, or null when unranked (including pos=0). */
  position: number | null;
  url: string | null;
  serpFeatures: string[];
  observedDate: string | null;
}

function normalizePosValue(rawPos: number | null | undefined): number | null {
  if (rawPos === null || rawPos === undefined || !Number.isFinite(rawPos)) {
    return null;
  }
  // SE Ranking represents "not in top SERP results" as 0.
  if (rawPos <= 0) return null;
  return Math.trunc(rawPos);
}

/**
 * Extracts a single per-keyword ranking observation from GET /sites/positions
 * for a given check date (`YYYY-MM-DD`). Prevents pending/missing observations from
 * being misclassified as NO_RESULT, and converts SE Ranking `pos: 0` to `null`.
 */
export function extractPositionObservation(
  item: SeRankingPositionItem,
  targetDate?: string,
): NormalizedSeRankingObservation {
  // 1. Inspect `positions` array or date-keyed object (official GET /sites/positions format)
  if (Array.isArray(item.positions)) {
    const entries: SeRankingPositionEntry[] = [];
    for (const rawEntry of item.positions) {
      const parsed = sePositionEntrySchema.safeParse(rawEntry);
      if (parsed.success) entries.push(parsed.data);
    }

    const match = targetDate
      ? entries.find((e) => e.date?.slice(0, 10) === targetDate)
      : entries.at(-1);

    if (match) {
      const rawPos = match.pos ?? match.position;
      const entryFeatures = normalizeSerpFeatures(match.serp_features);
      return {
        observed: rawPos !== undefined && rawPos !== null,
        position: normalizePosValue(rawPos),
        url:
          extractLandingUrl(match.landing_page) ??
          extractLandingUrl(match.landing_pages) ??
          extractLandingUrl(match.url) ??
          extractLandingUrl(item.landing_page) ??
          extractLandingUrl(item.url),
        serpFeatures:
          entryFeatures.length > 0 ? entryFeatures : item.serpFeaturesList,
        observedDate: match.date?.slice(0, 10) ?? targetDate ?? null,
      };
    }

    // If positions array exists cleanly for other dates but not targetDate, check is still pending.
    if (targetDate) {
      return {
        observed: false,
        position: null,
        url: null,
        serpFeatures: [],
        observedDate: null,
      };
    }
  } else if (item.positions && typeof item.positions === "object") {
    const entries = Object.entries(item.positions);
    const chosen = targetDate
      ? entries.find(([key]) => key.slice(0, 10) === targetDate)
      : entries.toSorted(([a], [b]) => a.localeCompare(b)).at(-1);
    if (chosen) {
      const [dateKey, rawEntry] = chosen;
      const parsed = sePositionEntrySchema.safeParse(rawEntry);
      if (parsed.success) {
        const rawPos = parsed.data.pos ?? parsed.data.position;
        const entryFeatures = normalizeSerpFeatures(parsed.data.serp_features);
        return {
          observed: rawPos !== undefined && rawPos !== null,
          position: normalizePosValue(rawPos),
          url:
            extractLandingUrl(parsed.data.landing_page) ??
            extractLandingUrl(parsed.data.landing_pages) ??
            extractLandingUrl(parsed.data.url),
          serpFeatures:
            entryFeatures.length > 0 ? entryFeatures : item.serpFeaturesList,
          observedDate: dateKey.slice(0, 10),
        };
      }
    }
    if (targetDate) {
      return {
        observed: false,
        position: null,
        url: null,
        serpFeatures: [],
        observedDate: null,
      };
    }
  }

  // 2. Direct/flat fallback item shape (when item carries position/pos at top level)
  const flatDate = item.date?.slice(0, 10);
  if (targetDate && flatDate && flatDate !== targetDate) {
    return {
      observed: false,
      position: null,
      url: null,
      serpFeatures: [],
      observedDate: null,
    };
  }

  const flatPos = item.position !== undefined ? item.position : item.pos;
  const hasFlatObservation =
    flatPos !== undefined ||
    item.landing_page !== undefined ||
    item.url !== undefined ||
    item.date !== undefined;

  return {
    observed: hasFlatObservation,
    position: normalizePosValue(flatPos),
    url:
      extractLandingUrl(item.landing_page) ??
      extractLandingUrl(item.landing_pages) ??
      extractLandingUrl(item.url),
    serpFeatures: item.serpFeaturesList,
    observedDate: flatDate ?? targetDate ?? null,
  };
}
