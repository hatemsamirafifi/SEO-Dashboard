/* ------------------------------------------------------------------ *
 * Live SERP → frozen feature-set normalization (spec 011, US1 wiring).
 *
 *  Maps already-fetched DataForSEO live items (non-organic element types)
 *  INTO the frozen spec-003 contract (`SerpFeatureSet`) at the keyword
 *  analysis seam. This is normalization at the boundary, not a parallel
 *  model: output keys are exactly the frozen families, and only OBSERVED
 *  items produce output — unmapped types are ignored, organic/paid items
 *  never become features, and no field is invented when absent.
 *
 *  No provider calls happen here (G10): the items are already in hand.
 *  Nested sitelinks under organic results are out of scope — the live
 *  advanced payload does not expose them as typed items, and inventing
 *  them from unknown nested shapes would violate the no-fabrication rule.
 * ------------------------------------------------------------------ */
import type { SerpLiveItem } from "@/server/lib/dataforseo/serp";
import type { SerpFeatureSet } from "./types";

/** Live-item element types that are never features (silently skipped). */
const NON_FEATURE_TYPES = new Set(["organic", "paid"]);

/** Map provider element types to frozen family keys. Unlisted types are
 *  ignored (never fabricated into features). */
function familyOf(type: string): keyof SerpFeatureSet | null {
  switch (type) {
    case "featured_snippet":
      return "featuredResult";
    case "people_also_ask":
      return "peopleAlsoAsk";
    case "related_searches":
      return "relatedSearches";
    case "local_pack":
      return "localPack";
    case "images":
      return "images";
    case "video":
    case "videos":
      return "videos";
    case "shopping":
      return "shopping";
    case "top_stories":
    case "news":
      return "news";
    case "knowledge_graph":
      return "knowledgeGraph";
    default:
      return null;
  }
}

function text(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function isoTimestampOrNull(value: unknown): string | null {
  if (typeof value !== "string" || !value.includes("T")) return null;
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function num(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

/** Read an optional passthrough extra (provider-specific enrichment of the
 *  item) without ever inventing a value. Spread-assignability keeps this
 *  assertion-free: unknown extras stay unknown. */
function extra(item: SerpLiveItem, key: string): unknown {
  const record: Record<string, unknown> = { ...item };
  return record[key];
}

type FamilyBuilder = (item: SerpLiveItem, out: SerpFeatureSet) => void;

function buildFeaturedResult(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (!out.featuredResult && item.title) {
    out.featuredResult = {
      title: item.title,
      url: item.url ?? null,
      domain: item.domain ?? null,
      snippet: item.description ?? "",
    };
  }
}

function buildPeopleAlsoAsk(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.peopleAlsoAsk ??= { items: [] };
    out.peopleAlsoAsk.items.push({
      question: item.title,
      url: item.url ?? null,
      placement: item.rank_absolute ?? null,
    });
  }
}

function buildRelatedSearches(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.relatedSearches ??= { items: [] };
    out.relatedSearches.items.push(item.title);
  }
}

function buildLocalPack(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.localPack ??= { items: [] };
    out.localPack.items.push({
      title: item.title,
      url: item.url ?? null,
      domain: item.domain ?? null,
      address: text(extra(item, "address")),
      rating: num(extra(item, "rating")),
      reviewCount: num(extra(item, "review_count")),
    });
  }
}

function buildMedia(
  family: "images" | "videos",
): (item: SerpLiveItem, out: SerpFeatureSet) => void {
  return (item, out) => {
    if (item.url) {
      out[family] ??= { items: [] };
      out[family].items.push({
        url: item.url,
        title: item.title ?? null,
        domain: item.domain ?? null,
      });
    }
  };
}

function buildShopping(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.shopping ??= { items: [] };
    out.shopping.items.push({
      title: item.title,
      url: item.url ?? null,
      domain: item.domain ?? null,
      price: text(extra(item, "price")),
    });
  }
}

function buildNews(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.news ??= { items: [] };
    out.news.items.push({
      title: item.title,
      url: item.url ?? null,
      domain: item.domain ?? null,
      sourceName: text(extra(item, "source_name")),
      // The frozen contract requires full ISO timestamps: pass the provider
      // value through only when it parses with a time component, else null
      // (never an invalid string).
      publishedAt: isoTimestampOrNull(extra(item, "timestamp")),
    });
  }
}

function buildKnowledgeGraph(item: SerpLiveItem, out: SerpFeatureSet): void {
  if (item.title) {
    out.knowledgeGraph ??= {
      title: item.title,
      url: item.url ?? null,
      domain: item.domain ?? null,
      description: item.description ?? null,
    };
  }
}

/** One builder per mapped family. `sitelinks` has no builder: no live typed
 *  sitelink items are observed, and nested sitelinks under organic results
 *  are never populated from unknown nested shapes (no fabrication). */
const FAMILY_BUILDERS: Partial<Record<keyof SerpFeatureSet, FamilyBuilder>> = {
  featuredResult: buildFeaturedResult,
  peopleAlsoAsk: buildPeopleAlsoAsk,
  relatedSearches: buildRelatedSearches,
  localPack: buildLocalPack,
  images: buildMedia("images"),
  videos: buildMedia("videos"),
  shopping: buildShopping,
  news: buildNews,
  knowledgeGraph: buildKnowledgeGraph,
};

export function mapLiveItemsToFeatureSet(
  items: SerpLiveItem[],
): SerpFeatureSet {
  const features: SerpFeatureSet = {};
  const unmapped = new Set<string>();
  for (const item of items) {
    if (NON_FEATURE_TYPES.has(item.type)) continue;
    const family = familyOf(item.type);
    const build = family === null ? undefined : FAMILY_BUILDERS[family];
    if (family === null || build === undefined) {
      unmapped.add(item.type);
      continue;
    }
    build(item, features);
  }
  if (unmapped.size > 0) {
    // Trace entry per spec FR-005: unmapped types are ignored, not rendered.
    console.warn(
      `serp: ignoring unmapped live item types: ${[...unmapped].toSorted().join(", ")}`,
    );
  }
  return features;
}
