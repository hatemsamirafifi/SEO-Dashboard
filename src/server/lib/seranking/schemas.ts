import { z } from "zod";

export const seRankingHistoryTrendItemSchema = z.object({
  date: z.string(),
  volume: z.coerce.number().default(0),
});

export const seRankingHistoryTrendSchema = z
  .union([
    z.array(seRankingHistoryTrendItemSchema),
    z.record(z.string(), z.coerce.number()).transform((record) =>
      Object.entries(record).map(([date, volume]) => ({
        date,
        volume: Number(volume) || 0,
      })),
    ),
  ])
  .optional()
  .default([]);

export function mapSeRankingIntent(raw: unknown): string | null {
  if (raw == null) return null;
  const items = Array.isArray(raw) ? raw : [raw];
  for (const item of items) {
    const val = String(item).trim().toLowerCase();
    if (val === "i" || val === "1" || val.includes("inform")) return "informational";
    if (val === "c" || val === "3" || val.includes("commerc")) return "commercial";
    if (val === "t" || val === "4" || val.includes("transact")) return "transactional";
    if (val === "n" || val === "2" || val.includes("navig")) return "navigational";
  }
  return null;
}

const seRankingSubscriptionInfoSchema = z.object({
  status: z.string().optional(),
  start_date: z.string().optional(),
  expiration_date: z.string().optional(),
  units_limit: z.coerce.number().optional(),
  units_left: z.coerce.number().optional(),
});

export const seRankingSubscriptionSchema = z
  .object({
    subscription_info: seRankingSubscriptionInfoSchema.optional(),
    status: z.string().optional(),
    start_date: z.string().optional(),
    expiration_date: z.string().optional(),
    units_limit: z.coerce.number().optional(),
    units_left: z.coerce.number().optional(),
  })
  .passthrough()
  .refine(
    (data) =>
      Boolean(
        data.subscription_info?.status ||
          data.subscription_info?.units_left !== undefined ||
          data.status ||
          data.units_left !== undefined,
      ),
    {
      message:
        "Invalid SE Ranking subscription response: expected subscription_info or status/units_left",
    },
  )
  .transform((data) => {
    const sub = data.subscription_info;
    const status = sub?.status ?? data.status ?? "active";
    const units_left = sub?.units_left ?? data.units_left ?? 0;
    const units_limit = sub?.units_limit ?? data.units_limit ?? units_left;
    const start_date = sub?.start_date ?? data.start_date;
    const expiration_date = sub?.expiration_date ?? data.expiration_date;

    return {
      status,
      start_date,
      expiration_date,
      units_limit,
      units_left,
    };
  });

export const seRankingKeywordExportItemSchema = z
  .object({
    keyword: z.string(),
    volume: z.coerce.number().nullable().optional().default(null),
    cpc: z.coerce.number().nullable().optional().default(null),
    competition: z.coerce.number().nullable().optional().default(null),
    difficulty: z.coerce.number().nullable().optional().default(null),
    intent: z.unknown().optional().transform(mapSeRankingIntent),
    intents: z.unknown().optional(),
    history_trend: seRankingHistoryTrendSchema,
  })
  .transform((item) => ({
    keyword: item.keyword,
    volume: item.volume,
    cpc: item.cpc,
    competition: item.competition,
    difficulty: item.difficulty,
    intent: item.intent ?? mapSeRankingIntent(item.intents),
    history_trend: item.history_trend,
  }));

export const seRankingKeywordSuggestionItemSchema = z
  .object({
    keyword: z.string(),
    volume: z.coerce.number().nullable().optional().default(null),
    cpc: z.coerce.number().nullable().optional().default(null),
    competition: z.coerce.number().nullable().optional().default(null),
    difficulty: z.coerce.number().nullable().optional().default(null),
    intent: z.unknown().optional().transform(mapSeRankingIntent),
    intents: z.unknown().optional(),
    history_trend: seRankingHistoryTrendSchema,
  })
  .transform((item) => ({
    keyword: item.keyword,
    volume: item.volume,
    cpc: item.cpc,
    competition: item.competition,
    difficulty: item.difficulty,
    intent: item.intent ?? mapSeRankingIntent(item.intents),
    history_trend: item.history_trend,
  }));

export const seRankingDomainOverviewSectionSchema = z.object({
  base_domain: z.string().optional(),
  target: z.string().optional(),
  keywords_count: z.coerce.number().nullable().optional().default(null),
  traffic_sum: z.coerce.number().nullable().optional().default(null),
  price_sum: z.coerce.number().nullable().optional().default(null),
});

export const seRankingDomainOverviewSchema = z.object({
  organic: seRankingDomainOverviewSectionSchema.optional(),
  adv: seRankingDomainOverviewSectionSchema.optional(),
});

export const seRankingDomainKeywordItemSchema = z.object({
  keyword: z.string(),
  position: z.coerce.number(),
  prev_position: z.coerce.number().nullable().optional().default(null),
  volume: z.coerce.number().nullable().optional().default(null),
  cpc: z.coerce.number().nullable().optional().default(null),
  url: z.string().nullable().optional().default(null),
  traffic: z.coerce.number().nullable().optional().default(null),
  difficulty: z.coerce.number().nullable().optional().default(null),
  intent: z
    .union([z.string(), z.array(z.string())])
    .nullable()
    .optional()
    .transform((val) => (Array.isArray(val) ? val.join(", ") : val ?? null)),
});

export const seRankingDomainPageItemSchema = z.object({
  url: z.string(),
  traffic: z.coerce.number().nullable().optional().default(null),
  keywords_count: z.coerce.number().nullable().optional().default(null),
});

export const seRankingDomainCompetitorItemSchema = z.object({
  domain: z.string(),
  keywords_count: z.coerce.number().nullable().optional().default(null),
  common_keywords: z.coerce.number().nullable().optional().default(null),
  traffic: z.coerce.number().nullable().optional().default(null),
  total_keywords: z.coerce.number().nullable().optional().default(null),
  avg_position: z.coerce.number().nullable().optional().default(null),
  visibility: z.coerce.number().nullable().optional().default(null),
});

export const seRankingBacklinksSummarySchema = z.object({
  target: z.string(),
  mode: z.string().optional(),
  total_backlinks: z.coerce.number().default(0),
  referring_domains: z.coerce.number().default(0),
  referring_ips: z.coerce.number().nullable().optional().default(null),
  referring_subnets: z.coerce.number().nullable().optional().default(null),
  dofollow: z.coerce.number().nullable().optional().default(null),
  nofollow: z.coerce.number().nullable().optional().default(null),
  domain_inlink_rank: z.coerce.number().nullable().optional().default(null),
  new_backlinks: z.coerce.number().nullable().optional().default(null),
  lost_backlinks: z.coerce.number().nullable().optional().default(null),
  text_links: z.coerce.number().nullable().optional().default(null),
  image_links: z.coerce.number().nullable().optional().default(null),
  redirect_links: z.coerce.number().nullable().optional().default(null),
});

export const seRankingReferringDomainItemSchema = z.object({
  domain: z.string(),
  backlinks: z.coerce.number().default(0),
  inlink_rank: z.coerce.number().nullable().optional().default(null),
  dofollow: z.coerce.number().nullable().optional().default(null),
  nofollow: z.coerce.number().nullable().optional().default(null),
  first_seen: z.string().nullable().optional().default(null),
  last_seen: z.string().nullable().optional().default(null),
});

export const seRankingBacklinkItemSchema = z.object({
  source_url: z.string(),
  target_url: z.string(),
  anchor: z.string().nullable().optional().default(null),
  inlink_rank: z.coerce.number().nullable().optional().default(null),
  dofollow: z.coerce.boolean().nullable().optional().default(null),
  first_seen: z.string().nullable().optional().default(null),
  last_seen: z.string().nullable().optional().default(null),
});

export const seRankingBacklinkPageItemSchema = z.object({
  url: z.string(),
  backlinks: z.coerce.number().default(0),
  referring_domains: z.coerce.number().nullable().optional().default(null),
  inlink_rank: z.coerce.number().nullable().optional().default(null),
});

export const seRankingBacklinksHistoryItemSchema = z
  .object({
    date: z.string(),
    count: z.coerce.number().nullable().optional().default(null),
    backlinks: z.coerce.number().nullable().optional().default(null),
    referring_domains: z.coerce.number().nullable().optional().default(null),
    new: z.coerce.number().nullable().optional().default(null),
    lost: z.coerce.number().nullable().optional().default(null),
    new_backlinks: z.coerce.number().nullable().optional().default(null),
    lost_backlinks: z.coerce.number().nullable().optional().default(null),
    new_referring_domains: z.coerce.number().nullable().optional().default(null),
    lost_referring_domains: z.coerce.number().nullable().optional().default(null),
    inlink_rank: z.coerce.number().nullable().optional().default(null),
  })
  .passthrough();

export const seRankingAuthorityHistoryItemSchema = z
  .object({
    date: z.string(),
    inlink_rank: z.coerce.number().nullable().optional().default(null),
    trust_score: z.coerce.number().nullable().optional().default(null),
  })
  .passthrough();
