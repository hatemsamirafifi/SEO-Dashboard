/**
 * Category extraction (Phase 2 R4).
 *
 * Records category name/path from breadcrumb JSON-LD and harvests
 * member-product URLs from listing structured data plus the page's internal
 * links matching the product URL pattern. The association is persisted as
 * crawl evidence on the category row (plan: no separate product database) —
 * URLs found here also reach the frontier via the standard link harvest.
 */
import { normalizeUrl } from "../url-utils";
import { isJsonLdNode, type JsonLdNode } from "./json-ld";
import { matchesProductUrlPattern } from "./page-type-evidence";
import {
  collectJsonLdNodes,
  firstJsonString,
  mergeField,
  type CategoryMemberUrl,
  type Field,
  type SallaCategoryExtraction,
  type SallaExtractionInput,
} from "./extraction";

const MAX_MEMBER_URLS = 50;
const MAX_PATH_ITEMS = 10;

function isSameOrigin(url: string, pageUrl: string): boolean {
  try {
    return new URL(url).origin === new URL(pageUrl).origin;
  } catch {
    return false;
  }
}

function urlFromLdValue(value: unknown): string | null {
  if (typeof value === "string") return value;
  if (!isJsonLdNode(value)) return null;
  const candidate = value.url ?? value["@id"];
  return typeof candidate === "string" ? candidate : null;
}

/** The nested `item` of a list entry, when the entry carries one. */
function itemOf(value: unknown): unknown {
  return isJsonLdNode(value) ? value.item : null;
}

/**
 * The name of a breadcrumb item: the item's own name, or the name of the
 * nested `item` object the entry points at.
 */
function breadcrumbItemName(element: unknown): string | null {
  if (!isJsonLdNode(element)) return null;
  const own = firstJsonString(element.name);
  if (own) return own;
  const itemValue = element.item ?? element;
  if (!isJsonLdNode(itemValue)) return null;
  return firstJsonString(itemValue.name);
}

/** The breadcrumb path items, in document order, capped. */
function breadcrumbNames(node: JsonLdNode): string[] {
  const elements = node.itemListElement;
  if (!Array.isArray(elements)) return [];
  const names: string[] = [];
  for (const element of elements) {
    const name = breadcrumbItemName(element);
    if (!name) continue;
    names.push(name.slice(0, 200));
    if (names.length >= MAX_PATH_ITEMS) break;
  }
  return names;
}

export function extractCategory(
  input: SallaExtractionInput,
): SallaCategoryExtraction {
  const { structuredDataJson, pageUrl } = input;
  const nodes = structuredDataJson
    ? collectJsonLdNodes(structuredDataJson, [
        "ItemList",
        "CollectionPage",
        "BreadcrumbList",
      ])
    : [];

  // --- breadcrumb path + structured member URLs ---
  const breadcrumbNode = nodes.find(
    (node) => node["@type"] === "BreadcrumbList",
  );
  let path: Field<string[]> | null = null;
  let breadcrumbName: string | null = null;
  if (breadcrumbNode) {
    // Conventional order is "Home / ... / Category", so the last named
    // breadcrumb item names the category itself.
    const names = breadcrumbNames(breadcrumbNode);
    if (names.length > 0) {
      path = { value: names, from: "structured-data" };
      breadcrumbName = names[names.length - 1] ?? null;
    }
  }

  const listingName = nodes
    .filter((node) => node["@type"] !== "BreadcrumbList")
    .map((node) => firstJsonString(node.name))
    .find((name): name is string => !!name);

  const structuredName = listingName ?? breadcrumbName;

  const members: CategoryMemberUrl[] = [];
  const seen = new Set<string>();
  const pushMember = (
    url: URL | string,
    from: CategoryMemberUrl["from"],
  ): void => {
    const absolute =
      typeof url === "string" ? normalizeUrl(url, pageUrl) : url.href;
    if (!absolute || seen.has(absolute)) return;
    if (!matchesProductUrlPattern(absolute)) return;
    if (!isSameOrigin(absolute, pageUrl)) return;
    seen.add(absolute);
    members.push({ url: absolute, from });
    if (members.length >= MAX_MEMBER_URLS) return;
  };

  for (const node of nodes) {
    if (node["@type"] !== "ItemList") continue;
    const elements = node.itemListElement;
    if (!Array.isArray(elements)) continue;
    for (const element of elements) {
      if (members.length >= MAX_MEMBER_URLS) break;
      const url = urlFromLdValue(element) ?? urlFromLdValue(itemOf(element));
      if (url) pushMember(url, "structured-data");
    }
    if (members.length >= MAX_MEMBER_URLS) break;
  }

  // R4 html tier: the page's own product-pattern links. The analyzer has
  // already normalized and deduped them.
  for (const link of input.internalLinks) {
    if (members.length >= MAX_MEMBER_URLS) break;
    pushMember(link, "html");
  }

  const firstH1 = input.h1s.find((h1) => h1.trim().length > 0);
  const htmlName: Field<string> | null = firstH1
    ? { value: firstH1.trim().slice(0, 200), from: "html" }
    : null;

  return {
    kind: "category",
    name: mergeField(
      structuredName
        ? { value: structuredName.slice(0, 200), from: "structured-data" }
        : null,
      htmlName,
    ),
    path,
    memberProductUrls: members,
  };
}
