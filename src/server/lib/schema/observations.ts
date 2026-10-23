/**
 * Reads the observations a proposal may use from one stored audit page.
 *
 * Nothing here fetches, re-parses HTML, or defaults a value: the observation
 * map contains exactly what the crawler persisted (page columns, Salla
 * extraction, existing JSON-LD). Null observations stay absent.
 */
import { isJsonLdNode, jsonLdTypeNames } from "../audit/salla/json-ld";
import { parseSallaExtractionJson } from "../audit/salla/extraction";
import type {
  SallaBlogExtraction,
  SallaCategoryExtraction,
  SallaProductExtraction,
} from "../audit/salla/extraction";
import type { SchemaJson, SchemaPageInput } from "./types";

export interface Observed<T> {
  value: T;
  source: string;
}

/**
 * Narrow a value read out of parsed JSON to the serializable contract.
 * JSON.parse only produces these kinds; anything else is treated as absent.
 */
export function toSchemaJson(value: unknown): SchemaJson {
  if (
    value === null ||
    typeof value === "string" ||
    typeof value === "boolean"
  ) {
    return value;
  }
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (Array.isArray(value)) return value.map(toSchemaJson);
  if (isJsonLdNode(value)) {
    const result: Record<string, SchemaJson> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) result[key] = toSchemaJson(item);
    }
    return result;
  }
  return null;
}

export interface SchemaObservations {
  input: SchemaPageInput;
  pageUrl: string;
  title: Observed<string> | null;
  description: Observed<string> | null;
  image: Observed<string> | null;
  product: SallaProductExtraction | null;
  blog: SallaBlogExtraction | null;
  category: SallaCategoryExtraction | null;
  existing: Array<{ type: string; node: Record<string, unknown> }>;
  notes: string[];
}

function observed(
  value: string | null | undefined,
  source: string,
): Observed<string> | null {
  return value && value.trim() ? { value: value.trim(), source } : null;
}

function allJsonLdNodes(payloadJson: string | null): Array<{
  type: string;
  node: Record<string, unknown>;
}> {
  if (!payloadJson) return [];
  let root: unknown;
  try {
    root = JSON.parse(payloadJson);
  } catch {
    return [];
  }
  const nodes: Array<{ type: string; node: Record<string, unknown> }> = [];
  const visit = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const item of value) visit(item);
      return;
    }
    if (!isJsonLdNode(value)) return;
    for (const type of jsonLdTypeNames(value["@type"])) {
      nodes.push({ type, node: value });
    }
    if (value["@graph"]) visit(value["@graph"]);
  };
  visit(root);
  return nodes;
}

export function readSchemaObservations(
  input: SchemaPageInput,
): SchemaObservations {
  const extraction = parseSallaExtractionJson(input.sallaExtractionJson);
  const product =
    input.pageType === "product" && extraction?.kind === "product"
      ? extraction
      : null;
  const blog =
    input.pageType === "blog" && extraction?.kind === "blog"
      ? extraction
      : null;
  const category =
    input.pageType === "category" && extraction?.kind === "category"
      ? extraction
      : null;

  const firstImage = input.images.find((image) => image.src);
  const image =
    observed(input.ogImage, "page.og_image") ??
    observed(firstImage?.src ?? null, "page.image[0]");

  const notes: string[] = [];
  if (!extraction && input.pageType) {
    notes.push("Salla extraction payload is absent or unreadable");
  }
  const existing = allJsonLdNodes(input.structuredDataJson);
  if (input.structuredDataJson && existing.length === 0) {
    notes.push("Structured-data payload has no readable JSON-LD nodes");
  }

  return {
    input,
    pageUrl: input.canonicalUrl?.trim() || input.url,
    title: observed(input.title, "page.title"),
    description: observed(input.metaDescription, "page.meta_description"),
    image,
    product,
    blog,
    category,
    existing,
    notes,
  };
}

/** Existing nodes of one @type, in payload order. */
export function existingNodesOfType(
  observations: SchemaObservations,
  type: string,
): Array<Record<string, unknown>> {
  return observations.existing
    .filter((entry) => entry.type === type)
    .map((entry) => entry.node);
}

/**
 * Breadcrumb trail evidence: an existing BreadcrumbList node wins over the
 * Salla category path (structured data is the stronger observation).
 */
export function observedBreadcrumbTrail(
  observations: SchemaObservations,
): Observed<Array<{ name: string; item: string | null }>> | null {
  const existing = existingNodesOfType(observations, "BreadcrumbList")[0];
  if (existing) {
    const elements = Array.isArray(existing.itemListElement)
      ? existing.itemListElement
      : [];
    const trail = elements
      .filter(isJsonLdNode)
      .map((element) => {
        const name =
          typeof element.name === "string"
            ? element.name
            : typeof element.item === "string"
              ? element.item
              : null;
        const item =
          typeof element.item === "string"
            ? element.item
            : isJsonLdNode(element.item) &&
                typeof element.item["@id"] === "string"
              ? element.item["@id"]
              : null;
        return name ? { name, item } : null;
      })
      .filter((entry): entry is { name: string; item: string | null } =>
        Boolean(entry),
      );
    if (trail.length > 0) {
      return { value: trail, source: "json-ld.BreadcrumbList" };
    }
  }

  const path = observations.category?.path;
  if (path) {
    return {
      value: path.value.map((name) => ({ name, item: null })),
      source: "extraction.category.path",
    };
  }
  return null;
}
