import {
  seRankingProjectKeywordSchema,
  seRankingPositionItemSchema,
  sePositionEntrySchema,
  extractLandingPage,
  normalizeSerpFeatures,
  type SeRankingProjectKeyword,
  type SeRankingPositionItem,
  type SeRankingPositionEntry,
} from "./projectSchemas";

export interface NormalizedSeRankingObservation {
  observed: boolean;
  /** Positive integer rank position, or null when unranked (including pos=0). */
  position: number | null;
  url: string | null;
  serpFeatures: string[];
  observedDate: string | null;
  landingPageDate?: string | null;
  providerChange?: number | null;
}

function normalizePosValue(rawPos: number | null | undefined): number | null {
  if (rawPos === null || rawPos === undefined || !Number.isFinite(rawPos)) {
    return null;
  }
  // SE Ranking represents "not in top SERP results" as 0.
  if (rawPos <= 0) return null;
  return Math.trunc(rawPos);
}

function findPositionEntry(
  positions: unknown,
  targetDate?: string,
): { entry: SeRankingPositionEntry; date: string } | null {
  if (Array.isArray(positions)) {
    const entries: SeRankingPositionEntry[] = [];
    for (const rawEntry of positions) {
      const parsed = sePositionEntrySchema.safeParse(rawEntry);
      if (parsed.success) entries.push(parsed.data);
    }

    const match = targetDate
      ? entries.find((e) => e.date?.slice(0, 10) === targetDate)
      : entries.at(-1);

    if (match) {
      return {
        entry: match,
        date: match.date?.slice(0, 10) ?? targetDate ?? "",
      };
    }
    return null;
  }

  if (positions && typeof positions === "object") {
    const entries = Object.entries(positions);
    const chosen = targetDate
      ? entries.find(([key]) => key.slice(0, 10) === targetDate)
      : entries.toSorted(([a], [b]) => a.localeCompare(b)).at(-1);

    if (chosen) {
      const [dateKey, rawEntry] = chosen;
      const parsed = sePositionEntrySchema.safeParse(rawEntry);
      if (parsed.success) {
        return {
          entry: parsed.data,
          date: dateKey.slice(0, 10),
        };
      }
    }
    return null;
  }

  return null;
}

function buildObservationFromEntry(
  entry: SeRankingPositionEntry,
  date: string,
  item: SeRankingPositionItem,
  targetDate?: string,
): NormalizedSeRankingObservation {
  const rawPos = entry.pos ?? entry.position;
  // Distinguish checked-but-not-ranked from missing or not-yet-checked data:
  // If entry.depth is explicitly 0, or is_checked is explicitly 0, or rawPos is null/undefined,
  // the provider has not actually performed a crawl on this keyword-engine for this date.
  const isAwaitingCrawl =
    (entry.depth !== undefined && entry.depth !== null && entry.depth === 0) ||
    (entry.is_checked !== undefined &&
      entry.is_checked !== null &&
      entry.is_checked === 0);

  const isObserved =
    !isAwaitingCrawl && rawPos !== undefined && rawPos !== null;

  const entryFeatures = normalizeSerpFeatures(entry.serp_features);
  const lpCandidate =
    entry.landing_page ??
    entry.landing_pages ??
    entry.url ??
    item.landing_page ??
    item.landing_pages ??
    item.url;
  const lp = extractLandingPage(lpCandidate, targetDate);

  return {
    observed: isObserved,
    position: isObserved ? normalizePosValue(rawPos) : null,
    url: isObserved ? lp.url : null,
    serpFeatures: isObserved
      ? entryFeatures.length > 0
        ? entryFeatures
        : item.serpFeaturesList
      : [],
    observedDate: isObserved ? date || targetDate || null : null,
    landingPageDate: isObserved ? lp.date : null,
    providerChange:
      isObserved && typeof entry.change === "number" ? entry.change : null,
  };
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
  if (item.positions) {
    const matched = findPositionEntry(item.positions, targetDate);
    if (matched) {
      return buildObservationFromEntry(
        matched.entry,
        matched.date,
        item,
        targetDate,
      );
    }

    // If positions container exists for other dates but not targetDate, check is still pending
    if (targetDate) {
      return {
        observed: false,
        position: null,
        url: null,
        serpFeatures: [],
        observedDate: null,
        landingPageDate: null,
        providerChange: null,
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
      landingPageDate: null,
      providerChange: null,
    };
  }

  const flatPos = item.position !== undefined ? item.position : item.pos;
  const isFlatAwaitingCrawl =
    (item.depth !== undefined && item.depth !== null && item.depth === 0) ||
    (item.is_checked !== undefined &&
      item.is_checked !== null &&
      item.is_checked === 0);

  const hasFlatObservation =
    !isFlatAwaitingCrawl &&
    flatPos !== null &&
    (flatPos !== undefined ||
      item.landing_page !== undefined ||
      item.url !== undefined ||
      item.date !== undefined);
  const lpCandidate = item.landing_page ?? item.landing_pages ?? item.url;
  const lp = extractLandingPage(lpCandidate, targetDate);

  return {
    observed: hasFlatObservation,
    position: hasFlatObservation ? normalizePosValue(flatPos) : null,
    url: hasFlatObservation ? lp.url : null,
    serpFeatures: hasFlatObservation ? item.serpFeaturesList : [],
    observedDate: hasFlatObservation ? (flatDate ?? targetDate ?? null) : null,
    landingPageDate: hasFlatObservation ? lp.date : null,
    providerChange:
      hasFlatObservation && typeof item.change === "number"
        ? item.change
        : null,
  };
}

function readNumberProp(obj: object, key: string): number | undefined {
  if (!(key in obj)) return undefined;
  const val = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return typeof val === "number" ? val : undefined;
}

function readArrayProp(obj: object, key: string): unknown[] | undefined {
  if (!(key in obj)) return undefined;
  const val = Object.getOwnPropertyDescriptor(obj, key)?.value;
  return Array.isArray(val) ? val : undefined;
}

function appendPositionItems(
  rawItems: unknown[],
  target: SeRankingPositionItem[],
  siteEngineId?: number,
) {
  for (const item of rawItems) {
    const parsed = seRankingPositionItemSchema.safeParse(item);
    if (!parsed.success) continue;
    const data = parsed.data;
    if (siteEngineId && !data.site_engine_id) {
      target.push({ ...data, site_engine_id: siteEngineId });
    } else {
      target.push(data);
    }
  }
}

export function parsePositionsPayload(raw: unknown): SeRankingPositionItem[] {
  const items: SeRankingPositionItem[] = [];
  if (Array.isArray(raw)) {
    for (const entry of raw) {
      if (!entry || typeof entry !== "object") continue;
      const entryEngineId = readNumberProp(entry, "site_engine_id");
      const keywords = readArrayProp(entry, "keywords");
      if (keywords) {
        appendPositionItems(keywords, items, entryEngineId);
      } else {
        appendPositionItems([entry], items, entryEngineId);
      }
    }
    return items;
  }

  if (raw && typeof raw === "object") {
    const rootEngineId = readNumberProp(raw, "site_engine_id");
    const keywords = readArrayProp(raw, "keywords");
    if (keywords) {
      appendPositionItems(keywords, items, rootEngineId);
    }
  }
  return items;
}

export function parseAddedKeywordsPayload(
  res: unknown,
): SeRankingProjectKeyword[] {
  let candidates: unknown[] = [];
  if (Array.isArray(res)) {
    candidates = res;
  } else if (res && typeof res === "object") {
    const obj = res as Record<string, unknown>;
    if (Array.isArray(obj.keywords)) {
      candidates = obj.keywords;
    } else if (Array.isArray(obj.data)) {
      candidates = obj.data;
    } else if (Array.isArray(obj.ids)) {
      candidates = obj.ids.map((id) => ({ id }));
    } else {
      candidates = [res];
    }
  }
  const parsedList: SeRankingProjectKeyword[] = [];
  for (const candidate of candidates) {
    const parsed = seRankingProjectKeywordSchema.safeParse(candidate);
    if (parsed.success) parsedList.push(parsed.data);
  }
  return parsedList;
}
