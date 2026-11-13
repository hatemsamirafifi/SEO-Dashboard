import {
  seRankingProjectKeywordSchema,
  seRankingPositionItemSchema,
  type SeRankingProjectKeyword,
  type SeRankingPositionItem,
} from "./projectSchemas";

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
  const candidates = Array.isArray(res)
    ? res
    : res && typeof res === "object"
      ? [res]
      : [];
  const parsedList: SeRankingProjectKeyword[] = [];
  for (const candidate of candidates) {
    const parsed = seRankingProjectKeywordSchema.safeParse(candidate);
    if (parsed.success) parsedList.push(parsed.data);
  }
  return parsedList;
}
