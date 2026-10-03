/* ------------------------------------------------------------------ *
 * SERP feature presentation derivation (spec 011, PR7 / S4–S5, S9).
 *
 *  Single display-model derivation over the frozen spec-003 contract
 *  (`SerpFeatureSet` in ./types.ts). This module NEVER re-normalizes
 *  provider payloads and never extends the stored schema — it maps
 *  observed families to ordered display blocks consumed by every
 *  SERP-reading surface (keywords analysis, rank-tracking chips/cards,
 *  mobile card view, MCP summaries).
 *
 *  Guarantees (see specs/011-serp-features-ui/contracts/):
 *  - Observed-only: one block per key PRESENT on the input (absent
 *    families stay absent — never fabricated, never probed from a
 *    fixed list).
 *  - Pass-through fidelity: block items are the stored items unchanged
 *    (exact duplicates swept defensively, logged).
 *  - Unknown keys are ignored + logged (defense in depth; the frozen
 *    `.strict()` schema rejects them at ingestion).
 *  - PAA placement honored (S9); never displaces organic positions.
 * ------------------------------------------------------------------ */
import type { SerpFeatureSet } from "./types";

export type { SerpFeatureSet };

/** Frozen family keys (spec 003, P14) in deterministic render order
 *  (spec 011 contract §order): featured first, related searches last. */
export const SERP_FAMILY_ORDER = [
  "featuredResult",
  "localPack",
  "peopleAlsoAsk",
  "images",
  "videos",
  "shopping",
  "news",
  "knowledgeGraph",
  "sitelinks",
  "relatedSearches",
] as const;
export type SerpFamilyKey = (typeof SERP_FAMILY_ORDER)[number];

/** Single shared display-label table (spec 011, S4). Every SERP-reading
 *  surface imports these labels — no per-surface FEATURE_* maps. */
export const SERP_FAMILY_LABELS: Record<SerpFamilyKey, string> = {
  featuredResult: "Featured snippet",
  peopleAlsoAsk: "People Also Ask",
  relatedSearches: "Related searches",
  localPack: "Local pack",
  images: "Images",
  videos: "Videos",
  shopping: "Shopping",
  news: "News",
  knowledgeGraph: "Knowledge panel",
  sitelinks: "Sitelinks",
};

/** Runtime field readers for display items (spec 011). Block items cross
 *  the server/client boundary as data — readers narrow them without type
 *  assertions, so unknown or malformed shapes render as absent, never crash. */
function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val);
}

export function stringField(item: unknown, key: string): string | null {
  if (!isRecord(item)) return null;
  const value = item[key];
  return typeof value === "string" ? value : null;
}

export function numberField(item: unknown, key: string): number | null {
  if (!isRecord(item)) return null;
  const value = item[key];
  return typeof value === "number" ? value : null;
}

/** Frozen family label for a stored feature ref, or null when the ref is
 *  not a frozen family (dropped, never rendered). */
export function familyLabelOf(ref: string): string | null {
  for (const key of SERP_FAMILY_ORDER) {
    if (key === ref) return SERP_FAMILY_LABELS[key];
  }
  return null;
}

/** Display label + order metadata for one observed feature family. */
export type SerpFeatureBlock = {
  family: SerpFamilyKey;
  label: string;
  order: number;
  /** Stored family items, passed through unchanged (see fidelity rule). */
  items: readonly unknown[];
  /** Recorded placement where the contract carries it (PAA), else null. */
  placement: number | null;
};

/** Map the stored feature set to ordered display blocks. */
export function toSerpFeatureBlocks(
  features: SerpFeatureSet,
): SerpFeatureBlock[] {
  // Defense in depth: the frozen `.strict()` schema rejects unknown families
  // at ingestion. A drift bug degrades to a logged drop here instead of
  // crashing a SERP view (spec FR-005).
  const known = new Set<string>(SERP_FAMILY_ORDER);
  for (const key of Object.keys(features)) {
    if (!known.has(key)) {
      console.warn(`serp: dropping unknown feature family "${key}"`);
    }
  }
  // Iterate the frozen order and pick keys PRESENT on the stored object —
  // never a probe list that invents — so absent families stay absent
  // (no fabrication, FR-002). Output is contract-ordered by construction.
  const blocks: SerpFeatureBlock[] = [];
  SERP_FAMILY_ORDER.forEach((family, order) => {
    const raw = features[family];
    if (raw === undefined) return;
    const items = sweepExactDuplicates(family, extractItems(raw));
    blocks.push({
      family,
      label: SERP_FAMILY_LABELS[family],
      order,
      items,
      placement: readPlacement(family, items),
    });
  });
  return blocks;
}

/** Family payloads are either `{ items }` (lists) or a bare object (the
 *  knowledge graph). Normalize to an item array without re-shaping items. */
function extractItems(raw: unknown): readonly unknown[] {
  if (Array.isArray(raw)) return raw;
  if (raw !== null && typeof raw === "object") {
    const items = (raw as { items?: unknown }).items;
    if (Array.isArray(items)) return items;
    return [raw];
  }
  return [];
}

/** Defensive exact-duplicate sweep. Dedupe is observational: every sweep is
 *  logged, never silent (spec edge case). */
function sweepExactDuplicates(
  family: string,
  items: readonly unknown[],
): readonly unknown[] {
  const seen = new Set<string>();
  const kept: unknown[] = [];
  let swept = 0;
  for (const item of items) {
    const key = JSON.stringify(item);
    if (seen.has(key)) {
      swept += 1;
      continue;
    }
    seen.add(key);
    kept.push(item);
  }
  if (swept > 0) {
    console.warn(
      `serp: swept ${swept} exact-duplicate item(s) from family "${family}"`,
    );
  }
  return kept;
}

/** PAA placement honored from the first item carrying a non-null placement
 *  (S9); null when absent (rendering falls back per the placement contract). */
function readPlacement(
  family: string,
  items: readonly unknown[],
): number | null {
  if (family !== "peopleAlsoAsk") return null;
  for (const item of items) {
    if (item !== null && typeof item === "object") {
      const placement = (item as { placement?: unknown }).placement;
      if (typeof placement === "number") return placement;
    }
  }
  return null;
}
