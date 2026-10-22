/**
 * KV-based live crawl progress.
 *
 * During a crawl, each crawled URL is appended to a KV key so the UI can
 * poll for a live feed of crawled pages (most recent first).
 *
 * The KV entry auto-expires after 30 minutes — it's only needed while
 * the audit is running. Once finalized, we explicitly delete it.
 */
import { env } from "cloudflare:workers";
import { z } from "zod";
import { jsonCodec } from "@/shared/json";

const KV_PREFIX = "audit-progress:";
const TTL_SECONDS = 30 * 60; // 30 minutes
const MAX_ENTRIES = 300;

const crawledUrlEntrySchema = z.object({
  url: z.string(),
  statusCode: z.number(),
  title: z.string(),
  /** Unix timestamp ms when this page was crawled */
  crawledAt: z.number(),
});

type CrawledUrlEntry = z.infer<typeof crawledUrlEntrySchema>;

const crawledEntriesCodec = jsonCodec(z.array(crawledUrlEntrySchema));

function parseCrawledEntries(json: string | null): CrawledUrlEntry[] {
  if (!json) return [];
  const parsed = crawledEntriesCodec.safeParse(json);
  return parsed.success ? parsed.data : [];
}

function key(auditId: string): string {
  return `${KV_PREFIX}${auditId}`;
}

// --- Adaptive crawl pacing state (throttle + window) ---

const crawlStateSchema = z.object({
  throttle: z.object({
    intervalMs: z.number(),
    nextRequestAt: z.number(),
    pausedUntil: z.number(),
    consecutiveRateLimits: z.number(),
    cooldownMs: z.number(),
  }),
  windowSize: z.number().int(),
});

type CrawlRuntimeState = z.infer<typeof crawlStateSchema>;

const crawlStateCodec = jsonCodec(crawlStateSchema);

const crawlStateKey = (auditId: string) => `${KV_PREFIX}runtime:${auditId}`;

async function loadCrawlState(
  auditId: string,
): Promise<CrawlRuntimeState | null> {
  const data = await env.KV.get(crawlStateKey(auditId), "text");
  if (!data) return null;
  const parsed = crawlStateCodec.safeParse(data);
  return parsed.success ? parsed.data : null;
}

async function saveCrawlState(
  auditId: string,
  state: CrawlRuntimeState,
): Promise<void> {
  await env.KV.put(crawlStateKey(auditId), crawlStateCodec.encode(state), {
    expirationTtl: TTL_SECONDS,
  });
}

// --- Sitemap membership + discovery coverage ---
//
// The full sitemap URL set outlives the frontier's seed cap (Workflows step
// state must stay under ~1MiB, but membership must answer "is this page in
// the sitemap" for URLs the crawl reaches by link, past the cap). Bounded by
// discovery's maxDiscoveredUrls (≤50k URLs ≈ ~5MB JSON, within KV's 25MB
// value limit).

const discoveryCoverageSchema = z.object({
  robotsDeclaredSitemaps: z.number().int(),
  sitemapDocsFetched: z.number().int(),
  sitemapDocsFailed: z.number().int(),
  sitemapDocsTimedOut: z.number().int(),
  urlsFromSitemaps: z.number().int(),
  sitemapDocCapReached: z.boolean(),
  urlCapReached: z.boolean(),
});

const sitemapMembershipSchema = z.object({
  urls: z.array(z.string()),
  coverage: discoveryCoverageSchema,
});

type SitemapMembership = z.infer<typeof sitemapMembershipSchema>;

const sitemapMembershipCodec = jsonCodec(sitemapMembershipSchema);

const sitemapMembershipKey = (auditId: string) =>
  `${KV_PREFIX}sitemap:${auditId}`;

async function saveSitemapMembership(
  auditId: string,
  membership: SitemapMembership,
): Promise<void> {
  await env.KV.put(
    sitemapMembershipKey(auditId),
    sitemapMembershipCodec.encode(membership),
    { expirationTtl: TTL_SECONDS },
  );
}

async function loadSitemapMembership(
  auditId: string,
): Promise<SitemapMembership | null> {
  const data = await env.KV.get(sitemapMembershipKey(auditId), "text");
  if (!data) return null;
  const parsed = sitemapMembershipCodec.safeParse(data);
  return parsed.success ? parsed.data : null;
}

/**
 * Append multiple crawled URL entries in one KV write.
 * New entries are prepended and the list is capped.
 */
async function pushCrawledUrls(
  auditId: string,
  nextEntries: CrawledUrlEntry[],
): Promise<void> {
  if (nextEntries.length === 0) return;

  const k = key(auditId);
  const existing = await env.KV.get(k, "text");
  const entries = parseCrawledEntries(existing);
  const merged = [...nextEntries, ...entries].slice(0, MAX_ENTRIES);

  await env.KV.put(k, JSON.stringify(merged), {
    expirationTtl: TTL_SECONDS,
  });
}

/**
 * Read all crawled URL entries for a running audit.
 * Returns newest-first.
 */
async function getCrawledUrls(auditId: string): Promise<CrawledUrlEntry[]> {
  const data = await env.KV.get(key(auditId), "text");
  return parseCrawledEntries(data);
}

/**
 * Delete the progress keys (called after audit completes).
 */
async function clear(auditId: string): Promise<void> {
  await env.KV.delete(key(auditId));
  await env.KV.delete(crawlStateKey(auditId));
  await env.KV.delete(sitemapMembershipKey(auditId));
}

export const AuditProgressKV = {
  pushCrawledUrls,
  getCrawledUrls,
  loadCrawlState,
  saveCrawlState,
  saveSitemapMembership,
  loadSitemapMembership,
  clear,
} as const;
