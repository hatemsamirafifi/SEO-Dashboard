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
    site_engine_id: z.coerce.number().int().positive().nullable().optional(),
    id: z.coerce.number().int().positive().nullable().optional(),
    search_engine_id: z.coerce.number().int().positive().nullable().optional(),
    se_id: z.coerce.number().int().positive().nullable().optional(),
    engine_id: z.coerce.number().int().positive().nullable().optional(),
    name: z.string().nullable().optional(),
    region_id: z.coerce.number().nullable().optional().default(0),
    region_name: z.string().nullable().optional(),
    lang_code: z.string().nullable().optional(),
    device: z.string().nullable().optional(),
  })
  .passthrough()
  .transform((data) => ({
    siteEngineId: data.site_engine_id ?? data.id ?? 0,
    searchEngineId: data.search_engine_id ?? data.se_id ?? data.engine_id ?? 0,
    name: data.name ?? "",
    regionId: data.region_id ?? 0,
    regionName: data.region_name ?? "",
    langCode: data.lang_code ?? "",
    device: data.device ?? "",
  }));

export type SeRankingSiteEngine = z.infer<typeof seRankingSiteEngineSchema>;

// Project Keyword (string-normalized ID preserved cleanly without precision loss)
export const seRankingProjectKeywordSchema = z
  .object({
    id: seRemoteKeywordIdSchema,
    name: z.string().nullable().optional(),
    keyword: z.string().nullable().optional(),
    group_id: z.coerce.number().nullable().optional(),
    target_url: z.string().nullable().optional(),
    site_engine_ids: z.array(z.coerce.number()).nullable().optional(),
  })
  .passthrough()
  .transform((data) => ({
    id: data.id,
    keyword: data.name ?? data.keyword ?? "",
    groupId: data.group_id ?? undefined,
    targetUrl: data.target_url ?? undefined,
    siteEngineIds: data.site_engine_ids ?? [],
  }));

export type SeRankingProjectKeyword = {
  id: string;
  keyword: string;
  groupId?: number;
  targetUrl?: string;
  siteEngineIds: number[];
};

export interface ExtractedLandingPage {
  url: string | null;
  date: string | null;
}

/**
 * Extracts landing page URL and its observation date, matching against targetDate
 * when multiple dated landing page records exist in SE Ranking.
 */
export function extractLandingPage(
  raw: unknown,
  targetDate?: string,
): ExtractedLandingPage {
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    return { url: trimmed.length > 0 ? trimmed : null, date: null };
  }

  if (Array.isArray(raw)) {
    const withDates: Array<{ url: string; date: string }> = [];
    const withoutDates: string[] = [];

    for (const entry of raw) {
      if (typeof entry === "string") {
        const trimmed = entry.trim();
        if (trimmed) withoutDates.push(trimmed);
      } else if (entry && typeof entry === "object") {
        const rec = entry as Record<string, unknown>;
        const u =
          typeof rec.url === "string" && rec.url.trim().length > 0
            ? rec.url.trim()
            : typeof rec.landing_page === "string" &&
                rec.landing_page.trim().length > 0
              ? rec.landing_page.trim()
              : null;
        const d = typeof rec.date === "string" ? rec.date.slice(0, 10) : null;
        if (u && d) {
          withDates.push({ url: u, date: d });
        } else if (u) {
          withoutDates.push(u);
        }
      }
    }

    if (withDates.length > 0) {
      if (targetDate) {
        const exact = withDates.find((item) => item.date === targetDate);
        if (exact) return exact;

        const prior = withDates
          .filter((item) => item.date <= targetDate)
          .toSorted((a, b) => a.date.localeCompare(b.date))
          .at(-1);
        if (prior) return prior;
      }
      return withDates.toSorted((a, b) => a.date.localeCompare(b.date)).at(-1)!;
    }

    if (withoutDates.length > 0) {
      return { url: withoutDates[0], date: null };
    }

    return { url: null, date: null };
  }

  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    const u =
      typeof rec.url === "string" && rec.url.trim().length > 0
        ? rec.url.trim()
        : typeof rec.landing_page === "string" &&
            rec.landing_page.trim().length > 0
          ? rec.landing_page.trim()
          : null;
    const d = typeof rec.date === "string" ? rec.date.slice(0, 10) : null;
    return { url: u && u.length > 0 ? u : null, date: d };
  }

  return { url: null, date: null };
}

export function extractLandingUrl(
  raw: unknown,
  targetDate?: string,
): string | null {
  return extractLandingPage(raw, targetDate).url;
}

export function normalizeSerpFeatures(raw: unknown): string[] {
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

export const sePositionEntrySchema = z
  .object({
    date: z.string().optional(),
    pos: z.coerce.number().nullable().optional(),
    position: z.coerce.number().nullable().optional(),
    depth: z.coerce.number().nullable().optional(),
    is_checked: z.coerce.number().nullable().optional(),
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
    depth: z.coerce.number().nullable().optional(),
    is_checked: z.coerce.number().nullable().optional(),
    change: z.coerce.number().nullable().optional(),
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
